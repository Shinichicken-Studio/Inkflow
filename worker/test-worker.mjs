// 對本機 wrangler dev 實跑驗證 Worker：收事件 → 查統計 → 權限檢查
const BASE = "http://127.0.0.1:8787";
const TOKEN = "local-test-token";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  PASS", m); } else { fail++; console.log("  FAIL", m); } };

const send = (body) => fetch(BASE + "/e", {
  method: "POST", headers: { "Content-Type": "text/plain" },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

// --- 1. 送一場完整的遊戲（模擬 analytics.js 的實際輸出） ---
const sess = (sid, evts) => ({ v: 3, aid: "aid-tester-1", sid, events: evts });

let r = await send(sess("sid-A", [
  { seq: 1, t: Date.now(), name: "session_start", props: { w: 390, h: 844, dpr: 3, lang: "zh-TW", mob: 1, ref: "", tzo: -480 } },
  { seq: 2, t: Date.now(), name: "start", props: { diff: "normal" } },
  { seq: 3, t: Date.now(), name: "level_start", props: { diff: "normal", w: 10, h: 10, colors: 5, par: 12 } },
  { seq: 4, t: Date.now(), name: "ping", props: { ms: 30000 } },
  { seq: 5, t: Date.now(), name: "level_end", props: { diff: "normal", result: "won", steps: 11, par: 12, ms: 95000, hints: 1 } },
  { seq: 6, t: Date.now(), name: "session_end", props: { ms: 12000, total: 42000 } }
]));
ok(r.status === 204, "POST /e 正常批次 → 204（實際 " + r.status + "）");

// 第二場：桌機、困難、中途棄坑
r = await send(sess("sid-B", [
  { seq: 1, t: Date.now(), name: "session_start", props: { w: 1920, h: 1080, dpr: 1, lang: "zh-TW", mob: 0, ref: "https://t.co/x", tzo: -480 } },
  { seq: 2, t: Date.now(), name: "start", props: { diff: "hard" } },
  { seq: 3, t: Date.now(), name: "level_start", props: { diff: "hard", w: 12, h: 12, colors: 5, par: 7 } },
  { seq: 4, t: Date.now(), name: "level_end", props: { diff: "hard", result: "abandoned", steps: 4, par: 7, ms: 40000, hints: 0 } },
  { seq: 5, t: Date.now(), name: "ping", props: { ms: 45000 } }
]));
ok(r.status === 204, "POST /e 第二場 → 204（實際 " + r.status + "）");

// 只到封面就跑掉（測轉換率分母）
r = await send(sess("sid-C", [
  { seq: 1, t: Date.now(), name: "session_start", props: { w: 375, h: 667, mob: 1, tzo: -480 } }
]));
ok(r.status === 204, "POST /e 只有封面的 session → 204");

// --- 2. 惡意/畸形輸入 ---
ok((await send("這不是json")).status === 400, "亂七八糟的 body → 400");
ok((await send({ v: 3, aid: "x", sid: "y", events: [] })).status === 400, "空事件陣列 → 400");
ok((await send({ v: 3, events: [{ name: "ping" }] })).status === 400, "缺 aid/sid → 400");
ok((await send({ v: 3, aid: "x", sid: "y", events: [{ name: "DROP_TABLE", props: {} }] })).status === 400,
   "不在白名單的事件名 → 400（被過濾光）");
r = await send({ v: 3, aid: "aid-tester-2", sid: "sid-D", events: [{ name: "ping", props: { ms: 999999999999 } }] });
ok(r.status === 204, "離譜的 ms 值 → 仍接受（會被夾到 10 分鐘上限）");

// --- 3. 權限 ---
ok((await fetch(BASE + "/stats")).status === 401, "GET /stats 無 token → 401");
ok((await fetch(BASE + "/stats?token=wrong")).status === 401, "GET /stats 錯 token → 401");
ok((await fetch(BASE + "/admin")).status === 401, "GET /admin 無 token → 401");

const adm = await fetch(BASE + "/admin?token=" + TOKEN);
const admText = await adm.text();
ok(adm.status === 200 && admText.includes("墨染天青"), "GET /admin 正確 token → 200 且含後台標題");

// --- 4. 統計內容 ---
const s = await (await fetch(BASE + "/stats?token=" + TOKEN + "&days=14")).json();
console.log(JSON.stringify(s, null, 1));

ok(s.funnel.arrived === 3, "造訪人次 = 3（實際 " + s.funnel.arrived + "）");
ok(s.funnel.started === 2, "真的開始玩 = 2（實際 " + s.funnel.started + "）");
ok(s.funnel.won_any === 1, "有通關的 session = 1（實際 " + s.funnel.won_any + "）");
// 4 個 sid：A、B、C（只看封面）、D（送離譜 ms 的那個）
ok(s.daily.length === 1 && s.daily[0].sessions === 4, "每日：一天、4 個 session（實際 " + s.daily[0].sessions + "）");
// 有時間資料的只有 A(30+12=42 秒)、B(45 秒)、D(被夾成 600 秒) → 平均 (42+45+600)/3 = 229
ok(Math.abs(s.totals.avg_session_sec - 229) < 1, "平均停留 = 229 秒，證明 D 被夾成 600 秒而非 999999999 秒（實際 " + s.totals.avg_session_sec + "）");
ok(s.daily[0].active_min === 11, "當日活躍分鐘 = 11（687 秒；夾住前會是 11666 分）（實際 " + s.daily[0].active_min + "）");

const won = s.by_difficulty.find(x => x.diff === "normal" && x.result === "won");
ok(won && won.n === 1 && won.avg_steps === 11, "難度統計：normal 通關 1 次、平均 11 步");
const ab = s.abandon_steps.find(x => x.diff === "hard");
ok(ab && ab.steps === 4 && ab.n === 1, "棄坑分佈：hard 在第 4 步棄坑 1 人");
const mob = s.devices.find(x => x.kind === "mobile");
const desk = s.devices.find(x => x.kind === "desktop");
ok(mob && mob.n === 2, "裝置：手機 2（實際 " + (mob && mob.n) + "）");
ok(desk && desk.n === 1, "裝置：桌機 1（實際 " + (desk && desk.n) + "）");

console.log("\n" + pass + " 通過, " + fail + " 失敗");
process.exitCode = fail ? 1 : 0;
