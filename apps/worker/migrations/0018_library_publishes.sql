-- Team libraries (docs/decisions/0010-team-libraries.md): each time a file is
-- published as a library. The publish points at a named version of the file,
-- whose snapshot is what files using the library copy components from; the
-- version sweep never deletes a version a publish points at.

CREATE TABLE library_publishes (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  -- The library's team: who may use it.
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions (id),
  -- The file's revision the version holds.
  revn INTEGER NOT NULL,
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  published_at INTEGER NOT NULL,
  -- What changed, as the publisher put it.
  description TEXT,
  -- What it offers, as JSON: [{"id", "name", "description", "set", "hash"}].
  assets TEXT NOT NULL
);
CREATE INDEX library_publishes_file ON library_publishes (file_id, published_at);
CREATE INDEX library_publishes_team ON library_publishes (team_id, published_at);
