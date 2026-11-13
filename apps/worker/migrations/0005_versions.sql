-- Saved versions of a file: one row per R2 snapshot (`files/<file>/snapshots/<revn>.json.gz`).
--
-- The FileRoom saves one on its own while a file is being edited (at most
-- hourly, and when editing pauses), one when someone names the current state,
-- and one just before a restore, so a restore can always be undone. Unnamed
-- versions are kept for 30 days; named ones until the file is deleted.

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  -- The file's revision the snapshot holds.
  revn INTEGER NOT NULL,
  -- Why it was saved: 'auto', 'named' (someone saved it with a name) or 'restore' (just before a restore).
  reason TEXT NOT NULL CHECK (reason IN ('auto', 'named', 'restore')),
  -- Named versions show this instead of their edit count. Naming an autosave keeps its reason.
  name TEXT,
  description TEXT,
  -- For reason 'restore': the version that was restored.
  restored_id TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  -- Who edited since the previous version, as a JSON array of user ids.
  authors TEXT NOT NULL DEFAULT '[]',
  -- What those edits changed, as JSON: {"edits": 38, "kinds": {"style": 14, ...}}.
  summary TEXT NOT NULL DEFAULT '{"edits":0,"kinds":{}}',
  -- When the first of those edits happened, for "2:30 – 3:10 pm".
  started_at INTEGER,
  -- Compressed size of the snapshot in bytes.
  size INTEGER NOT NULL,
  UNIQUE (file_id, revn)
);
CREATE INDEX versions_file ON versions (file_id, created_at);
CREATE INDEX versions_retention ON versions (created_at) WHERE name IS NULL;
