/* 28 天 Vibe Coding 打卡闯关站 —— 应用逻辑
 *
 * Day 7 步骤②：进度不再是写死的假数据，改成从 store.js（IndexedDB）真实读取，
 *              「已完成 / 可打卡 / 未解锁」三种状态由读到的记录算出来。
 *
 * 本步骤【故意不做】的事：
 *   - 不接截图上传与文字保存（第③步）
 *   - 不接回看与当天修改（第④步）
 *   - 不含 28 关的真实文案（按 C2-A，后续步骤替换 levels.js）
 */
(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────
     一、常量
     ────────────────────────────────────────────────────── */

  var TOTAL_LEVELS = 28;

  var COURSE_DOC_URL = 'https://ncntd4qb99gs.feishu.cn/docx/S07bdyvfLohL75xFVaBcKTpin1f';

  var WEEKS = [
    { week: 1, label: '第 1 周 · 认识 Vibe Coding，启动自己的 MVP（Day 1–7）' },
    { week: 2, label: '第 2 周 · 前端、交互和 Skill（Day 8–14）' },
    { week: 3, label: '第 3 周 · 后端、真实数据和云端数据库（Day 15–21）' },
    { week: 4, label: '第 4 周 · 测试、部署和线上验收（Day 22–28）' }
  ];

  var STATUS_TEXT = { done: '已完成', current: '可打卡', locked: '未解锁' };

  // 截图压缩参数（TECH_DESIGN.md 第五章第 2 条：长边 1280px、JPEG 质量 0.7）
  // 单张约 120–200KB，28 张约 3.4–5.6MB，远低于 IndexedDB 的容量上限。
  var SHOT_MAX_EDGE = 1280;
  var SHOT_JPEG_QUALITY = 0.7;

  var LEVELS = window.LEVELS || [];

  /* ──────────────────────────────────────────────────────
     二、进度状态（来自本机存储，不再是假数据）
     ────────────────────────────────────────────────────── */

  var progress = {
    loaded: false,   // 是否已经从存储里读过一次
    records: {},     // { 关卡号: 打卡记录 }
    error: null      // 读存储失败时的错误
  };

  /** 从存储读取全部打卡记录，整理成「按关卡号索引」的形式 */
  function loadProgress() {
    if (!window.Store) {
      progress.error = new Error('数据层没有加载（store.js 缺失）');
      progress.loaded = true;
      return Promise.resolve();
    }

    return window.Store.listRecords()
      .then(function (list) {
        var map = {};
        (list || []).forEach(function (r) { map[r.levelId] = r; });
        progress.records = map;
        progress.error = null;
      })
      .catch(function (err) {
        progress.error = err;
      })
      .then(function () {
        progress.loaded = true;
      });
  }

  /* ──────────────────────────────────────────────────────
     三、规则：三种状态怎么算出来
     ────────────────────────────────────────────────────── */

  /** 已经打完的关数（按真实记录数） */
  function completedCount() {
    var n = 0;
    for (var i = 1; i <= TOTAL_LEVELS; i++) {
      if (progress.records[i]) n++;
    }
    return n;
  }

  /** 核心规则：编号最小的未完成关卡。28 关全完成时返回 null。 */
  function earliestIncomplete() {
    for (var i = 1; i <= TOTAL_LEVELS; i++) {
      if (!progress.records[i]) return i;
    }
    return null;
  }

  function statusOf(id) {
    if (progress.records[id]) return 'done';
    if (earliestIncomplete() === id) return 'current';
    return 'locked';
  }

  /* ──────────────────────────────────────────────────────
     四、小工具
     ────────────────────────────────────────────────────── */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function getLevel(id) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].id === id) return LEVELS[i];
    }
    return null;
  }

  /** 把 '#/level/4/checkin' 解析成 { name, id } */
  function parseRoute() {
    var path = (location.hash || '').replace(/^#/, '') || '/levels';
    var parts = path.split('/').filter(Boolean);

    if (parts[0] === 'level' && parts[1]) {
      var id = Number(parts[1]);
      if (!isFinite(id) || Math.floor(id) !== id || id < 1 || id > TOTAL_LEVELS) {
        return { name: 'notfound' };
      }
      if (parts[2] === 'checkin') return { name: 'checkin', id: id };
      return { name: 'detail', id: id };
    }
    return { name: 'levels' };
  }

  /* ──────────────────────────────────────────────────────
     五、通用片段
     ────────────────────────────────────────────────────── */

  function buildBackLink(href, text) {
    var back = el('a', 'back-link', text);
    back.href = href;
    return back;
  }

  function buildBadge(status) {
    return el('span', 'badge badge--' + status, STATUS_TEXT[status]);
  }

  function buildNotice(text) {
    return el('div', 'notice', text);
  }

  /**
   * 把用户选的图片压缩成 Blob，再存进 IndexedDB。
   * 为什么要压：原图动辄几 MB，28 张会把存储顶满；压完单张约 120–200KB。
   * 做法：画到 canvas 上缩到长边 1280，再导成 JPEG（质量 0.7）。
   */
  function compressShot(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) {
        reject(new Error('这不是图片文件，换一张试试'));
        return;
      }

      var objectUrl = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        URL.revokeObjectURL(objectUrl);

        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (!w || !h) {
          reject(new Error('这张图片读不出尺寸，换一张试试'));
          return;
        }

        // 长边不超过 1280；本来就小的图不放大
        var scale = Math.min(1, SHOT_MAX_EDGE / Math.max(w, h));
        var tw = Math.max(1, Math.round(w * scale));
        var th = Math.max(1, Math.round(h * scale));

        var canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;

        var ctx = canvas.getContext('2d');
        // 铺一层白底：带透明通道的图导成 JPEG 后，透明处会变黑
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(img, 0, 0, tw, th);

        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('图片压缩失败，换一张试试'));
        }, 'image/jpeg', SHOT_JPEG_QUALITY);
      };

      img.onerror = function () {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('这个文件读不出图片，换一张试试'));
      };

      img.src = objectUrl;
    });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ──────────────────────────────────────────────────────
     北京时间相关的判断（TECH_DESIGN.md 第五章第 3 条）
     ──────────────────────────────────────────────────────
     做法：把时间戳整体加 8 小时，再读 UTC 的年月日时分，就等于读北京时间，
     不受设备自身时区设置的影响。
     诚实说明：设备时间本身可以被用户改掉，纯前端没有中立时间源，防不住。
     这一点如实记录在产品风险里（PRD R6），不假装能防。
  */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function beijingParts(ms) {
    var d = new Date(ms + 8 * 60 * 60 * 1000);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes()
    };
  }

  /** 北京时间的「日期」，用来判断两个时间是不是同一天 */
  function beijingDateKey(ms) {
    var p = beijingParts(ms);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
  }

  function formatBeijingTime(ms) {
    var p = beijingParts(ms);
    return p.year + '-' + pad2(p.month) + '-' + pad2(p.day) +
      ' ' + pad2(p.hour) + ':' + pad2(p.minute);
  }

  /** 完成当天（北京时间）可以改；跨过当天 24:00 只能看（PRD F7） */
  function canStillEdit(record) {
    if (!record || !record.completedAt) return false;
    return beijingDateKey(record.completedAt) === beijingDateKey(Date.now());
  }

  /* ──────────────────────────────────────────────────────
     图片地址的回收
     ──────────────────────────────────────────────────────
     每次从 Blob 生成预览地址，用完后要主动释放，否则会一直占着内存。
     这里统一登记，在每次重新渲染前一次性回收。
  */

  var activeObjectUrls = [];

  function trackUrl(url) {
    activeObjectUrls.push(url);
    return url;
  }

  function releaseUrls() {
    activeObjectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    activeObjectUrls = [];
  }

  /* ──────────────────────────────────────────────────────
     六、页面①：关卡列表
     ────────────────────────────────────────────────────── */

  function buildProgressBar() {
    var box = el('div', 'progress');
    var done = completedCount();

    var count = el('div', 'progress__count');
    count.appendChild(el('b', null, String(done)));
    count.appendChild(document.createTextNode(' / ' + TOTAL_LEVELS + ' 关已完成'));

    var bar = el('div', 'progress__bar');
    var fill = el('div', 'progress__fill');
    fill.style.width = (done / TOTAL_LEVELS * 100) + '%';
    bar.appendChild(fill);

    box.appendChild(count);
    box.appendChild(bar);
    return box;
  }

  function buildCell(level) {
    var status = statusOf(level.id);

    var cell = el('a', 'cell is-' + status);
    cell.href = '#/level/' + level.id;
    cell.title = level.title;
    cell.appendChild(el('span', 'cell__num', String(level.id)));
    cell.appendChild(el('span', 'cell__tag', STATUS_TEXT[status]));
    return cell;
  }

  function renderLevels() {
    var frag = document.createDocumentFragment();

    frag.appendChild(el('h1', null, '闯关地图'));
    frag.appendChild(el('p', 'muted small', '每天打卡 = 通过当天那一关。任何时刻只有编号最小的未完成关卡可以打卡，补关也按这个顺序。'));

    frag.appendChild(buildNotice('Day 7 · 步骤④：已完成的关卡可以点进去回看当时留下的截图和文字；完成当天还能改，过了当天 24:00（北京时间）就只读。'));

    frag.appendChild(buildProgressBar());

    WEEKS.forEach(function (w) {
      var levels = LEVELS.filter(function (l) { return l.week === w.week; });
      if (!levels.length) return;

      var section = el('section', 'week');
      section.appendChild(el('h2', 'week__label', w.label));

      var grid = el('div', 'level-grid');
      levels.forEach(function (l) { grid.appendChild(buildCell(l)); });
      section.appendChild(grid);
      frag.appendChild(section);
    });

    return frag;
  }

  /* ──────────────────────────────────────────────────────
     七、页面②：关卡详情
     ────────────────────────────────────────────────────── */

  /**
   * 把一条打卡记录画出来（回看用）：完成时间 + 截图 + 文字。
   * 详情页和「跨天只读」的打卡页都用它。
   */
  function buildRecordView(level, record) {
    var box = el('div', 'record');

    box.appendChild(el('p', 'record__meta',
      '完成时间：' + formatBeijingTime(record.completedAt) + '（北京时间）'));

    if (record.shot) {
      var shotWrap = el('div', 'record__block');
      shotWrap.appendChild(el('div', 'record__label', '截图'));
      var img = document.createElement('img');
      img.className = 'record__img';
      img.alt = '第 ' + level.id + ' 关留下的截图';
      img.src = trackUrl(URL.createObjectURL(record.shot));
      shotWrap.appendChild(img);
      box.appendChild(shotWrap);
    }

    if (record.text) {
      var textWrap = el('div', 'record__block');
      textWrap.appendChild(el('div', 'record__label', '文字记录'));
      textWrap.appendChild(el('div', 'record__text', record.text));
      box.appendChild(textWrap);
    }

    return box;
  }

  function renderDetail(id) {
    var level = getLevel(id);
    if (!level) return renderNotFound();

    var status = statusOf(id);
    var record = progress.records[id] || null;
    var frag = document.createDocumentFragment();

    frag.appendChild(buildBackLink('#/levels', '← 回到闯关地图'));

    var panel = el('div', 'panel');

    var head = el('div', 'panel__head');
    head.appendChild(el('h1', null, '第 ' + level.id + ' 关'));
    head.appendChild(buildBadge(status));
    panel.appendChild(head);

    panel.appendChild(el('p', 'muted', level.title));
    panel.appendChild(el('div', 'summary', level.summary));

    var actions = el('div', 'actions');

    if (status === 'done') {
      /* ── 回看（PRD F6）+ 当天可改 / 跨天只读（PRD F7）── */
      panel.appendChild(buildRecordView(level, record));

      if (canStillEdit(record)) {
        var edit = el('a', 'btn', '修改这一关的记录');
        edit.href = '#/level/' + level.id + '/checkin';
        actions.appendChild(edit);
        actions.appendChild(el('span', 'faint small', '完成当天可以修改，过了今天 24:00 就只能看了'));
      } else {
        actions.appendChild(el('span', 'faint small', '已经过了完成当天（北京时间），这一关的记录只能查看，不能再改。'));
      }
    } else if (status === 'current') {
      var start = el('a', 'btn', '开始打卡');
      start.href = '#/level/' + level.id + '/checkin';
      actions.appendChild(start);
      actions.appendChild(el('span', 'faint small', '这是当前可以打卡的那一关'));
    } else {
      var lockedBtn = el('a', 'btn is-disabled', '开始打卡');
      lockedBtn.href = '#/level/' + level.id + '/checkin';
      lockedBtn.setAttribute('aria-disabled', 'true');
      lockedBtn.setAttribute('tabindex', '-1');
      actions.appendChild(lockedBtn);

      var next = earliestIncomplete();
      actions.appendChild(el('span', 'faint small',
        next === null ? '28 关都已经完成了' : '先完成第 ' + next + ' 关，这一关才会解锁'));
    }

    panel.appendChild(actions);
    frag.appendChild(panel);
    return frag;
  }

  /* ──────────────────────────────────────────────────────
     八、页面③：打卡页
     ────────────────────────────────────────────────────── */

  /**
   * 打卡页的表单主体。两种模式共用：
   *   mode = 'create' —— 还没打过卡，从空白开始
   *   mode = 'edit'   —— 已完成且还在完成当天，预填当时留下的内容
   */
  function buildCheckinForm(level, opts) {
    var isEdit = opts.mode === 'edit';
    var record = opts.record || null;

    /* ── 临时状态。故意不写存储：填一半刷新就该清空（PRD F8） ── */
    var state = {
      shotBlob: (isEdit && record) ? (record.shot || null) : null,
      text: (isEdit && record) ? (record.text || '') : '',
      busy: false
    };

    var panel = el('div', 'panel');
    panel.appendChild(el('h1', null, isEdit
      ? '第 ' + level.id + ' 关 · 修改记录'
      : '第 ' + level.id + ' 关 · 打卡'));
    panel.appendChild(el('p', 'muted', level.title));
    panel.appendChild(el('div', 'summary', level.summary));

    // 去看完整任务（PRD F3）
    var docActions = el('div', 'actions');
    var docBtn = el('a', 'btn btn--ghost', '去看完整任务（课程文档）');
    docBtn.href = COURSE_DOC_URL;
    docBtn.target = '_blank';
    docBtn.rel = 'noopener';
    docActions.appendChild(docBtn);
    panel.appendChild(docActions);

    /* ── 截图区 ── */
    var shotField = el('div', 'field');
    shotField.appendChild(el('label', 'field__label', '截图'));

    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.id = 'shot-input';
    fileInput.className = 'file-input';
    shotField.appendChild(fileInput);

    var shotStatus = el('p', 'hint', '选一张图，会自动压缩后存在本机。');
    shotField.appendChild(shotStatus);

    var preview = el('div', 'preview');
    preview.hidden = true;
    shotField.appendChild(preview);

    panel.appendChild(shotField);

    /* ── 文字区 ── */
    var noteField = el('div', 'field');
    noteField.appendChild(el('label', 'field__label', '文字记录'));

    var noteInput = document.createElement('textarea');
    noteInput.id = 'note-input';
    noteInput.className = 'textarea';
    noteInput.rows = 5;
    noteInput.placeholder = '今天做了什么、卡在哪里、怎么解决的…';
    noteInput.value = state.text;   // 修改模式下预填当时写的内容
    noteField.appendChild(noteInput);

    panel.appendChild(noteField);

    /* ── 提交 ── */
    var errorBox = el('div', 'form-error');
    errorBox.hidden = true;
    panel.appendChild(errorBox);

    var actions = el('div', 'actions');
    var submitBtn = el('button', 'btn', isEdit ? '保存修改' : '完成打卡');
    submitBtn.type = 'button';
    submitBtn.id = 'submit-btn';
    submitBtn.disabled = true;
    actions.appendChild(submitBtn);

    var submitHint = el('span', 'faint small', '截图和文字至少留一项');
    actions.appendChild(submitHint);
    panel.appendChild(actions);

    /* ── 交互逻辑（元素建好后才能挂） ── */

    function canSubmit() {
      return state.shotBlob !== null || state.text.trim() !== '';
    }

    function refreshSubmit() {
      submitBtn.disabled = state.busy || !canSubmit();
      if (state.busy) {
        submitHint.textContent = '正在保存…';
      } else if (canSubmit()) {
        submitHint.textContent = '可以提交了';
      } else {
        submitHint.textContent = '截图和文字至少留一项';
      }
    }

    function showError(err) {
      errorBox.textContent = err && err.message ? err.message : String(err);
      errorBox.hidden = false;
    }

    function clearError() {
      errorBox.hidden = true;
      errorBox.textContent = '';
    }

    function setPreview(blob) {
      preview.innerHTML = '';

      if (!blob) {
        preview.hidden = true;
        return;
      }

      var img = document.createElement('img');
      img.className = 'preview__img';
      img.alt = '截图预览';
      img.src = trackUrl(URL.createObjectURL(blob));
      preview.appendChild(img);
      preview.hidden = false;
    }

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      clearError();

      if (!file) {
        state.shotBlob = null;
        setPreview(null);
        shotStatus.textContent = '选一张图，会自动压缩后存在本机。';
        refreshSubmit();
        return;
      }

      state.shotBlob = null;
      setPreview(null);
      shotStatus.textContent = '正在压缩…';
      refreshSubmit();

      compressShot(file).then(function (blob) {
        state.shotBlob = blob;
        setPreview(blob);
        shotStatus.textContent = '已选：' + file.name + '（压缩后 ' + formatSize(blob.size) + '）';
        refreshSubmit();
      }).catch(function (err) {
        state.shotBlob = null;
        setPreview(null);
        shotStatus.textContent = '这张图没用上。';
        showError(err);
        refreshSubmit();
      });
    });

    noteInput.addEventListener('input', function () {
      state.text = noteInput.value;
      clearError();
      refreshSubmit();
    });

    submitBtn.addEventListener('click', function () {
      if (state.busy || !canSubmit()) return;

      state.busy = true;
      refreshSubmit();
      clearError();

      var next = {
        levelId: level.id,
        completedAt: Date.now(),          // 完成（或修改）时间，用设备时间
        text: state.text.trim(),
        shot: state.shotBlob
      };

      window.Store.saveRecord(next)
        .then(function () { return loadProgress(); })   // 重新读一遍，下一关才会解锁
        .then(function () { location.hash = '#/levels'; })
        .catch(function (err) {
          state.busy = false;
          refreshSubmit();
          showError(err);
        });
    });

    // 修改模式：把当时留下的截图先显示出来
    if (state.shotBlob) {
      setPreview(state.shotBlob);
      shotStatus.textContent = '已选：本关原来留下的截图（' + formatSize(state.shotBlob.size) + '）';
    }

    refreshSubmit();
    return panel;
  }

  function renderCheckin(id) {
    var level = getLevel(id);
    if (!level) return renderNotFound();

    var status = statusOf(id);
    var record = progress.records[id] || null;
    var frag = document.createDocumentFragment();

    frag.appendChild(buildBackLink('#/level/' + level.id, '← 回到第 ' + level.id + ' 关'));

    /* 未解锁：拦住 */
    if (status === 'locked') {
      var blocked = el('div', 'panel');
      blocked.appendChild(el('h1', null, '第 ' + level.id + ' 关 · 暂时不能打卡'));

      var nextLevel = earliestIncomplete();
      blocked.appendChild(el('p', 'muted',
        nextLevel === null
          ? '28 关都已经完成了。'
          : '这一关还没解锁，请先完成第 ' + nextLevel + ' 关。'));

      frag.appendChild(blocked);
      return frag;
    }

    /* 已完成但过了完成当天：只能看，不出现编辑入口（PRD 异常路径 4） */
    if (status === 'done' && !canStillEdit(record)) {
      var readonly = el('div', 'panel');
      readonly.appendChild(el('h1', null, '第 ' + level.id + ' 关 · 只能查看'));
      readonly.appendChild(el('p', 'muted', '已经过了完成当天（北京时间），这一关的记录不能再修改。'));
      readonly.appendChild(buildRecordView(level, record));
      frag.appendChild(readonly);
      return frag;
    }

    /* 当前可打卡 → 新建；已完成且当天 → 修改 */
    frag.appendChild(buildCheckinForm(level, {
      mode: status === 'done' ? 'edit' : 'create',
      record: record
    }));

    return frag;
  }

  /* ──────────────────────────────────────────────────────
     九、加载中 / 兜底页
     ────────────────────────────────────────────────────── */

  function renderLoading() {
    var panel = el('div', 'panel empty');
    panel.appendChild(el('h1', null, '正在读取本机进度…'));
    panel.appendChild(el('p', 'muted', '数据只存在这台设备上，不会上传。'));
    return panel;
  }

  function renderStorageError() {
    var frag = document.createDocumentFragment();
    var panel = el('div', 'panel empty');

    panel.appendChild(el('h1', null, '读不到本机进度'));
    panel.appendChild(el('p', 'muted', '原因：' + (progress.error && progress.error.message ? progress.error.message : '未知')));
    panel.appendChild(el('p', 'muted small',
      '最常见的两种情况：① 直接用双击的方式打开 index.html（file:// 方式浏览器会禁掉本地存储）；' +
      '② 用了浏览器的隐私 / 无痕窗口。请改用本地服务器方式打开。'));

    frag.appendChild(panel);
    return frag;
  }

  function renderNotFound() {
    var frag = document.createDocumentFragment();

    frag.appendChild(buildBackLink('#/levels', '← 回到闯关地图'));

    var panel = el('div', 'panel empty');
    panel.appendChild(el('h1', null, '没有这一关'));
    panel.appendChild(el('p', 'muted', '关卡编号是 1 到 ' + TOTAL_LEVELS + '，地址里给的不是这个范围里的编号。'));
    frag.appendChild(panel);

    return frag;
  }

  /* ──────────────────────────────────────────────────────
     十、路由出口
     ────────────────────────────────────────────────────── */

  function buildPage(route) {
    if (!progress.loaded) return renderLoading();
    if (progress.error) return renderStorageError();

    if (route.name === 'detail') return renderDetail(route.id);
    if (route.name === 'checkin') return renderCheckin(route.id);
    if (route.name === 'notfound') return renderNotFound();
    return renderLevels();
  }

  function render() {
    var route = parseRoute();
    var app = document.getElementById('app');
    if (!app) return;

    releaseUrls();   // 先回收上一屏用过的图片地址，再重建
    app.innerHTML = '';
    app.appendChild(buildPage(route));

    document.title = (route.id ? '第 ' + route.id + ' 关 · ' : '') + '28 天 Vibe Coding 打卡闯关站';
    window.scrollTo(0, 0);
  }

  /* ──────────────────────────────────────────────────────
     十一、启动
     ────────────────────────────────────────────────────── */

  function boot() {
    render();                     // 先画「正在读取本机进度…」
    loadProgress().then(render);  // 读完存储再重画一次
  }

  window.addEventListener('hashchange', render);

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
