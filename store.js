/* 28 天 Vibe Coding 打卡闯关站 —— 数据层
 *
 * Day 7 步骤②：把「存 / 取数据」收口到这一个文件。
 * 这是 TECH_DESIGN.md 第三章「一条配套的设计约定」的落地：
 *   对外只暴露三个动作 —— 保存记录 / 读取记录 / 列出全部；
 *   内部用哪个抽屉（现在是 IndexedDB）是实现细节。
 * 意义：以后要换存储方式，改动面被限制在本文件内。
 *
 * 一条打卡记录包含什么（数据结构，见 TECH_DESIGN.md 第八章「什么不用改」）：
 *   {
 *     levelId:     1,              // 主键，1–28
 *     completedAt: 1758364800000,  // 完成打卡的时间（设备时间，毫秒时间戳）
 *     text:        '今天…',        // 文字记录（第③步才有值）
 *     shot:        Blob | null     // 截图，原样存不膨胀（第③步才有值）
 *   }
 */
(function () {
  'use strict';

  var DB_NAME = 'vibe-checkin';
  var DB_VERSION = 1;
  var STORE_NAME = 'records';

  var dbPromise = null;

  /* 打开（首次会自动建）数据库。多次调用只真正打开一次。 */
  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('这台设备上的浏览器不支持 IndexedDB'));
        return;
      }

      var req = window.indexedDB.open(DB_NAME, DB_VERSION);

      // 首次打开、或版本号变大时触发，这里负责建「放记录的抽屉」
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'levelId' });
        }
      };

      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });

    return dbPromise;
  }

  /**
   * 跑一次读写事务。
   * @param {string} mode 'readonly' 或 'readwrite'
   * @param {Function} fn 接收 objectStore，返回一个 IDBRequest
   */
  function run(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE_NAME, mode);
        var req;

        try {
          req = fn(t.objectStore(STORE_NAME));
        } catch (e) {
          reject(e);
          return;
        }

        // 等整个事务完成再返回，保证数据真的落盘了
        t.oncomplete = function () { resolve(req ? req.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  /* ── 对外只暴露这三个动作 ───────────────────────────── */

  var Store = {
    /** 保存一条打卡记录。同一关重复保存会覆盖（keyPath 是 levelId）。 */
    saveRecord: function (record) {
      return run('readwrite', function (s) { return s.put(record); });
    },

    /** 读取某一关的记录。没有记录时返回 null。 */
    getRecord: function (levelId) {
      return run('readonly', function (s) { return s.get(levelId); });
    },

    /** 列出全部记录，返回数组（未排序）。 */
    listRecords: function () {
      return run('readonly', function (s) { return s.getAll(); });
    }
  };

  window.Store = Store;
})();
