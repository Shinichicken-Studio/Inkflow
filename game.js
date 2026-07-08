/*
 * InkFlow 墨染天青 — 核心遊戲邏輯
 * UMD：瀏覽器掛在 window.InkflowCore，Node 走 module.exports（供自動化測試）。
 * 格子顏色以 0..k-1 的整數表示，-1 代表障礙物。
 *
 * 玩法（自由染色版）：沒有固定起點。每一步先選一個新顏色，再點畫布上任一格；
 * 被點格所屬的同色連通區塊整塊變成新色，並向外連鎖吞併相鄰的同新色格子。
 * 目標＝在步數上限內把所有非障礙格都染成目標色。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.InkflowCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var OBSTACLE = -1;
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function idx(w, x, y) { return y * w + x; }

  /** 可播種的偽隨機數產生器（測試需要可重現的關卡） */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 從 (sx,sy) BFS 找出同色相連區塊，回傳格子索引陣列 */
  function floodZone(grid, w, h, sx, sy) {
    var start = idx(w, sx, sy);
    var color = grid[start];
    if (color === OBSTACLE) return [];
    var visited = new Uint8Array(w * h);
    visited[start] = 1;
    var queue = [start];
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi], cx = cur % w, cy = (cur / w) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = idx(w, nx, ny);
        if (visited[ni] || grid[ni] !== color) continue;
        visited[ni] = 1;
        queue.push(ni);
      }
    }
    return queue;
  }

  /** (sx,sy) 可達的非障礙格數（工具函式；自由染色玩法已不再需要地圖連通） */
  function reachableNormals(grid, w, h, sx, sy) {
    var start = idx(w, sx, sy);
    if (grid[start] === OBSTACLE) return 0;
    var visited = new Uint8Array(w * h);
    visited[start] = 1;
    var queue = [start];
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi], cx = cur % w, cy = (cur / w) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = idx(w, nx, ny);
        if (visited[ni] || grid[ni] === OBSTACLE) continue;
        visited[ni] = 1;
        queue.push(ni);
      }
    }
    return queue.length;
  }

  function createGame(level) {
    return {
      w: level.w, h: level.h,
      grid: level.grid.slice(),
      targetColor: level.targetColor,
      maxSteps: level.maxSteps,
      colors: level.colors,
      steps: 0,
      status: "playing" // playing | won | lost
    };
  }

  function isWin(state) {
    for (var i = 0; i < state.grid.length; i++) {
      if (state.grid[i] !== OBSTACLE && state.grid[i] !== state.targetColor) return false;
    }
    return true;
  }

  /**
   * 玩家「選新顏色 + 點某一格 (cx,cy)」時的核心流程：
   * 1. 合法性檢查（遊戲進行中、顏色合法、點到的是非障礙格、且不是原色）
   * 2. 泛洪找出被點格的同色區塊 → 全部改成新顏色
   * 3. 由該區塊邊緣向外吞併所有相鄰的同新色格子（連鎖）
   * 4. 步數 +1，判定勝負（勝利優先於步數用盡）
   * 回傳動畫所需資料（波紋距離自被點格算起）；非法操作回傳 null 且不改動任何狀態。
   */
  function applyMove(state, newColor, cx, cy) {
    if (state.status !== "playing") return null;
    if (newColor == null || newColor < 0 || newColor >= state.colors) return null;
    var w = state.w, h = state.h, g = state.grid;
    if (cx == null || cy == null || cx < 0 || cy < 0 || cx >= w || cy >= h) return null;
    var startIdx = idx(w, cx, cy);
    var oldColor = g[startIdx];
    if (oldColor === OBSTACLE) return null;
    if (newColor === oldColor) return null;

    // Step 2: 被點格的同色區塊
    var zone = floodZone(g, w, h, cx, cy);
    var inZone = new Uint8Array(w * h);
    for (var z = 0; z < zone.length; z++) inZone[zone[z]] = 1;

    // Step 3a: 染色
    for (z = 0; z < zone.length; z++) g[zone[z]] = newColor;

    // Step 3b: 向外吞併同新色格子（BFS 連鎖）
    var queue = zone.slice();
    var absorbed = [];
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi], ccx = cur % w, ccy = (cur / w) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = ccx + DIRS[d][0], ny = ccy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = idx(w, nx, ny);
        if (inZone[ni] || g[ni] !== newColor) continue;
        inZone[ni] = 1;
        queue.push(ni);
        absorbed.push(ni);
      }
    }

    // 波紋動畫用：自被點格沿「最終區塊」的 BFS 距離（自然繞過障礙物）
    var dist = new Int16Array(w * h).fill(-1);
    dist[startIdx] = 0;
    var dq = [startIdx];
    for (qi = 0; qi < dq.length; qi++) {
      cur = dq[qi]; var dcx = cur % w, dcy = (cur / w) | 0;
      for (d = 0; d < 4; d++) {
        nx = dcx + DIRS[d][0]; ny = dcy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        ni = idx(w, nx, ny);
        if (!inZone[ni] || dist[ni] >= 0) continue;
        dist[ni] = dist[cur] + 1;
        dq.push(ni);
      }
    }

    // Step 4: 更新與判定
    state.steps++;
    if (isWin(state)) state.status = "won";
    else if (state.steps >= state.maxSteps) state.status = "lost";

    var maxD = 0;
    var recolored = zone.map(function (i) {
      if (dist[i] > maxD) maxD = dist[i];
      return { i: i, x: i % w, y: (i / w) | 0, d: dist[i] };
    });
    var absorbedOut = absorbed.map(function (i) {
      if (dist[i] > maxD) maxD = dist[i];
      return { i: i, x: i % w, y: (i / w) | 0, d: dist[i] };
    });
    return {
      oldColor: oldColor,
      newColor: newColor,
      cx: cx, cy: cy,
      recolored: recolored,
      absorbed: absorbedOut,
      zoneSize: zone.length + absorbed.length,
      maxD: maxD,
      steps: state.steps,
      status: state.status
    };
  }

  /** 把地圖切成同色相連區域，並建立區域相鄰圖（求解器用） */
  function buildRegions(grid, w, h) {
    var regionId = new Int16Array(w * h).fill(-1);
    var regions = [];
    for (var i = 0; i < w * h; i++) {
      if (grid[i] === OBSTACLE || regionId[i] >= 0) continue;
      var id = regions.length;
      var color = grid[i];
      regionId[i] = id;
      var queue = [i];
      for (var qi = 0; qi < queue.length; qi++) {
        var cur = queue[qi], cx = cur % w, cy = (cur / w) | 0;
        for (var d = 0; d < 4; d++) {
          var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = idx(w, nx, ny);
          if (regionId[ni] >= 0 || grid[ni] !== color) continue;
          regionId[ni] = id;
          queue.push(ni);
        }
      }
      regions.push({ id: id, color: color, size: queue.length, cell: i });
    }
    var adj = regions.map(function () { return new Set(); });
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var a = regionId[idx(w, x, y)];
        if (a < 0) continue;
        if (x + 1 < w) {
          var b = regionId[idx(w, x + 1, y)];
          if (b >= 0 && b !== a) { adj[a].add(b); adj[b].add(a); }
        }
        if (y + 1 < h) {
          var c = regionId[idx(w, x, y + 1)];
          if (c >= 0 && c !== a) { adj[a].add(c); adj[c].add(a); }
        }
      }
    }
    return { regionId: regionId, regions: regions, adj: adj };
  }

  /**
   * 自由染色版求解器（beam search）：先把盤面壓成「區域圖」（同色相連塊為節點、
   * 異色相鄰為邊），之後在這張小圖上做定寬束搜尋，找一條把整盤染成目標色
   * （opts.target；未指定時求「染成單一同色」）的短路徑。狀態＝各初始區域當前顏色
   * 的陣列；一步＝挑一個「當前同色連通塊」整塊改成某色（＝遊戲裡點一格的效果）。
   *
   * 為什麼用 beam 而非窮舉最佳解：自由染色的最少步數在數學上是 NP-hard，12×12／5 色
   * 的嚴格最佳解證明會爆炸（實測數秒起跳）。beam 永遠回傳一條「可實際重播獲勝」的解，
   * 執行時間有界，且盤面小時仍會找到真正的最佳解；代價是大盤上步數可能比理論最佳多 1–2 步
   * （對玩家而言只是多一點餘裕，仍是緊湊謎題）。
   *
   * 剪枝：每步只把某連通塊改成「它相鄰塊的顏色」或「目標色」；相同盤面著色只展開一次；
   * 每層依啟發分數（尚未達標的顏色種數 → 尚未達標的格子數）只保留最好的 width 個狀態。
   *
   * 回傳 { steps, moves }，moves 為 [{ color, x, y }]（x,y＝該步要點的代表格）；
   * 在 cap 層內找不到解回傳 null（產生器用來汰除過難的盤）。
   */
  function solve(grid, w, h, opts) {
    opts = opts || {};
    var target = opts.target != null ? opts.target : null;
    var cap = opts.cap || 30;
    var width = opts.width || 400;

    var R = buildRegions(grid, w, h);
    var n = R.regions.length;
    if (n === 0) return { steps: 0, moves: [] };
    var rCell = R.regions.map(function (r) { return r.cell; });
    var rSize = R.regions.map(function (r) { return r.size; });
    var radj = R.adj.map(function (s) { return Array.from(s); });

    function goal(cols) {
      if (target != null) {
        for (var i = 0; i < n; i++) if (cols[i] !== target) return false;
        return true;
      }
      var c = cols[0];
      for (var j = 1; j < n; j++) if (cols[j] !== c) return false;
      return true;
    }
    // 啟發分數（越小越好）：先比尚未達標的顏色種數，再比尚未達標的格子總數
    function score(cols) {
      var set = {}, cells = 0;
      for (var i = 0; i < n; i++) {
        var v = cols[i];
        if (target != null) { if (v !== target) { set[v] = 1; cells += rSize[i]; } }
        else set[v] = 1;
      }
      var k = Object.keys(set).length;
      return target != null ? (k * 100000 + cells) : ((k - 1) * 100000);
    }

    var start = R.regions.map(function (r) { return r.color; });
    if (goal(start)) return { steps: 0, moves: [] };

    var seen = new Set();
    seen.add(start.join(","));
    var beam = [{ cols: start, moves: [] }];

    for (var depth = 1; depth <= cap && beam.length; depth++) {
      var cand = [];
      for (var bi = 0; bi < beam.length; bi++) {
        var cols = beam[bi].cols, prevMoves = beam[bi].moves;
        var comp = new Int32Array(n).fill(-1); // 當前同色連通塊分群
        for (var i = 0; i < n; i++) {
          if (comp[i] >= 0) continue;
          comp[i] = i;
          var stack = [i], members = [i];
          while (stack.length) {
            var u = stack.pop(), au = radj[u];
            for (var a = 0; a < au.length; a++) {
              var v = au[a];
              if (comp[v] < 0 && cols[v] === cols[u]) { comp[v] = i; stack.push(v); members.push(v); }
            }
          }
          var col = cols[i];
          var cset = {};
          if (target != null && target !== col) cset[target] = 1;
          for (var m = 0; m < members.length; m++) {
            var amm = radj[members[m]];
            for (var b = 0; b < amm.length; b++) if (cols[amm[b]] !== col) cset[cols[amm[b]]] = 1;
          }
          for (var cKey in cset) {
            var c = +cKey;
            var ncols = cols.slice();
            for (m = 0; m < members.length; m++) ncols[members[m]] = c;
            var key = ncols.join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            var move = { color: c, x: rCell[i] % w, y: (rCell[i] / w) | 0 };
            if (goal(ncols)) return { steps: depth, moves: prevMoves.concat([move]) };
            cand.push({ cols: ncols, moves: prevMoves.concat([move]), s: score(ncols) });
          }
        }
      }
      cand.sort(function (a, b) { return a.s - b.s; });
      if (cand.length > width) cand.length = width;
      beam = cand;
    }
    return null;
  }

  /**
   * 關卡產生器：隨機放障礙物 → 種子擴散長出大片色塊 → 選一個目標色，
   * 用求解器求出最佳步數，落在 [parMin, parMax] 才採用。
   * 自由染色玩法下任何盤面都必然可解（最壞情況逐塊染成目標色），
   * 因此不再需要「起點連通」檢查；步數上限＝求解器算出的最佳步數（緊湊 par）。
   */
  function generateLevel(opts) {
    var w = opts.w, h = opts.h, colors = opts.colors;
    var rng = opts.rng || Math.random;
    var attempts = opts.attempts || 60;
    var obstacleMin = opts.obstacleMin || 0;
    var obstacleMax = opts.obstacleMax != null ? opts.obstacleMax : obstacleMin;
    var parMin = opts.parMin || 3, parMax = opts.parMax || 10;
    var blobSize = opts.blobSize || 6;
    var width = opts.width || 200; // beam 寬度：實測對三種難度都能兼顧速度與 par 分佈
    var solveCap = opts.solveCap || parMax; // 只收 par ≤ parMax 的盤
    var targetTries = opts.targetTries || 3;
    var fallback = null;
    var parMid = (parMin + parMax) / 2;

    for (var attempt = 0; attempt < attempts; attempt++) {
      var grid = new Array(w * h).fill(-2); // -2 = 尚未指定顏色

      // 障礙物
      var obsCount = obstacleMin + ((rng() * (obstacleMax - obstacleMin + 1)) | 0);
      var placed = 0, guard = 0;
      while (placed < obsCount && guard++ < 1000) {
        var oi = (rng() * w * h) | 0;
        if (grid[oi] === OBSTACLE) continue;
        grid[oi] = OBSTACLE;
        placed++;
      }

      // 種子擴散：前 colors 顆種子保證每種顏色都出現，其餘隨機
      var normalCells = [];
      for (var i = 0; i < grid.length; i++) if (grid[i] !== OBSTACLE) normalCells.push(i);
      if (!normalCells.length) continue;
      var normalCount = normalCells.length;
      shuffle(normalCells, rng);
      var seedCount = Math.min(normalCells.length, Math.max(colors + 1, Math.round(normalCount / blobSize)));
      var frontier = [];
      for (var s = 0; s < seedCount; s++) {
        grid[normalCells[s]] = s < colors ? s : (rng() * colors) | 0;
        frontier.push(normalCells[s]);
      }
      while (frontier.length) {
        var pick = (rng() * frontier.length) | 0;
        var cur = frontier[pick];
        var cx = cur % w, cy = (cur / w) | 0;
        var open = [];
        for (var d = 0; d < 4; d++) {
          var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (grid[idx(w, nx, ny)] === -2) open.push(idx(w, nx, ny));
        }
        if (!open.length) {
          frontier[pick] = frontier[frontier.length - 1];
          frontier.pop();
          continue;
        }
        var nb = open[(rng() * open.length) | 0];
        grid[nb] = grid[cur];
        frontier.push(nb);
      }
      // 被障礙包圍、擴散沒填到的孤格隨機補色
      for (i = 0; i < grid.length; i++) if (grid[i] === -2) grid[i] = (rng() * colors) | 0;

      // 依序試幾個目標色，求最佳步數
      var cand = [];
      for (var c = 0; c < colors; c++) cand.push(c);
      shuffle(cand, rng);
      for (var ti = 0; ti < cand.length && ti < targetTries; ti++) {
        var target = cand[ti];
        var sol = solve(grid, w, h, { target: target, cap: solveCap, width: width });
        if (!sol || sol.steps === 0) continue;
        var level = {
          w: w, h: h,
          grid: grid.slice(),
          colors: colors,
          targetColor: target,
          maxSteps: sol.steps,
          par: sol.steps,
          solution: sol.moves.slice()
        };
        if (sol.steps >= parMin && sol.steps <= parMax) return level;
        if (!fallback || Math.abs(sol.steps - parMid) < Math.abs(fallback.par - parMid)) fallback = level;
      }
    }
    return fallback;
  }

  /** 難度預設（UI 與測試共用），par 範圍依實測分佈調校 */
  var PRESETS = {
    easy:   { w: 8,  h: 8,  colors: 4, obstacleMin: 0, obstacleMax: 3,  parMin: 3, parMax: 5, blobSize: 6 },
    normal: { w: 10, h: 10, colors: 4, obstacleMin: 3, obstacleMax: 7,  parMin: 4, parMax: 6, blobSize: 4 },
    hard:   { w: 12, h: 12, colors: 5, obstacleMin: 6, obstacleMax: 12, parMin: 6, parMax: 8, blobSize: 4.5, width: 120 }
  };

  return {
    OBSTACLE: OBSTACLE,
    PRESETS: PRESETS,
    idx: idx,
    mulberry32: mulberry32,
    floodZone: floodZone,
    reachableNormals: reachableNormals,
    createGame: createGame,
    isWin: isWin,
    applyMove: applyMove,
    buildRegions: buildRegions,
    solve: solve,
    generateLevel: generateLevel
  };
});
