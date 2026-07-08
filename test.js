/* InkFlow 墨染天青 — 自動化測試（node test.js） */
"use strict";
const Core = require("./game.js");

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}
function section(title) { console.log("\n== " + title + " =="); }

// 便於手寫地圖：'X' 是障礙物，數字是顏色
function G(rows) {
  const h = rows.length, w = rows[0].length;
  const grid = [];
  for (const row of rows) for (const ch of row) grid.push(ch === "X" ? Core.OBSTACLE : parseInt(ch, 10));
  return { grid, w, h };
}

// ---------------------------------------------------------------- floodZone
section("floodZone 泛洪搜尋");
{
  const { grid, w, h } = G(["101", "001", "211"]);
  const zone = Core.floodZone(grid, w, h, 1, 1).sort((a, b) => a - b);
  // (1,1)=0 連通的 0：(1,0),(0,1),(1,1)
  check("同色相連區塊正確", JSON.stringify(zone) === JSON.stringify([1, 3, 4]), JSON.stringify(zone));
}
{
  const { grid, w, h } = G(["0X0", "0X0", "000"]);
  const zone = Core.floodZone(grid, w, h, 0, 0);
  check("障礙物阻擋泛洪（可繞下方連通）", zone.length === 7, "len=" + zone.length);
}
{
  const { grid, w, h } = G(["0X1", "XX1", "111"]);
  const zone = Core.floodZone(grid, w, h, 0, 0);
  check("被障礙完全包圍時只剩自己", zone.length === 1, "len=" + zone.length);
}

// ---------------------------------------------------------------- applyMove
section("applyMove 自由選格染色與吞併");
{
  const { grid, w, h } = G(["101", "001", "211"]);
  const game = Core.createGame({ w, h, grid, targetColor: 2, maxSteps: 5, colors: 3 });
  const r = Core.applyMove(game, 1, 1, 1); // 點 (1,1) 的 0 區塊 → 1
  check("染色格數（被點的 0 區塊 3 格）", r.recolored.length === 3, r.recolored.length);
  check("吞併格數（連鎖吞併 5 格）", r.absorbed.length === 5, r.absorbed.length);
  check("回傳被點格座標", r.cx === 1 && r.cy === 1);
  check("步數 +1", game.steps === 1);
  check("狀態仍在進行中", game.status === "playing", game.status);
  const r2 = Core.applyMove(game, 2, 1, 1);
  check("第二手達成全圖目標色 → 勝利", game.status === "won", game.status);
  check("勝利時結果狀態同步", r2.status === "won");
}
{
  // 自由選格：同一張盤點不同格子染的是不同區塊
  const { grid, w, h } = G(["001", "001", "221"]);
  const gA = Core.createGame({ w, h, grid: grid.slice(), targetColor: 1, maxSteps: 9, colors: 3 });
  const rA = Core.applyMove(gA, 1, 0, 0); // 左上角 0 區塊（4 格）
  check("點 (0,0)：染左上 0 區塊 4 格", rA.recolored.length === 4, rA.recolored.length);
  const gB = Core.createGame({ w, h, grid: grid.slice(), targetColor: 1, maxSteps: 9, colors: 3 });
  const rB = Core.applyMove(gB, 1, 0, 2); // 左下角 2 區塊（2 格）
  check("點 (0,2)：染左下 2 區塊 2 格（同盤不同格＝不同區塊）", rB.recolored.length === 2, rB.recolored.length);
}
{
  const { grid, w, h } = G(["101", "001", "211"]);
  const game = Core.createGame({ w, h, grid, targetColor: 2, maxSteps: 5, colors: 3 });
  const before = game.grid.slice();
  check("越界座標被拒絕", Core.applyMove(game, 1, -1, 0) === null && Core.applyMove(game, 1, 3, 0) === null);
  check("選擇與被點格同色被拒絕", Core.applyMove(game, 0, 1, 1) === null); // (1,1)=0
  check("拒絕時狀態不變", game.steps === 0 && JSON.stringify(game.grid) === JSON.stringify(before));
  check("非法顏色被拒絕", Core.applyMove(game, 7, 1, 1) === null && Core.applyMove(game, -1, 1, 1) === null);
}
{
  // 沒吞併到任何格子仍要扣步數（規格）
  const { grid, w, h } = G(["222", "202", "222"]);
  const game = Core.createGame({ w, h, grid, targetColor: 2, maxSteps: 3, colors: 4 });
  const r = Core.applyMove(game, 3, 1, 1); // 點中心的 0 → 3，周圍沒有 3
  check("無效擴張仍扣步數", game.steps === 1 && r.absorbed.length === 0);
}
{
  const { grid, w, h } = G(["0X0", "X1X", "0X0"]);
  const game = Core.createGame({ w, h, grid, targetColor: 0, maxSteps: 3, colors: 2 });
  check("點到障礙物格被拒絕", Core.applyMove(game, 0, 1, 0) === null); // (1,0)=X
  Core.applyMove(game, 0, 1, 1); // 中心 1 → 0；四角本來就是 0
  check("障礙物不會被染色", game.grid[Core.idx(w, 1, 0)] === Core.OBSTACLE && game.grid[Core.idx(w, 0, 1)] === Core.OBSTACLE);
  check("全圖非障礙格＝目標色即勝（即使被障礙隔成多塊）", game.status === "won", game.status);
}

// ---------------------------------------------------------------- 勝負判定
section("勝負判定");
{
  const { grid, w, h } = G(["01", "01"]);
  const game = Core.createGame({ w, h, grid, targetColor: 1, maxSteps: 1, colors: 2 });
  const r = Core.applyMove(game, 1, 0, 0); // 左欄 0 → 1，吞併右欄 1
  check("最後一步達成 → 勝利優先於步數用盡", r.status === "won", r.status);
}
{
  const { grid, w, h } = G(["012", "012"]);
  const game = Core.createGame({ w, h, grid, targetColor: 2, maxSteps: 1, colors: 3 });
  const r = Core.applyMove(game, 1, 0, 0);
  check("步數用盡未達標 → 失敗", r.status === "lost", r.status);
  check("失敗後不能再操作", Core.applyMove(game, 2, 0, 0) === null);
}

// ---------------------------------------------------------------- 波紋距離
section("波紋動畫距離（自被點格算起，需繞過障礙物）");
{
  const { grid, w, h } = G([
    "00000",
    "0XXX0",
    "00000",
    "00000",
    "00000"
  ]);
  const game = Core.createGame({ w, h, grid, targetColor: 1, maxSteps: 3, colors: 2 });
  const r = Core.applyMove(game, 1, 2, 2); // 點中心
  const cell = r.recolored.find(c => c.x === 2 && c.y === 0);
  check("牆後格子 BFS 距離 = 6（曼哈頓距離只有 2，必須繞行）", cell && cell.d === 6, cell && cell.d);
  check("所有染色格都有有效距離", r.recolored.every(c => c.d >= 0));
  check("被點格距離為 0", r.recolored.find(c => c.x === 2 && c.y === 2).d === 0);
}

// ---------------------------------------------------------------- 求解器
section("求解器（beam；小盤取得最佳解、皆可實際重播）");
{
  const { grid, w } = G(["010"]);
  const sol = Core.solve(grid, w, 1, { target: 0 });
  check("010 目標 0 → 1 步", sol && sol.steps === 1, sol && sol.steps);
  check("解含要點的格子座標", sol && sol.moves[0].x != null && sol.moves[0].y != null);
}
{
  const { grid, w } = G(["01010"]);
  const sol = Core.solve(grid, w, 1, { target: 0 });
  check("01010 目標 0 → 2 步", sol && sol.steps === 2, sol && sol.steps);
}
{
  const { grid, w } = G(["000"]);
  const s1 = Core.solve(grid, w, 1, { target: 1 });
  check("全圖同色但非目標色 → 整體改色 1 步", s1 && s1.steps === 1 && s1.moves[0].color === 1, JSON.stringify(s1));
  const s0 = Core.solve(grid, w, 1, { target: 0 });
  check("全圖已是目標色 → 0 步", s0 && s0.steps === 0);
}
{
  const { grid, w } = G(["01010"]);
  const sol = Core.solve(grid, w, 1, {}); // 未指定 target：染成單一同色
  check("未指定目標色：染成單一同色 → 2 步", sol && sol.steps === 2, sol && sol.steps);
}
{
  // 求解器解必須真的能在遊戲引擎中重現
  const { grid, w, h } = G([
    "0120",
    "1201",
    "2012",
    "0120"
  ]);
  const sol = Core.solve(grid, w, h, { target: 0 });
  check("4x4 有解", sol !== null, "null");
  if (sol) {
    const game = Core.createGame({ w, h, grid: grid.slice(), targetColor: 0, maxSteps: sol.steps, colors: 3 });
    for (const mv of sol.moves) Core.applyMove(game, mv.color, mv.x, mv.y);
    check("重播求解器解 → 剛好在上限步數內獲勝", game.status === "won" && game.steps === sol.steps,
      game.status + " steps=" + game.steps + "/" + sol.steps);
  }
}

// ---------------------------------------------------------------- 產生器
section("關卡產生器（每關都必須可解、par 落在範圍內、無固定起點）");
const PRESETS = Core.PRESETS;
for (const [name, preset] of Object.entries(PRESETS)) {
  const rng = Core.mulberry32(20260708 + name.length);
  let ok = 0, inRange = 0, replayOk = 0, hasSolution = 0, times = [];
  const N = 30;
  for (let t = 0; t < N; t++) {
    const t0 = Date.now();
    const level = Core.generateLevel(Object.assign({}, preset, { rng }));
    times.push(Date.now() - t0);
    if (!level) continue;
    ok++;
    if (level.par >= preset.parMin && level.par <= preset.parMax) inRange++;
    if (level.solution && level.solution.length === level.par) hasSolution++;
    const game = Core.createGame(level);
    for (const mv of level.solution) Core.applyMove(game, mv.color, mv.x, mv.y);
    if (game.status === "won" && game.steps === level.maxSteps) replayOk++;
  }
  const avg = (times.reduce((a, b) => a + b, 0) / N).toFixed(1);
  const max = Math.max(...times);
  check(`[${name}] ${N}/${N} 關全部產生成功`, ok === N, ok + "/" + N);
  check(`[${name}] par 全部落在 ${preset.parMin}-${preset.parMax}`, inRange === N, inRange + "/" + N);
  check(`[${name}] 每關都附長度=par 的官方解`, hasSolution === ok, hasSolution + "/" + ok);
  check(`[${name}] 官方解重播皆獲勝且步數=par`, replayOk === ok, replayOk + "/" + ok);
  check(`[${name}] 平均產生時間 < 200ms（avg=${avg}ms, max=${max}ms）`, parseFloat(avg) < 200);
}

// ---------------------------------------------------------------- 總結
console.log("\n----------------------------------");
console.log(`結果：${passed} 通過, ${failed} 失敗`);
process.exit(failed ? 1 : 0);
