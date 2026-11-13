-- Comments. Threads are anchored to a point on a page and may be pinned to a
-- layer, so they move with it. They live in D1 rather than in the file's
-- Durable Object so the dashboard can list mentions across files.
-- Timestamps are Unix milliseconds.

CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  -- Node ids from the file's document; not foreign keys, the document lives in the FileRoom.
  page_id TEXT NOT NULL,
  -- Page coordinates: where the pin sits when it isn't pinned to a layer, or the layer is gone.
  x REAL NOT NULL,
  y REAL NOT NULL,
  -- The layer the pin follows, and the point in that layer's local box.
  node_id TEXT,
  node_x REAL,
  node_y REAL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  -- Last activity, for sorting: a reply, an edit, resolving or reopening.
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  CHECK ((node_id IS NULL) = (node_x IS NULL) AND (node_id IS NULL) = (node_y IS NULL))
);
CREATE INDEX comment_threads_file ON comment_threads (file_id, updated_at);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads (id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER
);
CREATE INDEX comments_thread ON comments (thread_id, created_at);

-- One row per person mentioned in a comment. file_id is denormalized so a
-- person's mentions can be listed without joining through threads.
CREATE TABLE comment_mentions (
  comment_id TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX comment_mentions_user ON comment_mentions (user_id, created_at);
