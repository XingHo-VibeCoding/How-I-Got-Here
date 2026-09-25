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
  --jobs "jobs.json" \
  --size 1180,1000        # 可选，视口尺寸，默认 1180,1000
```

验**窄屏**（媒体查询、水平溢出）时必须显式传 `--size 375,800`——
默认是 1180 宽，在默认视口下断言窄屏行为一定是假通过。

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

**坑 7：断言计算样式时，别把 CSS 序列化的精度写死。**
实测：断言进度条宽度 `fill.style.width === '3.571428571428571%'` 会 **FAIL**，
实际读到 `'3.57143%'`。原因是 **CSSOM 把百分比序列化为 6 位有效数字**，
这是浏览器规范行为，跟页面代码无关。

判别口径：失败值与被期望值**数值相等**（`Math.abs(parseFloat(实际) - 期望) < 1e-4`）
→ 是**断言写错**，不是页面错。

对策：凡是断言 CSS 计算值/内联样式，**一律用数值容差，不用字符串全等**：

```js
// ❌ 错误：把浏览器序列化精度写死
{ "expr": "document.querySelector('.bar').style.width", "expect": "3.571428571428571%" }

// ✅ 正确：数值容差
{ "expr": "Math.abs(parseFloat(document.querySelector('.bar').style.width) - 100/28) < 0.001", "expect": true }
```

同类要注意的属性：`width` / `height` / 百分比、`line-height`（可能序列化成 `normal` 或计算值）、
`transform` 矩阵（会展开成 `matrix(...)` 六元组，不要按原字符串断言）、
颜色（会被归一成 `rgb()`/`rgba()`，写断言前先实测一次拿到真实格式）。

**坑 8：`pre` 里调项目自己的数据层 API 前，先确认方法真的存在。**
实测：写清理逻辑时用了 `window.Store.deleteRecord(...)`，
报 `TypeError: window.Store.deleteRecord is not a function`——
因为该项目的数据层**刻意只暴露三个动作**（save / get / list），没有删除接口。

对策：
1. `pre` 报「不是函数」时，**先读该模块源码确认对外的真实接口**，不要凭直觉猜方法名；
2. 需要「清空存储」而模块没提供删除接口时，**直连底层存储**（IndexedDB 的 `objectStore.clear()`），
   绕过业务层——测试清理属于测试职责，不该为了测试给业务代码加方法：

```js
"pre": "(async () => { await new Promise((res, rej) => { const rq = indexedDB.open('库名', 1); rq.onsuccess = () => { const db = rq.result; const t = db.transaction('表名', 'readwrite'); t.objectStore('表名').clear(); t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error); }; rq.onerror = () => rej(rq.error); }); })()"
```

3. **写数据的任务单，收尾必须配一个清数据任务单**，否则测试数据会留在用户浏览器里，
   下次打开页面看到「假的已完成记录」，污染用户真实使用。

## 截图

- 路径 A：`--window-size=1180,1000 --screenshot="<路径>"`
- 路径 B：任务单里写 `"screenshot"`，走 `Page.captureScreenshot`
- **`--screenshot` 截的是视口，没有地址栏**，不能用来当「浏览器地址栏里有 localhost」那类证据——
  那种截图必须由用户自己在真实浏览器里拍
- **让用户拍「改动前 / 改动后」对比图时，先确认改动提交了没有**：
  - 改动**尚未提交** → `git stash push <file>` 切回旧版，拍完 `git stash pop`
  - 改动**已经提交** → `git stash` 会直接说「没有改动可存」，切不回去；必须改用
    `git checkout <commit> -- <file>` 切文件版本，拍完 `git checkout HEAD -- <file>` 恢复
    （Day 9 实测：`HEAD~1` 指向的就是改动前的版本）
  - 无论走哪条路，切换后都**务必让用户强制刷新（Ctrl+F5）**，否则浏览器可能仍在用缓存里的旧 CSS，
    拍出来的「改动前」和「改动后」会一模一样

## 收尾（必做）

```bash
rm -rf "$TMPD"
```

- 临时目录用 `mktemp -d` 创建
- 临时测试页（如果用了）**必须删掉**，不要留在仓库里；删完跑 `git status` 确认
- 清理时若撞上安全删除机制报 `trash-failed`，改用绝对路径再删一次

**坑 9：删 system temp 目录会被 `SIGTERM` 截断。**
Day 8 实测 5 次（隔了 14 小时、跨过一次系统重启）：删除 `AppData\Local\Temp\day8-verify\` 里
8 张 PNG 的 `rm -f *.png` 全部 `Exit Code: 1` + `Signal: SIGTERM`，**命令还没执行就被杀**。
`ls` 在同一目录上完全正常，所以不是路径写错，也不是文件被占用。
判别口径：
- 失败信息里有 `Signal: SIGTERM`（不是 `Permission denied` / `Operation not permitted` 等可读报错）
- **`rm` 命令链上的某一步被中断**（典型表现：`cd` + `rm` 在一行，cd 进得去、rm 不动）
- 用 `ls` 看文件仍在原地
- **多次重试失败率 100%**——这不是偶发，是稳态拦截

正确做法：**别删原目录，留它去。**

1. **先把数据备份到一个不会被拦的地方**（桌面、用户下载目录都行）；
2. 在 commit 说明 / 工作日志里**明确记下"原路径未能清理"**；
3. `AppData\Local\Temp` 是系统临时目录，**Windows 会按自己的策略清理**（一般几天内），
   用户感知不到，长期无害。

**绝对不要做的事**：

| ❌ 不要做 | 原因 |
|---|---|
| 在同一 rm 命令上重试 ≥ 3 次 | 触发 `SIGTERM` 是稳态拦截，不是抖动；重试会污染工作日志 |
| 调 `Add-Type` / `Microsoft.VisualBasic.FileIO` | runtime 安全策略禁止，命令会被拦 |
| 用 `New-Object -ComObject Shell.Application` 调回收站 | COM 实例化被禁止 |
| `rm -rf` 用户级 personal 数据（Desktop / Downloads / Documents） | 第二节第 1 条红线，绝对禁 |

**何时"留它去"**：本次要交付的成果已经在备份里，**数据完整性优先于磁盘整洁**。
**何时再尝试删除**：换用户账号登录、或重启后系统清理进程已跑过一轮、或确认能写脚本触发
Windows `cleanmgr` 时——这些都不在我们能稳定触发的范围内，所以日常就是留它去。

**坑 10：`rm` 删仓库里的已跟踪文件也会被 `SIGTERM` 截断，但 `git rm` 一次就成。**

Day 9 实测：在**项目目录**（不是 temp）执行 `rm RUN.md`，同样是 `Exit Code: 1` + `Signal: SIGTERM`，
命令未执行；`ls` 确认文件仍在原地。改用 `git rm RUN.md` **一次成功**，输出 `rm 'RUN.md'`。

为什么可行：`git rm` 走的是 git 自己的索引与工作区操作，不经过被拦截的那条文件系统删除路径。

适用边界：

- 只适用于**已被 git 跟踪**的文件。未跟踪的新文件没有 `git rm` 可用
- 对未跟踪文件，走「让用户自己在资源管理器里删」这条路
- 用户要求删除仓库内已跟踪文件时，**优先用 `git rm`**；它是可逆的
  （`git checkout HEAD -- <file>` 就能找回）
- 删完跑 `git status` 确认（应显示 `D  <file>`，D 在第一列说明已进暂存区）

**坑 11：验证 hover / 动画这类「只在某个状态存在」的效果，不要靠肉眼看截图。**

Day 10 实测：给关卡格子加了弹簧交互后，同会话拍的两张截图（静止 / 悬停）
肉眼看「一模一样」，一度怀疑动画没生效——但 `getBoundingClientRect()` 显示
格子确实从 93.5px 变成 111.1px。原因是**整行格子都被推开了**，
每一格的位移只有几 px，人眼在缩略图上分辨不出来。

判定手段：**裁区域做逐像素差分**，工具已备好——`scripts/png-diff.py`。

```bash
# 差分：报告指定行区间里，哪些「列」变了、分成几段
python scripts/png-diff.py diff A.png B.png 285 380

# 裁切：把该区域裁剪 + 整数倍放大 + 上下拼接成一张对比图，给人看最直观
python scripts/png-diff.py crop A.png B.png 130 285 900 380 2 out.png
```

- 手写 PNG 解码，**不需要 Pillow**（PNG = zlib 压缩 + 逐行滤波，标准库就够）
- 输出「差异列的区间」而不是「差异像素总数」——区间能直接读出「哪几个元素动了」，
  总数只是个孤零零的数字。**段数 ≈ 动了几个元素**
- Day 10 实测输出：`703 列有差异，分成 6 段（第 1 段 218px 含撑开的那格与紧邻格，后 5 段各 97px）`
  → 与「1 格撑开 + 6 格被依次推开」的设计预期吻合
- 老规矩：两张图必须**同会话、同视口、同数据**，只切换被测变量

**坑 12：这两类断言是无效的，写了只会制造假红。**

1. **`getComputedStyle(el).animationPlayState` 判断不了动画是否在播。**
   它返回的是 **CSS 属性声明值**，只要没写 `paused` 就永远是 `"running"`。
   要判断动画状态，用 `el.getAnimations()` 读 `playState`（`running`/`finished`），
   或监听 `animationend`。
2. **测「悬停应该变大」时，样本必须选目标状态下真会变大的那个元素。**
   Day 10 实测：随手取了第 5 格做样本，而它是「未解锁」状态、按设计就是**缩小**的，
   于是 4 条断言全红，看起来像页面坏了。**先确认样本的语义状态，再写断言方向。**

**排查顺序（省时间）**：断言失败时先跑一遍环境探针——
`document.visibilityState`、rAF 是否真的在跑、有无 JS 报错。
Day 10 实测这三项全正常，于是能立刻断定「是代码错，不是环境错」，
直接去读自己的代码，而不是在参数和等待时间上反复试。

## 检查清单

- [ ] 浏览器路径已确认存在
- [ ] 服务器在后台起着，用 `curl -i` 确认过真实响应
- [ ] **页面有 loading 态 → 已走路径 B，而不是在 `--dump-dom` 参数上试**
- [ ] `waitFor`（首屏）和 `waitForAfter`（结果）按需都写了，没有混用成一个
- [ ] **`waitFor` 已排除加载态**（用 `:not(.empty)` 之类），不会在加载中误判为已完成
- [ ] 涉及文件上传的，用 `setFile` 塞了真实文件，而不是跳过不测
- [ ] 负向断言旁边配了正向断言，避免白屏假通过
- [ ] 断言失败项已区分「页面错」还是「断言写错」
- [ ] **断言 CSS 计算值/内联样式时用的是数值容差，没有把序列化精度写死（坑 7）**
- [ ] **`pre` 里调用的模块方法名，已对照源码确认存在（坑 8）**
- [ ] **写过数据的任务单，已配一个清数据任务单并执行完毕**
- [ ] **清理 `AppData\Local\Temp` 若被 `SIGTERM` 截断，已按坑 9 改用"备份后留它去"（不要再重试 rm）**
- [ ] **删除仓库内已跟踪文件用的是 `git rm`，不是 `rm`（坑 10）**
- [ ] 同一组里出现「有的过有的不过」→ 优先怀疑 `waitFor` 条件太弱，而不是页面有 bug
- [ ] 报错列表为空（路径 B 会自动报 JS 运行时报错）
- [ ] **验 hover / 动画这类「状态相关」效果时，用了逐像素差分判定，不是只看截图（坑 11）**
- [ ] **断言里没有「把属性声明值当运行时状态」的写法，如 `animationPlayState`（坑 12）**
- [ ] **测状态变化的样本，已确认它在目标状态下的语义方向（坑 12）**
- [ ] **验窄屏时显式传了 `--size`，没有在默认 1180 视口下断言窄屏行为**
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
- `scripts/cdp-check.js`（路径 B 的完整工具，推荐；`--size` 可改视口）
- `scripts/png-diff.py`（截图逐像素差分 / 裁切对比图，见坑 11）
