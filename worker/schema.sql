-- InkFlow 匿名統計資料表（Cloudflare D1 / SQLite）
-- 建立方式見 docs/cloudflare-setup.md

CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,   -- 伺服器收到的時間（毫秒）。不採用瀏覽器時間，避免時鐘不準或被竄改
  aid     TEXT    NOT NULL,   -- 匿名裝置 id（隨機產生，存在玩家的 localStorage）
  sid     TEXT    NOT NULL,   -- 本次造訪 id
  name    TEXT    NOT NULL,   -- session_start / start / level_start / level_end / ping / session_end
  diff    TEXT,               -- easy / normal / hard
  result  TEXT,               -- won / lost / abandoned（僅 level_end）
  steps   INTEGER,            -- 該關已用步數
  par     INTEGER,            -- 該關步數上限
  ms      INTEGER,            -- level_end：該關花費毫秒；ping/session_end：活躍毫秒
  hints   INTEGER,            -- 該關用掉幾次提示
  country TEXT,               -- Cloudflare 判斷的國家代碼（不儲存 IP）
  props   TEXT                -- 其餘欄位的 JSON
);

CREATE INDEX IF NOT EXISTS idx_events_ts   ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name, ts);
CREATE INDEX IF NOT EXISTS idx_events_sid  ON events(sid);
