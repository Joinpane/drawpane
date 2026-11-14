-- Instance health and cost (docs/decisions/0003-instance-health.md).

-- The instance admin: whoever set the instance up (the oldest account).
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_admin = 1
 WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1);

-- Daily counters, added to by each file's room when its alarm runs.
CREATE TABLE usage_daily (
  day TEXT NOT NULL,          -- UTC, YYYY-MM-DD
  metric TEXT NOT NULL,       -- "edits", or a latency bucket like "latency_le_64"
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
) WITHOUT ROWID;

-- Who edited on which day: active editors over a period.
CREATE TABLE editors_daily (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (day, user_id)
) WITHOUT ROWID;

-- Each file room's own storage, as of its last report.
CREATE TABLE room_storage (
  file_id TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
