// 用假的 window 載入真正的 analytics.js，驗證埋點行為，並把事件真的送進本機 Worker。
import { readFileSync } from "node:fs";

const SRC_PATH = "E:/program/Inkflow/analytics.js";
const ENDPOINT = "http://127.0.0.1:8787/e";
const raw = readFileSync(SRC_PATH, "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS", m); } else { fail++; console.log("  FAIL", m); } };

// ---- 可控時鐘 ----
let clock = Date.UTC(2026, 6, 21, 4, 0, 0);
class FakeDate extends Date {
  constructor(...a) { super(...(a.length ? a : [clock])); }
  static now() { return clock; }
  getTimezoneOffset() { return -480; }   // 台灣
}

function makeWindow(opts = {}) {
  const store = opts.store || new Map();
  const listeners = {}, docListeners = {};
  const sent = [];       // 攔截到的送出內容
  const timers = [];

  const win = {
    location: { protocol: opts.protocol || "https:", hash: opts.hash || "" },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
    navigator: {
      language: "zh-TW",
      doNotTrack: opts.dnt || null,
      sendBeacon: (url, blob) => { sent.push({ via: "beacon", url, blob }); return true; }
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    document: {
      readyState: "complete",
      visibilityState: "visible",
      referrer: "https://example.com/from",
      addEventListener: (n, f) => { (docListeners[n] = docListeners[n] || []).push(f); }
    },
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    matchMedia: (q) => ({ matches: q.includes("coarse") ? !!opts.mobile : false }),
    crypto: { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2, 10) },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearInterval: () => { timers.length = 0; },
    fetch: (url, init) => { sent.push({ via: "fetch", url, body: init.body }); return Promise.resolve({ ok: true }); }
  };

  const src = raw.replace('var ENDPOINT = "";', `var ENDPOINT = ${JSON.stringify(opts.endpoint ?? ENDPOINT)};`);
  if (!src.includes("var ENDPOINT = ")) throw new Error("找不到 ENDPOINT 那一行，測試需更新");
  new Function("window", "Date", src)(win, FakeDate);

  return {
    win, sent, timers, store,
    api: win.InkflowAnalytics,
    tick: () => timers.forEach((t) => t.fn()),
    fire: (n) => (docListeners[n] || []).forEach((f) => f()),
    fireWin: (n) => (listeners[n] || []).forEach((f) => f()),
    // 取出所有已送出的事件（不管走 beacon 還是 fetch）
    events: () => sent.flatMap((s) => JSON.parse(s.body ?? s.blob.__body).events),
    payloads: () => sent.map((s) => JSON.parse(s.body ?? s.blob.__body))
  };
}
// 讓假的 Blob 保留內容供檢查
globalThis.Blob = class { constructor(parts) { this.__body = parts.join(""); } };

console.log("— 啟用與停用判斷 —");
ok(makeWindow().api.enabled === true, "正常情況（https + 有 endpoint）→ 啟用");
ok(makeWindow({ endpoint: "" }).api.enabled === false, "ENDPOINT 留空 → 停用");
ok(makeWindow({ protocol: "file:" }).api.enabled === false, "file:// 本機開檔 → 停用");
ok(makeWindow({ hash: "#autotest" }).api.enabled === false, "#autotest 測試掛鉤 → 停用");
ok(makeWindow({ hash: "#winshot" }).api.enabled === false, "#winshot 截圖掛鉤 → 停用");
ok(makeWindow({ hash: "#hard" }).api.enabled === true, "#hard 一般難度掛鉤 → 仍啟用");
ok(makeWindow({ dnt: "1" }).api.enabled === false, "瀏覽器 Do Not Track → 停用");

console.log("\n— 匿名 id —");
const shared = new Map();
const w1 = makeWindow({ store: shared });
const w2 = makeWindow({ store: shared });
ok(w1.api.anonId === w2.api.anonId, "同一台裝置第二次造訪沿用同一個匿名 id");
ok(w1.api.sessionId !== w2.api.sessionId, "但 session id 每次不同");
ok(shared.get("inkflow-aid") === w1.api.anonId, "匿名 id 存進 localStorage");

console.log("\n— 事件內容 —");
const a = makeWindow({ mobile: true });
a.tick();                                  // 觸發第一次 flush
let evs = a.events();
const ss = evs.find((e) => e.name === "session_start");
ok(!!ss, "載入即送出 session_start");
ok(ss.props.w === 390 && ss.props.h === 844, "帶入視窗尺寸 390×844");
ok(ss.props.mob === 1, "觸控裝置 mob=1");
ok(ss.props.lang === "zh-TW" && ss.props.tzo === -480, "帶入語系與時區");
ok(ss.props.ref === "https://example.com/from", "帶入來源網址");
ok(!JSON.stringify(ss).includes("Mozilla"), "不含 User-Agent 字串");
const p0 = a.payloads()[0];
ok(p0.aid && p0.sid && Array.isArray(p0.events), "送出格式 = {v,aid,sid,events[]}");

console.log("\n— 停留時間 —");
const b = makeWindow();
clock += 30000; b.tick();
let ping = b.events().find((e) => e.name === "ping");
ok(ping && ping.props.ms === 30000, "可見 30 秒 → ping 30000（實際 " + (ping && ping.props.ms) + "）");

clock += 3 * 60 * 60 * 1000;               // 模擬筆電闔上三小時
b.tick();
const pings = b.events().filter((e) => e.name === "ping");
const last = pings[pings.length - 1];
ok(last.props.ms === 30000,
  "睡眠 3 小時後只算一個心跳 30000，不是 10800000（實際 " + last.props.ms + "）");

console.log("\n— 離開頁面 —");
const c = makeWindow();
let onEndCalled = false;
c.api.onEnd = () => { onEndCalled = true; c.api.track("level_end", { diff: "hard", result: "abandoned", steps: 3, par: 7, ms: 20000, hints: 0 }); };
clock += 20000;
c.win.document.visibilityState = "hidden";
c.fire("visibilitychange");
ok(onEndCalled, "切走分頁 → onEnd 回呼被呼叫（讓遊戲補記 abandoned）");
const cev = c.events();
ok(cev.some((e) => e.name === "level_end" && e.props.result === "abandoned"), "abandoned 事件有被送出");
ok(cev.some((e) => e.name === "session_end" && e.props.ms === 20000), "session_end 帶 20 秒活躍時間");
ok(c.sent.some((s) => s.via === "beacon"), "離開時走 sendBeacon（不會被瀏覽器中斷）");
const before = c.sent.length;
c.fireWin("pagehide");
ok(c.sent.length === before, "緊接著的 pagehide 不重複送一份");
c.win.document.visibilityState = "visible";
c.fire("visibilitychange");
clock += 30000; c.tick();
ok(c.events().filter((e) => e.name === "ping").pop().props.ms === 30000, "切回前景後繼續計時");

console.log("\n— 玩家退出 —");
const d = makeWindow();
d.api.optOut();
const n0 = d.sent.length;
d.api.track("level_end", { diff: "easy", result: "won" });
d.tick();
ok(d.sent.length === n0, "optOut() 之後不再送出任何東西");
ok(d.store.get("inkflow-analytics") === "off", "退出狀態寫進 localStorage");

console.log("\n— 端到端：真的送進本機 Worker —");
const e2e = makeWindow();
e2e.win.fetch = (url, init) => fetch(url, init);       // 換成真的 fetch
e2e.api.track("level_start", { diff: "easy", w: 8, h: 8, colors: 5, par: 9 });
e2e.api.track("level_end", { diff: "easy", result: "won", steps: 7, par: 9, ms: 60000, hints: 0 });
clock += 30000;
e2e.tick();
await new Promise((r) => setTimeout(r, 800));
const st = await (await fetch("http://127.0.0.1:8787/stats?token=local-test-token&days=1")).json();
const easyWon = st.by_difficulty.find((x) => x.diff === "easy" && x.result === "won");
ok(!!easyWon && easyWon.avg_steps === 7, "Worker 收到 analytics.js 送出的 level_end（easy/won/7 步）");
ok(st.funnel.arrived >= 1, "Worker 收到 session_start");

console.log("\n" + pass + " 通過, " + fail + " 失敗");
process.exitCode = fail ? 1 : 0;
