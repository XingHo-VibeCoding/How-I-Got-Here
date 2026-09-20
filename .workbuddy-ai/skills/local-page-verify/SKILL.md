---
name: local-page-verify
description: 用本机真实浏览器（Chrome / Edge）验证本地已启动的网页是否真的渲染正确——取 DOM 做断言、截图、在页面里执行 JS 种测试数据。当需要确认「本地页面能不能打开」「页面是不是空白」「某个状态 / 按钮 / 路由是否正确」「浏览器存储有没有真的落盘」，或者沙箱里 agent-browser 守护进程起不来、jsdom 一加载就被终止时使用。
agent_created: true
---

# 本地页面渲染校验（无头浏览器法）

验证前端改动时，**不要只看语法检查通过就交付**——纯前端页面由 JS 渲染，语法没错也可能因为运行时错误而白屏。
本 skill 给出一条在本机可靠可用的验证路径，并记录了两个已实测踩过的坑。

## 适用场景

- 本地起了静态服务器（如 `python -m http.server`），要确认页面真的渲染出内容
- 要检查某个交互状态：按钮是否置灰、某个路由是否命中、元素数量对不对
- 要验证浏览器存储（IndexedDB / localStorage）是否真的写入并跨页面加载保留
- 要截图留证

## 选哪条路径（先看这一条）

| 页面情况 | 用哪条路 | 原因 |
|---|---|---|
| 同步渲染（渲染不依赖异步 I/O） | **路径 A：`--dump-dom`** | 快、一条命令搞定 |
| **渲染前要先读 IndexedDB / fetch 数据** | **路径 B：CDP** | `--dump-dom` 会拿到「加载中」状态，断言必然失败 |

**判断口径：页面首屏有没有 loading 态？有就必须走路径 B。**

## 为什么不用另外两个方案（本机实测结论）

| 方案 | 结果 | 症状 |
|---|---|---|
| `agent-browser`（Skill） | **不可用** | 守护进程起不来：`Could not configure browser: Failed to connect: 由于目标计算机积极拒绝，无法连接。 (os error 10061)`，命令被 SIGTERM 终止、无输出 |
| `jsdom`（Node 库） | **不可用** | `require('jsdom')` 一执行进程即被终止（SIGTERM、无输出）；安装本身正常 |

两者失败都与代码无关，**不要反复重试**。直接走本机 Chrome / Edge——它是真浏览器引擎，验证强度本来就更高。

## 一、找到浏览器

```bash
for p in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
         "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
         "/c/Program Files/Microsoft/Edge/Application/msedge.exe"; do
  [ -f "$p" ] && echo "FOUND: $p"
done
```

Windows 上 Edge 几乎必然存在。两者命令行参数一致。

## 二、起本地服务器

```bash
cd <项目目录>
python -m http.server 8000 --bind 127.0.0.1
```

用 `run_in_background` 启动，别占用前台。

**⚠️ 坑 6：看到 502 先怀疑「服务器没在跑」，而不是「服务器坏了」。**
本机实测两种情况：
- `curl -s -o /dev/null -w "%{http_code}"` 会**误报 502**，不可用于判断状态码
- 服务器进程真的死掉时（例如后台任务随会话结束被回收），`curl -i` 会返回
  `HTTP/1.1 502 Bad Gateway` + `Connection: close`——注意这个响应**不是 Python 发的**
  （`SimpleHTTP` 只会返回 `HTTP/1.0`），说明是中间有代理在转发、而目标端口已经没人监听

判断口径：
- `curl -s -i <url> | head -20` 看到 `Server: SimpleHTTP/...` → 服务器活着
- 看到 `502 Bad Gateway` → 端口没人监听，**重新起服务**（顺便用 `netstat -ano | grep ':8000'` 确认）
- 长时间任务中途回来，**先确认服务器还在**，再跑断言

## 路径 A：`--dump-dom`（只适合同步渲染的页面）

```bash
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --user-data-dir="$TMPD/profile" \
  --virtual-time-budget=3000 \
  --dump-dom "http://127.0.0.1:8000/#/levels"
```

- `--user-data-dir` **必须给**独立目录，否则会去连正在运行的 Chrome 实例而失败
- 输出的是**执行完 JS 之后**的 DOM，这是它比 WebFetch / curl 强的地方

### ⚠️ 坑 1：`--dump-dom` 不等异步 I/O

页面若「先读 IndexedDB / fetch 再渲染」，dump 出来的永远是 loading 态。
已实测这些参数变体**全都无效**（都只拿到加载中状态）：

- 不给 `--virtual-time-budget`
- `--virtual-time-budget=20000` / `=60000`
- 加 `--run-all-compositor-stages-before-draw`

结论：**这类页面必须走路径 B**，不要在参数上继续试。

### ⚠️ 坑 2：dump 结果里含 `<script>` 源码，会造成断言假阳性

`--dump-dom` 输出的是完整 HTML，**页面里内联 `<script>` 的源码也在里面**。
若断言「输出里出现 `DONE`」，而源码里恰好写了字符串 `'DONE'`，就会假通过。

对策：断言尽量基于**渲染出来的 DOM 结构**（元素数量、class、textContent），
不要基于「某个字符串是否出现过」；或者用路径 B 直接读 DOM 值。

## 路径 B：CDP（推荐，能等异步、能执行任意 JS）

Node 22+ **自带 `WebSocket` 和 `fetch`**，不需要装任何依赖就能驱动 Chrome DevTools 协议。

脚手架：`scripts/cdp-check.js`

```bash
node scripts/cdp-check.js \
  --chrome "C:/Program Files/Google/Chrome/Application/chrome.exe" \
  --port 9333 \
  --profile "C:/Users/xxx/AppData/Local/Temp/profile" \
  --jobs "jobs.json"
```

它做的事：起 Chrome（带 `--remote-debugging-port`）→ 连上页面 → 逐条执行任务单。

任务单（`jobs.json`）每项支持：

```json
{
  "name": "关卡列表页",
  "url": "http://127.0.0.1:8000/#/levels",
  "waitFor": "document.querySelectorAll('#app .cell').length > 0",
  "setFile": { "selector": "#shot-input", "files": ["C:/tmp/a.png"] },
  "pre": "(async () => { await window.Store.saveRecord({...}); })()",
  "reloadAfterPre": true,
  "waitForAfter": "location.hash === '#/levels'",
  "checks": [
    { "name": "格子数 = 28", "expr": "document.querySelectorAll('#app .cell').length", "expect": 28 }
  ],
  "screenshot": "C:/tmp/shot.png"
}
```

执行顺序：**导航 → 等 `waitFor`（首屏）→ 塞文件 → 执行 `pre` →（重载 + 再等首屏）→ 等 `waitForAfter`（结果）→ 断言 → 截图**

要点：

- **两个等待点是有区别的，别只写一个**：
  - `waitFor` = 等首屏渲染完成。**不写它，`setFile` 会因为输入框还没渲染出来而找不到元素**
  - `waitForAfter` = 等交互结果。**不写它，点完提交立刻断言，读到的是还没更新的页面**
- **⚠️ 坑 5（最隐蔽的一个）：`waitFor` 不能把「加载中」那一屏也算作「渲染完成」。**
  实测踩到过：页面先渲染一个「正在读取本机进度…」的占位块，它**和真正的内容共用同一个 class**（如 `panel`）。
  于是 `document.querySelectorAll('#app .panel').length > 0` 在加载态就成立了，
  断言跑在真正渲染之前 —— 表现为**同一组断言里，前一条失败、后几条通过**（因为 CDP 往返耗时里页面恰好渲染完了）。
  这个「有的过有的不过」的诡异现象，就是它的指纹。
  对策：等待条件要**排除加载态**，例如 `'#app .panel:not(.empty)'`，或直接等一个只有渲染完成后才存在的具体元素。
- **`pre` 能在页面上下文里执行任意 JS（支持 Promise）**——种测试数据、调模块 API、点按钮都靠它，
  比「往项目里塞一个临时测试页」干净得多，也不会污染仓库
- **`setFile` 给 `<input type=file>` 塞文件**。浏览器不允许用 JS 设置文件，所以这一步必须走 CDP 的
  `DOM.setFileInputFiles`（脚本已封装）。塞完会触发 `change` 事件，页面的上传逻辑能正常跑起来
- 每次任务都会先导航到 `about:blank` 再进目标地址，保证是**完整重新加载**
  （只改 URL 的 hash 不会触发 load，容易测不到东西）
- 同一 `--profile` 下的多次任务共享浏览器身份，**IndexedDB 会保留**——
  这就是验证「写入 → 持久化 → 重新加载 → 读回 → 渲染」端到端链路的办法
- 脚本会自动收集 `Runtime.exceptionThrown`，最后报告「JS 运行时报错」，白屏类问题靠它定位

## 断言写法（路径 A 用）

```bash
cnt() { grep -o "$1" | wc -l | tr -d ' '; }
t() {   # t "用例名" "实际值" "期望值"
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (实际=[$2] 期望=[$3])"; fi
}
```

**坑 3：同一个词可能合法地出现多次。**
例：断言「第 5 关仍显示标题」用 `grep -c '第 5 关'` 期望 1，实际得到 2——
因为 `<title>第 5 关 · …` 和 `<h1>第 5 关</h1>` 都含它。
断言失败时**先确认是页面错了还是断言写错了**，用 `grep -o '.\{0,40\}关键词.\{0,40\}'` 打出上下文看。

**坑 4：负向断言要加保护。**
断言「按钮置灰数量 = 0」时，页面如果整个白屏，结果也是 0，会假通过。
对策：同时断言一个正向条件（如「元素总数 = 1」）。

## 截图

- 路径 A：`--window-size=1180,1000 --screenshot="<路径>"`
- 路径 B：任务单里写 `"screenshot"`，走 `Page.captureScreenshot`
- **`--screenshot` 截的是视口，没有地址栏**，不能用来当「浏览器地址栏里有 localhost」那类证据——
  那种截图必须由用户自己在真实浏览器里拍

## 收尾（必做）

```bash
rm -rf "$TMPD"
```

- 临时目录用 `mktemp -d` 创建
- 临时测试页（如果用了）**必须删掉**，不要留在仓库里；删完跑 `git status` 确认
- 清理时若撞上安全删除机制报 `trash-failed`，改用绝对路径再删一次

## 检查清单

- [ ] 浏览器路径已确认存在
- [ ] 服务器在后台起着，用 `curl -i` 确认过真实响应
- [ ] **页面有 loading 态 → 已走路径 B，而不是在 `--dump-dom` 参数上试**
- [ ] `waitFor`（首屏）和 `waitForAfter`（结果）按需都写了，没有混用成一个
- [ ] **`waitFor` 已排除加载态**（用 `:not(.empty)` 之类），不会在加载中误判为已完成
- [ ] 涉及文件上传的，用 `setFile` 塞了真实文件，而不是跳过不测
- [ ] 负向断言旁边配了正向断言，避免白屏假通过
- [ ] 断言失败项已区分「页面错」还是「断言写错」
- [ ] 同一组里出现「有的过有的不过」→ 优先怀疑 `waitFor` 条件太弱，而不是页面有 bug
- [ ] 报错列表为空（路径 B 会自动报 JS 运行时报错）
- [ ] 临时测试页、临时目录都已清理，`git status` 干净
- [ ] 报告时明确说清「哪些证据是我验证的、哪些需要用户自己动手」

## 造测试素材

需要测试图片时，不必依赖第三方库——用 Python 的 `zlib` + `struct` 手写 PNG 即可（约 20 行）。
建议造一张**尺寸明显偏大**的图（如 2400×1600），这样才能验证「压缩是否真的生效」
（压缩后应能断言：格式、长边尺寸、体积）。

注意：纯渐变的合成图 JPEG 压缩率极高（可能只有十几 KB），**不要拿它的体积去推断真实截图的体积**
（真实截图约 120–200KB）。断言尺寸和格式更可靠。

参考脚手架：
- `scripts/page-check.sh`（路径 A 的辅助函数，可 source）
- `scripts/cdp-check.js`（路径 B 的完整工具，推荐）
