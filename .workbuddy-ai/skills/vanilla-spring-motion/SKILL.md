---
name: vanilla-spring-motion
description: 用原生 JavaScript + requestAnimationFrame 手写弹簧/果冻动画（零依赖），实现「元素撑开 + 邻居逐格让位」这类有物理质感的交互。当项目不引框架、不引外部库（原生 HTML/CSS/JS 静态站点），却需要按压回弹、果冻、涟漪让位等 spring 动效时使用；也用于排查「内联 transform 不生效」「弹簧收敛后自己弹回去」这两类典型故障。
agent_created: true
---

# 原生 JS 手写弹簧动画

用 `requestAnimationFrame` 逐帧积分一个阻尼弹簧，替代 `motion` / `framer-motion` / React Bits 这类依赖。
产出的动画有真实的过冲与阻尼，而不是 `cubic-bezier` 那种「看起来像」的近似。

## 何时用

- 项目**不引框架、不引外部依赖**，但需要「有物理感」的动效
- 要复刻 React Bits / Framer Motion 风格的交互：按压回弹、果冻撑开、邻居让位、涟漪扩散
- 需要**零外部请求**（离线可用、`file://` 直接打开也要能跑）

**不适用**：项目已经用了 React + motion 等库时，直接用库，不要手写——手写只在「不许加依赖」时才是更优解。

## 一、参数模型

借用 React Bits「Jelly Radio」的参数命名。这套命名把「果冻感」拆成了正交的几项，
比 `duration` + `easing` 可读得多，建议沿用：

| 参数 | 含义 | 起手值 |
|---|---|---|
| `swell` | 目标元素放大比例 | `0.16` |
| `shrink` | 邻居收缩比例 | `0.04` |
| `barge` | 邻居额外让位距离（px） | `5` |
| `stagger` | 每远一格延迟多少毫秒启动 | `22` |
| `jelly` | 先宽后高的比例；`0` = 等比放大 | `0.35` |
| `bounce` | 过冲量；`0` = 到位即停，`0.4` 会明显回响 | `0.25` |
| `stiffness` | 弹簧硬度 | `580` |
| `press` | 按下时额外顶起多少 | `0.05` |
| `weakScale` | 「弱响应」元素带动的涟漪强度系数 | `0.45` |
| `lagMs` | 纵向跟随时滞，用来做「先宽后高」 | `45` |

## 二、弹簧积分

标准阻尼弹簧，逐帧积分（`dt` 单位是秒）：

```js
var k = stiffness;
var c = 2 * (1 - bounce) * Math.sqrt(k);   // 阻尼系数。bounce 就是 1 − 阻尼比
var a = -k * (s.d - target) - c * s.v;
s.v += a * dt;
s.d += s.v * dt;
```

**「先宽后高」**（`jelly`）不是等比放大，而是横向与纵向用不同的值：
横向吃弹簧当前值，纵向吃一份**低通滞后**的值——纵向「慢半拍」，视觉上就是先抻宽再长高。

```js
s.lag += (s.d - s.lag) * (1 - Math.exp(-dt / (lagMs / 1000)));
var sx = 1 + s.d   * (1 + jelly * 0.5);   // 横向：跟得紧
var sy = 1 + s.lag * (1 - jelly * 0.5);   // 纵向：慢半拍
```

**「邻居让位」**不是把邻居也放大，而是：邻居**收缩** + 沿远离方向**平移**，
且按「距离 × `stagger`」错开各自的启动时刻，做出从中心向外扩散的涟漪。
每个元素记一个 `delayUntil` 时间戳，未到点的那些帧把 `target` 当作 0：

```js
var target = now < s.delayUntil ? 0 : s.target;
```

## 三、实现骨架

```js
var SPRING = {
  swell: 0.16, shrink: 0.04, barge: 5, stagger: 22, jelly: 0.35,
  bounce: 0.25, stiffness: 580, press: 0.05, lagMs: 45
};

function createSpring(container, itemSelector) {
  var items = [], springs = [], rows = [], rowOf = [];
  var rafId = 0, lastTs = 0, hoverIdx = -1;

  function measure() {          // 按 offsetTop 分行：列数可能随窗口变，不要写死
    rows = []; rowOf = [];
    var byTop = {};
    items.forEach(function (el, i) {
      var top = Math.round(el.offsetTop);
      if (byTop[top] === undefined) { byTop[top] = rows.length; rows.push([]); }
      rowOf[i] = byTop[top];
      rows[byTop[top]].push(i);
    });
  }

  function apply(i, s) {
    if (s.d === 0 && s.v === 0 && s.lag === 0) {   // 完全静止 → 清掉内联样式，保持 DOM 干净
      if (items[i].style.transform) items[i].style.transform = '';
      return;
    }
    var sx = 1 + s.d   * (1 + SPRING.jelly * 0.5);
    var sy = 1 + s.lag * (1 - SPRING.jelly * 0.5);
    var tx = 0;
    if (s.dir) {                                  // 让位位移
      var prog = Math.min(1, Math.abs(s.d) / SPRING.shrink);
      tx = s.dir * SPRING.barge * prog;
    }
    items[i].style.transform =
      'translateX(' + tx.toFixed(2) + 'px) scale(' + sx.toFixed(4) + ',' + sy.toFixed(4) + ')';
  }

  function integrate(dt, now) {
    var k = SPRING.stiffness;
    var c = 2 * (1 - SPRING.bounce) * Math.sqrt(k);
    var tau = SPRING.lagMs / 1000;
    var moving = false;

    for (var i = 0; i < springs.length; i++) {
      var s = springs[i];
      var target = now < s.delayUntil ? 0 : s.target;   // stagger

      var a = -k * (s.d - target) - c * s.v;
      s.v += a * dt;
      s.d += s.v * dt;
      s.lag += (s.d - s.lag) * (1 - Math.exp(-dt / tau));

      if (now < s.delayUntil ||
          Math.abs(s.d - target) > 0.0004 || Math.abs(s.v) > 0.004) {
        moving = true;
      } else {
        s.d = target; s.v = 0; s.lag = target;   // 停在目标上，不是回到 0（见坑 2）
      }
      apply(i, s);
    }
    return moving;
  }

  function step(ts) {
    rafId = 0;
    var dt = (ts - lastTs) / 1000;
    if (!(dt > 0) || dt > 0.05) dt = 0.016;      // 见坑 3
    lastTs = ts;
    if (integrate(dt, ts)) rafId = requestAnimationFrame(step);
    // 收工帧不要再清 transform（见坑 2）
  }

  function kick() {
    if (rafId) return;
    lastTs = performance.now();
    rafId = requestAnimationFrame(step);
  }

  function setTargets(idx, now) {
    hoverIdx = idx;
    for (var i = 0; i < springs.length; i++) {
      springs[i].target = 0; springs[i].dir = 0; springs[i].delayUntil = 0;
    }
    if (idx < 0 || !springs[idx]) return;

    springs[idx].target = SPRING.swell;          // 目标元素撑开
    var row = rows[rowOf[idx]] || [];
    var pos = row.indexOf(idx);
    row.forEach(function (j, k) {                // 同行邻居让位 + 涟漪
      if (j === idx) return;
      springs[j].target = -SPRING.shrink;
      springs[j].dir = k > pos ? 1 : -1;
      springs[j].delayUntil = now + Math.abs(k - pos) * SPRING.stagger;
    });
  }

  function findIdx(e) {
    if (!e.target || !e.target.closest) return -1;
    var el = e.target.closest(itemSelector);
    return el ? items.indexOf(el) : -1;
  }

  function onOver(e) {
    var idx = findIdx(e);
    if (idx < 0 || idx === hoverIdx) return;
    setTargets(idx, performance.now());
    kick();
  }

  function onOut(e) {                            // 只在真正离开容器时复位
    if (e.relatedTarget && container.contains(e.relatedTarget)) return;
    if (hoverIdx < 0) return;
    setTargets(-1, performance.now());
    kick();
  }

  function onDown(e) {
    var idx = findIdx(e);
    if (idx >= 0 && springs[idx]) { springs[idx].target += SPRING.press; kick(); }
  }

  function attach() {
    items = Array.prototype.slice.call(container.querySelectorAll(itemSelector));
    springs = items.map(function () {
      return { d: 0, v: 0, lag: 0, target: 0, dir: 0, delayUntil: 0 };
    });
    measure();
    container.addEventListener('pointerover', onOver);
    container.addEventListener('pointerout', onOut);
    container.addEventListener('pointerdown', onDown);
  }

  function detach() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    container.removeEventListener('pointerover', onOver);
    container.removeEventListener('pointerout', onOut);
    container.removeEventListener('pointerdown', onDown);
    items.forEach(function (el) { el.style.transform = ''; });
    items = []; springs = []; rows = []; rowOf = []; hoverIdx = -1;
  }

  return { attach: attach, detach: detach, measure: measure,
           reset: function () { setTargets(-1, performance.now()); kick(); } };
}
```

**接入方式**：每次重画页面后调一次 `attach()`；元素被替换掉时先 `detach()`。
判断「容器还在不在」来决定接管或退出，这样同一个模块能服务多个路由，其他页面自动不受影响。

## 四、五个必踩的坑

### 坑 1：CSS 动画的 `transform` 会盖住内联 `transform` ⚠️ 最隐蔽

**CSS 动画声明的优先级高于内联样式。** 如果元素身上有入场/循环动画，而它的关键帧里动的是
`transform`，那么 JS 写进去的内联 `transform` 在动画期间会被**整个盖掉**——
表现是「明明设了 transform，页面上却一动不动」，而且只在动画播放的那段时间里失效，
非常容易被误判成「代码没跑」。

**修法**：把动画里的位移改用**独立的 `translate` 属性**（不是 `transform` 的函数）。

```css
/* ❌ 会和 JS 抢 transform */
@keyframes enter { from { transform: translateY(6px); } to { transform: translateY(0); } }

/* ✅ translate 与 transform 是两个独立属性，各管各的、自动叠加 */
@keyframes enter { from { translate: 0 6px; } to { translate: 0 0; } }
```

### 坑 2：弹簧收敛的那一刻，不要把「已到位」的状态清掉

一个常见的写法是「每帧积分；如果全都静止了，就调用 `resetAll()` 收工」。这是错的：
弹簧**正好停在目标值**（撑开态）时，`moving` 恰好变为 false，`resetAll()` 立刻把刚撑开的结果抹掉。
表现是「动画播完就弹回原样」，或者「等一会儿再去读 `style.transform`，是空字符串」。

**修法**：收敛分支写成「停在目标上」而不是「回到 0」，且收工帧**不要**再清一次。

```js
s.d = target; s.v = 0; s.lag = target;   // ✅
// s.d = 0; s.v = 0; s.lag = 0;          // ❌ 会把撑开态也拉回去
```

### 坑 3：`dt` 要防负值

`requestAnimationFrame` 回调收到的 `ts` 是**帧开始的时刻**，可能早于你在 `kick()` 里调用的
`performance.now()`。于是首帧的 `(ts - lastTs)` 可能是负数，而 `Math.min(0.05, 负数)` 仍是负数
（`Math.min` 不会把它夹到 0），积分方向就反了。

```js
var dt = (ts - lastTs) / 1000;
if (!(dt > 0) || dt > 0.05) dt = 0.016;   // ✅ 一次挡住 NaN / 0 / 负值 / 切标签页后的巨大值
```

### 坑 4：位移只走 `transform`，不碰 `width` / `gap` / `margin`

一旦改了会触发重排的属性，网格会重新排版、相邻元素会跳、行尾元素可能把容器撑出横向滚动条。
只动 `transform` 就完全不重排。

配套检查：**让位位移（`barge`）会不会造成水平溢出**——把容器两侧的 `padding` 当成位移的余量，
只要 `barge ≤ padding` 就不会溢出。改完**必须在窄屏视口下实测一次**
（用 `local-page-verify` 的 `--size 375,800`）。

### 坑 5：必须尊重 `prefers-reduced-motion`

约 35% 的 40 岁以上成人受前庭功能障碍影响。判断放在**模块初始化**处，
为真时**整个模块不启动**（不要只是缩短时长），并把页面交回原有的 CSS 反馈：

```js
if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  return { attach: function () {}, detach: function () {}, measure: function () {} };
}
```

## 五、怎么验证

**不要只看截图。** 弹簧动效的位移常常只有几 px，肉眼看缩略图分辨不出来。用
`local-page-verify` 这套：

1. **几何实测**（最硬的证据）：`el.getBoundingClientRect()` 取悬停前后的 `width`/`height`/`left`，
   断言「变宽了多少」「邻居被推开了多少」。`getComputedStyle(el).transform` 会给出
   `matrix(sx, 0, 0, sy, tx, ty)`，可以直接读出实际缩放比。
2. **逐像素差分**：`scripts/png-diff.py`（手写 PNG 解码，不依赖 Pillow）比对同会话、
   同视口、同数据下的两张截图，输出「哪些列变了、分成几段」。段数 = 动了几个元素。
3. **窄屏溢出扫描**：`--size 375,800` 下断言 `scrollWidth <= clientWidth`。
4. **复位检查**：移开指针后断言内联 `transform` 已被清空（`el.style.transform === ''`），
   确认没有残留状态。

**注意**：写断言时先确认样本在目标状态下的**语义方向**。
例如「未解锁」的元素按设计就是**缩小**的，拿它当「应该变大」的样本会让断言全红，
看起来像页面坏了——其实是断言写错了。
