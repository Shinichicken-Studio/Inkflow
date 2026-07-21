/*!
 * InkFlow 匿名遊玩統計（前端埋點）
 *
 * 設計原則：
 * 1. 不收集任何個人資料——沒有 IP、沒有 UA 字串、沒有帳號。只有一個隨機產生的匿名 id。
 * 2. 預設完全關閉：ENDPOINT 留空時整個模組是 no-op，離線遊玩與自動化測試不受任何影響。
 * 3. 絕不影響遊戲：所有動作都包在 try/catch，統計壞掉不能害遊戲壞掉。
 * 4. 停留時間用「可見時間累加」計算，不是用離開時間減進站時間——切分頁、關機、
 *    當掉都不會被算成停留三小時。
 */
(function (global) {
  "use strict";

  // ============================================================
  // 設定：部署好 Cloudflare Worker 後，把它的網址填進 ENDPOINT
  // 例：var ENDPOINT = "https://inkflow-analytics.你的帳號.workers.dev/e";
  // 留空 = 停用（什麼都不送）。設定方式見 docs/cloudflare-setup.md
  // ============================================================
  var ENDPOINT = "https://inkflow-analytics.haibaraai0328.workers.dev/e";

  var VERSION = 3;                  // 事件格式版本；改欄位時 +1，方便日後分辨舊資料
  var FLUSH_INTERVAL_MS = 30000;    // 每 30 秒送出一次佇列（同時當作心跳）
  var MAX_QUEUE = 24;               // 佇列滿了就提前送，避免累積太多一次爆掉
  // 單次累加上限。電腦睡眠、分頁被瀏覽器凍結時 JS 會整段停擺，醒來後 Date.now() 的差值
  // 可能是好幾小時——那段時間玩家並沒有在玩。超過上限就只認一個心跳間隔。
  var MAX_TICK_MS = FLUSH_INTERVAL_MS * 2;

  // ---------- 停用判斷（任一成立就整個關掉） ----------
  var TEST_HASH = /^#(autotest|winshot|loseshot|waveshot|musictest)$/.test(global.location.hash);
  var enabled = true;
  try {
    if (!ENDPOINT) enabled = false;                                  // 沒設定 endpoint
    else if (global.location.protocol === "file:") enabled = false;  // 本機直接開檔
    else if (TEST_HASH) enabled = false;                             // 自動化測試／截圖掛鉤
    else if (global.navigator && global.navigator.doNotTrack === "1") enabled = false; // 尊重 DNT
    else if (global.localStorage.getItem("inkflow-analytics") === "off") enabled = false; // 玩家自行退出
  } catch (e) { enabled = false; }

  // ---------- 匿名識別 ----------
  function uuid() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (e) { }
    return "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  var anonId = "";
  try {
    anonId = global.localStorage.getItem("inkflow-aid") || "";
    if (!anonId) { anonId = uuid(); global.localStorage.setItem("inkflow-aid", anonId); }
  } catch (e) { anonId = uuid(); }   // 無痕模式等情況：這次 session 用完就丟

  var sessionId = uuid();
  var seq = 0;

  // ---------- 活躍時間累加 ----------
  function now() { return Date.now(); }
  function visible() {
    try { return global.document.visibilityState !== "hidden"; } catch (e) { return true; }
  }
  var activeSince = visible() ? now() : 0;  // 0 = 目前不在前景
  var pendingActiveMs = 0;                  // 尚未回報的活躍毫秒數
  var totalActiveMs = 0;                    // 本 session 累計（僅供除錯查看）

  function accumulate() {
    if (!activeSince) return;
    var d = now() - activeSince;
    activeSince = now();
    if (d <= 0) return;                        // 使用者改了系統時間之類的怪狀況
    if (d > MAX_TICK_MS) d = FLUSH_INTERVAL_MS; // 睡眠／凍結：只認一個心跳
    pendingActiveMs += d;
    totalActiveMs += d;
  }

  // ---------- 佇列與送出 ----------
  var queue = [];
  var timer = null;
  var ended = false;   // 已結算過這一段（避免 visibilitychange 與 pagehide 重複送）

  function push(name, props) {
    if (!enabled) return;
    try {
      queue.push({ seq: ++seq, t: now(), name: name, props: props || {} });
      if (queue.length >= MAX_QUEUE) flush(false);
    } catch (e) { }
  }

  function payload(batch) {
    return JSON.stringify({ v: VERSION, aid: anonId, sid: sessionId, events: batch });
  }

  // beacon=true 用於離開頁面：sendBeacon 不會被瀏覽器中斷，但不保證所有瀏覽器都支援
  function flush(beacon) {
    if (!enabled || !queue.length) return;
    var batch = queue;
    queue = [];
    var body = payload(batch);
    try {
      if (beacon && global.navigator && global.navigator.sendBeacon) {
        // 用 text/plain 避免觸發 CORS preflight（Worker 端自行 JSON.parse）
        var ok = global.navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
        if (ok) return;
      }
      global.fetch(ENDPOINT, {
        method: "POST",
        body: body,
        headers: { "Content-Type": "text/plain" },
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      })["catch"](function () { });  // 送不出去就算了，絕不影響遊戲
    } catch (e) { }
  }

  // 定時：累加活躍時間 → 有滿 5 秒就記一筆 ping → 送出佇列
  function tick() {
    accumulate();
    if (pendingActiveMs >= 5000) {
      push("ping", { ms: Math.round(pendingActiveMs) });
      pendingActiveMs = 0;
    }
    flush(false);
  }

  // 結算目前這一段可見時間並立刻送出。回到前景時 ended 會被重設，
  // 手機切走再切回來能繼續記錄（會產生多筆 session_end，後端以 sid 彙總即可）。
  function endSession() {
    if (!enabled || ended) return;
    ended = true;
    // 先讓遊戲補記還沒結束的事（例如把進行中的關卡記成 abandoned），
    // 這樣它推進來的事件才趕得上下面這次送出。
    if (typeof API.onEnd === "function") { try { API.onEnd(); } catch (e) { } }
    accumulate();
    push("session_end", { ms: Math.round(pendingActiveMs), total: Math.round(totalActiveMs) });
    pendingActiveMs = 0;
    activeSince = 0;
    flush(true);
  }

  // ---------- 啟動 ----------
  function start() {
    if (!enabled) return;
    var d = global.document, nav = global.navigator || {};
    var coarse = false;
    try { coarse = global.matchMedia && global.matchMedia("(pointer: coarse)").matches; } catch (e) { }
    push("session_start", {
      w: global.innerWidth || 0,
      h: global.innerHeight || 0,
      dpr: Math.round((global.devicePixelRatio || 1) * 100) / 100,
      lang: (nav.language || "").slice(0, 8),
      mob: coarse ? 1 : 0,                                 // 觸控裝置（不存 UA 字串）
      ref: (d.referrer || "").slice(0, 120),               // 來源網址，截斷避免過長
      tzo: new Date().getTimezoneOffset()
    });

    timer = global.setInterval(tick, FLUSH_INTERVAL_MS);

    d.addEventListener("visibilitychange", function () {
      if (visible()) {
        ended = false;
        activeSince = now();                 // 回到前景：重新開始計時
      } else {
        endSession();                        // 離開前景：結算並用 sendBeacon 送出
      }
    });
    global.addEventListener("pagehide", endSession);
  }

  // ---------- 對外介面 ----------
  var API = {
    get enabled() { return enabled; },
    get anonId() { return anonId; },
    get sessionId() { return sessionId; },
    get activeMs() { return totalActiveMs; },
    track: push,
    flush: function () { flush(false); },

    // 由 index.html 指定：玩家離開頁面前的最後機會，用來補記進行中的關卡。
    onEnd: null,


    // 玩家退出／重新加入統計（可接到設定選單，上架時滿足「可關閉」的要求）
    optOut: function () {
      try { global.localStorage.setItem("inkflow-analytics", "off"); } catch (e) { }
      enabled = false; queue = [];
      if (timer) { global.clearInterval(timer); timer = null; }
    },
    optIn: function () {
      try { global.localStorage.removeItem("inkflow-analytics"); } catch (e) { }
    }
  };

  global.InkflowAnalytics = API;

  if (global.document && global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window);
