/*
 * Inkflow 溢彩畫 — 核心遊戲邏輯
 * UMD：瀏覽器掛在 window.InkflowCore，Node 走 module.exports（供自動化測試）。
 * 格子顏色以 0..k-1 的整數表示，-1 代表障礙物。
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

  /** 從起點 BFS 找出同色相連區塊（主區塊），回傳格子索引陣列 */
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

  /** 起點可達的非障礙格數（用來確認地圖沒有被障礙物切斷） */
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
    if (level.grid[idx(level.w, level.sx, level.sy)] === OBSTACLE) {
      throw new Error("start point must not be an obstacle");
    }
    return {
      w: level.w, h: level.h,
      sx: level.sx, sy: level.sy,
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
   * 玩家選擇新顏色時的核心流程：
   * 1. 合法性檢查（遊戲進行中、非當前顏色）
   * 2. 泛洪找主區塊 → 全部改成新顏色
   * 3. 由主區塊邊緣向外吞併所有相鄰的同新色格子（連鎖）
   * 4. 步數 +1，判定勝負（勝利優先於步數用盡）
   * 回傳動畫所需資料；非法操作回傳 null 且不改動任何狀態。
   */
  function applyMove(state, newColor) {
    if (state.status !== "playing") return null;
    if (newColor == null || newColor < 0 || newColor >= state.colors) return null;
    var w = state.w, h = state.h, g = state.grid;
    var startIdx = idx(w, state.sx, state.sy);
    var oldColor = g[startIdx];
    if (newColor === oldColor) return null;

    // Step 2: 主區塊
    var zone = floodZone(g, w, h, state.sx, state.sy);
    var inZone = new Uint8Array(w * h);
    for (var z = 0; z < zone.length; z++) inZone[zone[z]] = 1;

    // Step 3a: 染色
    for (z = 0; z < zone.length; z++) g[zone[z]] = newColor;

    // Step 3b: 向外吞併同新色格子（BFS 連鎖）
    var queue = zone.slice();
    var absorbed = [];
    for (var qi = 0; qi < queue.length; qi++) {
      var cur = queue[qi], cx = cur % w, cy = (cur / w) | 0;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = idx(w, nx, ny);
        if (inZone[ni] || g[ni] !== newColor) continue;
        inZone[ni] = 1;
        queue.push(ni);
        absorbed.push(ni);
      }
    }

    // 波紋動畫用：起點沿「最終主區塊」的 BFS 距離（自然繞過障礙物）
    var dist = new Int16Array(w * h).fill(-1);
    dist[startIdx] = 0;
    var dq = [startIdx];
    for (qi = 0; qi < dq.length; qi++) {
      cur = dq[qi]; cx = cur % w; cy = (cur / w) | 0;
      for (d = 0; d < 4; d++) {
        nx = cx + DIRS[d][0]; ny = cy + DIRS[d][1];
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
      regions.push({ id: id, color: color, size: queue.length });
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
   * 最佳解求解器：在區域圖上以 BFS 搜尋最少步數把「起點可達的所有區域」
   * 併成單一顏色。狀態＝已吞併區域的 bitmask（BigInt）。
   * opts.target 指定最終顏色時，允許「先併成別的顏色、再花一步整體改色」，
   * 因為把主區塊重新染色不需要吞併任何格子。
   * 回傳 { steps, moves }（moves 為顏色序列），無解或超出預算回傳 null。
   */
  function solve(grid, w, h, sx, sy, opts) {
    opts = opts || {};
    var cap = opts.cap || 24;
    var budget = opts.budget || 300000;
    var target = opts.target != null ? opts.target : null;
    var R = buildRegions(grid, w, h);
    var n = R.regions.length;
    var startRegion = R.regionId[idx(w, sx, sy)];
    if (startRegion < 0 || n === 0) return null;

    var bit = [];
    for (var i = 0; i < n; i++) bit.push(1n << BigInt(i));
    var full = (1n << BigInt(n)) - 1n;
    var adjMask = [];
    for (i = 0; i < n; i++) {
      var m = 0n;
      R.adj[i].forEach(function (j) { m |= bit[j]; });
      adjMask.push(m);
    }
    var colorOf = R.regions.map(function (r) { return r.color; });

    var startMask = bit[startRegion];
    if (startMask === full) {
      if (target == null || colorOf[startRegion] === target) return { steps: 0, moves: [] };
      return { steps: 1, moves: [target] }; // 全圖同色但非目標色：整體改色一步
    }

    var seen = new Map(); // BigInt mask -> { prev, color }
    seen.set(startMask, null);
    var frontier = [startMask];
    var explored = 0;

    function rebuild(mask) {
      var moves = [];
      var node = seen.get(mask);
      while (node) {
        moves.push(node.color);
        node = seen.get(node.prev);
      }
      moves.reverse();
      return moves;
    }

    var fullAnyMask = null; // 已併成單一「非目標」顏色的最淺狀態（可再 +1 步改色）
    for (var depth = 1; depth <= cap; depth++) {
      var next = [];
      for (var f = 0; f < frontier.length; f++) {
        var mask = frontier[f];
        var nbr = 0n;
        for (i = 0; i < n; i++) {
          if (mask & bit[i]) nbr |= adjMask[i];
        }
        nbr &= ~mask;
        if (nbr === 0n) continue; // 被障礙物隔開，永遠到不了 full
        var groups = new Map(); // color -> mask of neighbor regions
        for (i = 0; i < n; i++) {
          if (nbr & bit[i]) {
            var c = colorOf[i];
            groups.set(c, (groups.get(c) || 0n) | bit[i]);
          }
        }
        var done = null;
        groups.forEach(function (gm, c) {
          if (done) return;
          var nm = mask | gm;
          if (seen.has(nm)) return;
          seen.set(nm, { prev: mask, color: c });
          explored++;
          if (nm === full) {
            if (target == null || c === target) done = nm;
            else if (fullAnyMask === null) fullAnyMask = nm; // 深度同層先記著，也許同層還有直達目標色的解
            return;
          }
          next.push(nm);
        });
        if (done) return { steps: depth, moves: rebuild(done) };
        if (explored > budget) return null;
      }
      // 這一層沒有以目標色收尾的解，但有併成他色的解 → 再補一步整體改色
      if (fullAnyMask !== null) {
        return { steps: depth + 1, moves: rebuild(fullAnyMask).concat([target]) };
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return null;
  }

  /**
   * 關卡產生器：隨機放障礙物（保持連通）→ 種子擴散長出大片色塊 →
   * 用求解器求出最佳步數，落在 [parMin, parMax] 才採用；
   * 目標顏色＝最佳解最後一手，步數上限＝最佳步數（跟原作一樣是緊湊的 par）。
   */
  function generateLevel(opts) {
    var w = opts.w, h = opts.h, colors = opts.colors;
    var rng = opts.rng || Math.random;
    var attempts = opts.attempts || 60;
    var obstacleMin = opts.obstacleMin || 0;
    var obstacleMax = opts.obstacleMax != null ? opts.obstacleMax : obstacleMin;
    var parMin = opts.parMin || 3, parMax = opts.parMax || 10;
    var blobSize = opts.blobSize || 6;
    var sx = opts.sx != null ? opts.sx : (w >> 1);
    var sy = opts.sy != null ? opts.sy : (h >> 1);
    var fallback = null;
    var parMid = (parMin + parMax) / 2;

    for (var attempt = 0; attempt < attempts; attempt++) {
      var grid = new Array(w * h).fill(-2); // -2 = 尚未指定顏色

      // 障礙物（不能蓋在起點上）
      var obsCount = obstacleMin + ((rng() * (obstacleMax - obstacleMin + 1)) | 0);
      var placed = 0, guard = 0;
      while (placed < obsCount && guard++ < 1000) {
        var ox = (rng() * w) | 0, oy = (rng() * h) | 0;
        var oi = idx(w, ox, oy);
        if ((ox === sx && oy === sy) || grid[oi] === OBSTACLE) continue;
        grid[oi] = OBSTACLE;
        placed++;
      }

      // 所有非障礙格必須與起點連通，否則永遠無法通關
      var normalCount = 0;
      for (var i = 0; i < grid.length; i++) if (grid[i] !== OBSTACLE) normalCount++;
      if (reachableNormals(grid, w, h, sx, sy) !== normalCount) continue;

      // 種子擴散：前 colors 顆種子保證每種顏色都出現，其餘隨機
      var normalCells = [];
      for (i = 0; i < grid.length; i++) if (grid[i] !== OBSTACLE) normalCells.push(i);
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

      var sol = solve(grid, w, h, sx, sy, { cap: parMax + 4, budget: opts.budget || 250000 });
      if (!sol || sol.steps === 0) continue;
      var level = {
        w: w, h: h, sx: sx, sy: sy,
        grid: grid.slice(),
        colors: colors,
        targetColor: sol.moves[sol.moves.length - 1],
        maxSteps: sol.steps,
        par: sol.steps,
        solution: sol.moves.slice()
      };
      if (sol.steps >= parMin && sol.steps <= parMax) return level;
      if (!fallback || Math.abs(sol.steps - parMid) < Math.abs(fallback.par - parMid)) fallback = level;
    }
    return fallback;
  }

  /** 難度預設（UI 與測試共用），par 範圍依實測分佈調校 */
  var PRESETS = {
    easy:   { w: 8,  h: 8,  colors: 4, obstacleMin: 0, obstacleMax: 3,  parMin: 3, parMax: 5, blobSize: 6 },
    normal: { w: 10, h: 10, colors: 4, obstacleMin: 3, obstacleMax: 7,  parMin: 4, parMax: 6, blobSize: 4 },
    hard:   { w: 12, h: 12, colors: 5, obstacleMin: 6, obstacleMax: 12, parMin: 6, parMax: 8, blobSize: 3.5 }
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
