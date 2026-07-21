/**
 * InkFlow 匿名統計後端（Cloudflare Worker + D1）
 *
 * 路由：
 *   POST /e                    收事件（前端 analytics.js 呼叫，公開）
 *   GET  /stats?token=xxx      統計 JSON（需 ADMIN_TOKEN）
 *   GET  /admin?token=xxx      後台頁面（需 ADMIN_TOKEN）
 *
 * 隱私：不儲存 IP、不儲存 User-Agent 字串。只存 Cloudflare 判斷的國家代碼。
 */

const EVENT_NAMES = new Set([
  "session_start", "start", "level_start", "level_end", "ping", "session_end"
]);
const DIFFS = new Set(["easy", "normal", "hard"]);
const RESULTS = new Set(["won", "lost", "abandoned"]);

const MAX_BODY = 32 * 1024;   // 32KB
const MAX_EVENTS = 50;        // 單次批次上限

// 單筆事件的 ms 上限 10 分鐘。前端心跳是 30 秒一次、單關也不該超過這個數字，
// 放寬到「一場 6 小時」的話，一筆偽造或異常的值就足以毀掉平均停留時間。
const MAX_EVENT_MS = 10 * 60 * 1000;

// ---------- 小工具 ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }
  });
}

/** 夾在合理範圍內的整數；不是數字就回 null（欄位留空而不是塞 0） */
function int(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function str(v, max) {
  return typeof v === "string" && v ? v.slice(0, max) : null;
}

/** 時間安全的字串比對，避免用回應時間猜 token */
function tokenOk(given, expected) {
  if (!expected || !given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function requireAuth(url, request, env) {
  const given = url.searchParams.get("token") || request.headers.get("x-admin-token") || "";
  if (!env.ADMIN_TOKEN) return json({ error: "伺服器尚未設定 ADMIN_TOKEN（見 docs/cloudflare-setup.md）" }, 500);
  if (!tokenOk(given, env.ADMIN_TOKEN)) return json({ error: "token 不正確" }, 401);
  return null;
}

// ---------- 收事件 ----------
async function collect(request, env) {
  const raw = await request.text();
  if (!raw || raw.length > MAX_BODY) return json({ error: "bad body" }, 413);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  const aid = str(body && body.aid, 64);
  const sid = str(body && body.sid, 64);
  const events = body && Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : null;
  if (!aid || !sid || !events || !events.length) return json({ error: "bad payload" }, 400);

  const ts = Date.now();
  const country = (request.cf && request.cf.country) || null;

  const stmt = env.DB.prepare(
    `INSERT INTO events (ts, aid, sid, name, diff, result, steps, par, ms, hints, country, props)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
  );

  const rows = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const name = str(e.name, 32);
    if (!name || !EVENT_NAMES.has(name)) continue;         // 只收白名單事件
    const p = (e.props && typeof e.props === "object") ? e.props : {};

    const diff = DIFFS.has(p.diff) ? p.diff : null;
    const result = RESULTS.has(p.result) ? p.result : null;

    rows.push(stmt.bind(
      ts, aid, sid, name, diff, result,
      int(p.steps, 0, 9999),
      int(p.par, 0, 9999),
      int(p.ms, 0, MAX_EVENT_MS),                          // 夾住離譜／偽造的時間值
      int(p.hints, 0, 9999),
      country,
      JSON.stringify(p).slice(0, 1000)
    ));
  }
  if (!rows.length) return json({ error: "no valid events" }, 400);

  try {
    await env.DB.batch(rows);
  } catch (err) {
    return json({ error: "db", detail: String(err).slice(0, 200) }, 500);
  }
  return new Response(null, { status: 204, headers: CORS });
}

// ---------- 統計 ----------
// 時區：以台灣時間（UTC+8）切日
const TW_DAY = `date(ts/1000, 'unixepoch', '+8 hours')`;

async function stats(url, env) {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 14));
  const since = Date.now() - days * 86400000;

  const q = (sql) => env.DB.prepare(sql).bind(since).all();

  const [daily, dailyMs, byDiff, abandon, funnel, countries, devices, totals] = await Promise.all([
    q(`SELECT ${TW_DAY} AS d, COUNT(DISTINCT sid) AS sessions, COUNT(DISTINCT aid) AS users
        FROM events WHERE ts >= ?1 GROUP BY d ORDER BY d DESC`),
    q(`SELECT ${TW_DAY} AS d, SUM(ms) AS ms
        FROM events WHERE ts >= ?1 AND name IN ('ping','session_end') GROUP BY d`),
    q(`SELECT diff, result, COUNT(*) AS n, AVG(steps) AS avg_steps,
              AVG(ms)/1000.0 AS avg_sec, AVG(hints) AS avg_hints
        FROM events WHERE ts >= ?1 AND name = 'level_end' AND diff IS NOT NULL
        GROUP BY diff, result`),
    q(`SELECT diff, steps, COUNT(*) AS n
        FROM events WHERE ts >= ?1 AND name = 'level_end' AND result = 'abandoned'
        GROUP BY diff, steps ORDER BY diff, steps`),
    q(`SELECT
         COUNT(DISTINCT CASE WHEN name='session_start' THEN sid END) AS arrived,
         COUNT(DISTINCT CASE WHEN name='start'         THEN sid END) AS started,
         COUNT(DISTINCT CASE WHEN name='level_end' AND result='won' THEN sid END) AS won_any
        FROM events WHERE ts >= ?1`),
    q(`SELECT COALESCE(country,'??') AS c, COUNT(DISTINCT sid) AS n
        FROM events WHERE ts >= ?1 AND name='session_start'
        GROUP BY c ORDER BY n DESC LIMIT 12`),
    q(`SELECT CASE json_extract(props,'$.mob') WHEN 1 THEN 'mobile' ELSE 'desktop' END AS kind,
              COUNT(DISTINCT sid) AS n
        FROM events WHERE ts >= ?1 AND name='session_start' GROUP BY kind`),
    q(`SELECT (SELECT COUNT(*) FROM events WHERE ts >= ?1) AS events,
              (SELECT AVG(sec) FROM (
                 SELECT SUM(ms)/1000.0 AS sec FROM events
                 WHERE ts >= ?1 AND name IN ('ping','session_end') GROUP BY sid)) AS avg_session_sec`)
  ]);

  // 每日場次與每日活躍時間合併成同一列
  const msByDay = new Map((dailyMs.results || []).map((r) => [r.d, r.ms || 0]));
  const dailyRows = (daily.results || []).map((r) => ({
    date: r.d,
    sessions: r.sessions,
    users: r.users,
    active_min: Math.round((msByDay.get(r.d) || 0) / 60000),
    avg_min: r.sessions ? Math.round((msByDay.get(r.d) || 0) / r.sessions / 6000) / 10 : 0
  }));

  return json({
    days,
    generated_at: new Date().toISOString(),
    totals: (totals.results && totals.results[0]) || {},
    funnel: (funnel.results && funnel.results[0]) || {},
    daily: dailyRows,
    by_difficulty: byDiff.results || [],
    abandon_steps: abandon.results || [],
    countries: countries.results || [],
    devices: devices.results || []
  });
}

// ---------- 後台頁面 ----------
const ADMIN_HTML = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>InkFlow 後台</title>
<style>
  :root{--ink:#2b2b2b;--paper:#f6f3ea;--line:#d9d2c2;--jade:#5b8a86;--rouge:#a8443a}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--paper);color:var(--ink);
       font:15px/1.6 "Noto Serif TC","PingFang TC","Microsoft JhengHei",serif}
  h1{font-size:22px;margin:0 0 4px;letter-spacing:.1em}
  .sub{color:#8a8577;font-size:13px;margin-bottom:20px}
  .cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:24px}
  .card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 18px;min-width:130px}
  .card b{display:block;font-size:26px;line-height:1.2;color:var(--jade);font-weight:600}
  .card span{font-size:12px;color:#8a8577}
  h2{font-size:15px;margin:22px 0 8px;padding-left:8px;border-left:3px solid var(--jade)}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line);
        border-radius:8px;overflow:hidden;font-size:14px}
  th,td{padding:7px 10px;text-align:right;border-bottom:1px solid #eee9dd}
  th:first-child,td:first-child{text-align:left}
  th{background:#efe9db;font-weight:600;font-size:13px}
  tr:last-child td{border-bottom:0}
  .wrap{overflow-x:auto}
  .err{color:var(--rouge);padding:12px;border:1px solid var(--rouge);border-radius:8px;background:#fff}
  select{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:#fff}
  @media(prefers-color-scheme:dark){
    :root{--ink:#e8e4d9;--paper:#1c1d1f;--line:#3a3b3e}
    .card,table{background:#242528}th{background:#2c2d30}
    th,td{border-bottom-color:#333437}
  }
</style></head><body>
<h1>墨染天青 · 後台</h1>
<div class="sub">匿名統計，不含任何個人資料 ·
  期間 <select id="days">
    <option value="1">今天</option><option value="7">近 7 天</option>
    <option value="14" selected>近 14 天</option><option value="30">近 30 天</option>
    <option value="90">近 90 天</option>
  </select>
</div>
<div id="out">載入中…</div>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var out = document.getElementById("out");
function esc(s){ return String(s == null ? "" : s).replace(/[&<>]/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c]; }); }
function n(v, d){ return v == null ? "—" : (d ? Number(v).toFixed(d) : Math.round(v)); }
function table(cols, rows, cells){
  if (!rows.length) return "<p style='color:#8a8577'>這段期間沒有資料。</p>";
  return "<div class='wrap'><table><tr>" + cols.map(function(c){ return "<th>"+c+"</th>"; }).join("") +
    "</tr>" + rows.map(function(r){
      return "<tr>" + cells(r).map(function(c){ return "<td>"+c+"</td>"; }).join("") + "</tr>";
    }).join("") + "</table></div>";
}
function render(d){
  var f = d.funnel || {}, t = d.totals || {};
  var html = "<div class='cards'>" +
    card(f.arrived, "造訪人次") +
    card(f.started, "真的開始玩") +
    card(f.arrived ? Math.round(f.started / f.arrived * 100) + "%" : "—", "封面轉換率") +
    card(t.avg_session_sec ? (t.avg_session_sec / 60).toFixed(1) + " 分" : "—", "平均停留") +
    card(t.events, "事件筆數") + "</div>";

  html += "<h2>每日</h2>" + table(["日期","造訪","裝置數","活躍分鐘","平均停留(分)"], d.daily,
    function(r){ return [r.date, r.sessions, r.users, r.active_min, r.avg_min]; });

  html += "<h2>各難度結果</h2>" + table(["難度","結果","次數","平均步數","平均秒數","平均提示"], d.by_difficulty,
    function(r){ return [esc(r.diff), esc(r.result), r.n, n(r.avg_steps,1), n(r.avg_sec,0), n(r.avg_hints,1)]; });

  html += "<h2>棄坑時已走幾步</h2>" + table(["難度","步數","人次"], d.abandon_steps,
    function(r){ return [esc(r.diff), r.steps, r.n]; });

  html += "<h2>裝置</h2>" + table(["類型","造訪"], d.devices, function(r){ return [esc(r.kind), r.n]; });
  html += "<h2>國家</h2>" + table(["代碼","造訪"], d.countries, function(r){ return [esc(r.c), r.n]; });
  html += "<p class='sub' style='margin-top:20px'>產生於 " + esc(d.generated_at) + "</p>";
  out.innerHTML = html;
}
function card(v, label){
  return "<div class='card'><b>" + (v == null || v === "" ? "—" : esc(v)) + "</b><span>" + label + "</span></div>";
}
function load(){
  var days = document.getElementById("days").value;
  out.textContent = "載入中…";
  fetch("/stats?days=" + days + "&token=" + encodeURIComponent(token))
    .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||r.status); return j; }); })
    .then(render)
    .catch(function(e){ out.innerHTML = "<div class='err'>載入失敗：" + esc(e.message) + "</div>"; });
}
document.getElementById("days").addEventListener("change", load);
load();
</script></body></html>`;

// ---------- 進入點 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/e" && request.method === "POST") {
      return collect(request, env);
    }

    if (url.pathname === "/stats") {
      const bad = requireAuth(url, request, env);
      if (bad) return bad;
      try { return await stats(url, env); }
      catch (err) { return json({ error: "query", detail: String(err).slice(0, 300) }, 500); }
    }

    if (url.pathname === "/admin" || url.pathname === "/") {
      const bad = requireAuth(url, request, env);
      if (bad) return new Response("需要 ?token=你的ADMIN_TOKEN", { status: 401 });
      return new Response(ADMIN_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
