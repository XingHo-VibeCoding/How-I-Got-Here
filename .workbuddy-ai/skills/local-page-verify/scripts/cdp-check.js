#!/usr/bin/env node
/* 通过 Chrome DevTools 协议（CDP）校验本地页面
 *
 * 为什么需要它：
 *   chrome --dump-dom 会在 load 事件后立刻导出 DOM，**不会等 IndexedDB 这类真实异步 I/O**。
 *   凡是「先读存储再渲染」的页面，dump 出来的都是加载中状态，断言必然失败。
 *   CDP 可以：真正等到条件成立、在页面里执行任意 JS（含种测试数据）、截图。
 *
 * 用法：
 *   node cdp-check.js --chrome <浏览器路径> --port 9333 --profile <临时档案目录> --jobs <jobs.json>
 *
 * jobs.json 是一个数组，每一项：
 *   {
 *     "name": "关卡列表页",
 *     "url": "http://127.0.0.1:8000/#/levels",
 *     "setFile": { "selector": "#shot-input", "files": ["C:/tmp/a.png"] },  // 可选：塞文件给 <input type=file>
 *     "pre": "Store.saveRecord({...})",   // 可选：在页面里先执行（支持 Promise）
 *     "reloadAfterPre": true,             // 可选：pre 跑完后重新加载页面
 *     "waitFor": "document.querySelectorAll('#app .cell').length > 0",       // 可选：等首屏
 *     "waitForAfter": "location.hash === '#/levels'",                          // 可选：等结果
 *     "checks": [
 *       { "name": "关卡格子数 = 28", "expr": "document.querySelectorAll('#app .cell').length", "expect": 28 }
 *     ],
 *     "screenshot": "C:/tmp/shot.png"     // 可选
 *   }
 *
 * 执行顺序：导航 → 等 waitFor（首屏）→ 塞文件 → 执行 pre →（重载 + 再等首屏）
 *          → 等 waitForAfter（结果）→ 跑断言 → 截图
 * 文件输入框必须走 CDP 的 DOM.setFileInputFiles（浏览器不允许用 JS 设置文件）。
 */

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

/* ── 参数解析 ─────────────────────────────────────────── */
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const CHROME = arg('chrome');
const PORT = Number(arg('port', '9333'));
const PROFILE = arg('profile');
const JOBS_FILE = arg('jobs');

if (!CHROME || !PROFILE || !JOBS_FILE) {
  console.error('缺少参数。用法：node cdp-check.js --chrome <路径> --profile <目录> --jobs <jobs.json>');
  process.exit(2);
}

const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0;
let FAIL = 0;
const problems = [];

/* ── 启动 Chrome ──────────────────────────────────────── */
let chromeProc = null;

async function waitForDevTools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (_) { /* 还没起来，继续等 */ }
    await sleep(250);
  }
  throw new Error('Chrome 的调试端口一直没就绪');
}

async function findPageTarget(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) { /* 继续等 */ }
    await sleep(250);
  }
  throw new Error('找不到可用的页面目标');
}

/* ── 极简 CDP 客户端 ──────────────────────────────────── */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('WebSocket 连接失败：' + url));
  });
}

function makeClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const waiters = new Map();
  const listeners = new Map();

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }

    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method) {
      if (waiters.has(msg.method)) {
        const list = waiters.get(msg.method);
        waiters.delete(msg.method);
        list.forEach((fn) => fn(msg.params));
      }
      if (listeners.has(msg.method)) {
        listeners.get(msg.method).forEach((fn) => fn(msg.params));
      }
    }
  };

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('CDP 调用超时：' + method));
        }
      }, 20000);
    });
  }

  function waitEvent(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const list = waiters.get(method) || [];
        waiters.set(method, list.filter((f) => f !== onEvent));
        reject(new Error('等待事件超时：' + method));
      }, timeout);
      function onEvent(params) { clearTimeout(t); resolve(params); }
      if (!waiters.has(method)) waiters.set(method, []);
      waiters.get(method).push(onEvent);
    });
  }

  function on(method, cb) {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(cb);
  }

  return { send, waitEvent, on, close: () => ws.close() };
}

async function evaluate(client, expression, awaitPromise = true) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || '页面里执行出错');
  }
  return res.result ? res.result.value : undefined;
}

async function navigate(client, url) {
  // 先回空白页，确保每次都是完整重新加载（只改 hash 不会触发 load）
  const blank = client.waitEvent('Page.loadEventFired').catch(() => {});
  await client.send('Page.navigate', { url: 'about:blank' });
  await blank;

  const loaded = client.waitEvent('Page.loadEventFired').catch(() => {});
  await client.send('Page.navigate', { url });
  await loaded;
}

async function waitUntil(client, expr, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await evaluate(client, expr, false).catch(() => false);
    if (v) return true;
    await sleep(120);
  }
  return false;
}

/** 给页面里的 <input type="file"> 塞文件。
 *  必须走 CDP，因为浏览器的安全限制不允许用 JS 直接设置文件。 */
async function setFileInput(client, selector, files) {
  const doc = await client.send('DOM.getDocument', { depth: -1 });
  const found = await client.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!found.nodeId) throw new Error('找不到文件输入框：' + selector);
  await client.send('DOM.setFileInputFiles', { files, nodeId: found.nodeId });
}

function check(name, actual, expect) {
  if (actual === expect) {
    console.log('PASS  ' + name);
    PASS++;
  } else {
    console.log('FAIL  ' + name + '  (实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expect) + ')');
    FAIL++;
    problems.push(name);
  }
}

/* ── 主流程 ───────────────────────────────────────────── */
(async () => {
  chromeProc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    '--window-size=1180,1000',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank',
  ], { stdio: 'ignore' });

  const version = await waitForDevTools();
  console.log('浏览器：' + version.Browser);
  console.log('档案目录：' + PROFILE);
  console.log('');

  const target = await findPageTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  const client = makeClient(ws);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');

  // 收集页面里的 JS 运行时报错（白屏往往就是它造成的）
  const jsErrors = [];
  client.on('Runtime.exceptionThrown', (p) => {
    const d = p && p.exceptionDetails;
    jsErrors.push((d && d.exception && d.exception.description) || (d && d.text) || '未知错误');
  });

  for (const job of jobs) {
    console.log('=== ' + job.name + ' ===');

    await navigate(client, job.url);

    // 顺序：等首屏 → 塞文件 → 执行 pre →（可选重载）→ 等结果 → 断言
    // 「等首屏」和「等结果」是两个不同的等待点，缺一不可：
    //   - 不等首屏，setFile 会因为元素还没渲染出来而找不到输入框
    //   - 不等结果，点完提交立刻断言，会读到还没更新的页面
    async function settle() {
      if (job.waitFor) {
        const ok = await waitUntil(client, job.waitFor);
        if (!ok) {
          console.log('FAIL  等待条件未成立：' + job.waitFor);
          FAIL++;
          problems.push(job.name + ' 等待条件超时');
        }
      }
    }

    await settle();

    if (job.setFile) {
      await setFileInput(client, job.setFile.selector, job.setFile.files);
    }

    if (job.pre) {
      await evaluate(client, job.pre);
      if (job.reloadAfterPre) {
        await navigate(client, job.url);
        await settle();
      }
    }

    if (job.waitForAfter) {
      const ok = await waitUntil(client, job.waitForAfter);
      if (!ok) {
        console.log('FAIL  等待条件未成立：' + job.waitForAfter);
        FAIL++;
        problems.push(job.name + ' 等待条件超时（后置）');
      }
    } else if (!job.waitFor) {
      await sleep(600);
    }

    for (const c of job.checks || []) {
      let actual;
      try {
        actual = await evaluate(client, c.expr);
      } catch (e) {
        actual = 'ERR: ' + e.message;
      }
      check(c.name, actual, c.expect);
    }

    if (job.screenshot) {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(job.screenshot, Buffer.from(shot.data, 'base64'));
      console.log('      截图已保存：' + job.screenshot);
    }

    console.log('');
  }

  console.log('----------------------------------------');
  console.log('通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项');
  if (problems.length) console.log('失败项：\n  - ' + problems.join('\n  - '));
  console.log('JS 运行时报错：' + (jsErrors.length ? '\n  - ' + jsErrors.join('\n  - ') : '无'));
  console.log('----------------------------------------');

  client.close();
  chromeProc.kill();
  process.exit(FAIL === 0 && jsErrors.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('校验工具自身出错：' + (e && e.message ? e.message : e));
  if (chromeProc) chromeProc.kill();
  process.exit(2);
});
