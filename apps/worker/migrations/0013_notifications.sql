-- The inbox: what someone should hear about. Written when it happens (a
-- mention, a reply in a thread they're in, their thread resolved), so each
-- has its own read state, and email digests can read the same rows later.
-- A deleted comment, thread or file takes its notifications with it.
-- Timestamps are Unix milliseconds.

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mention', 'reply', 'resolved')),
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES comment_threads (id) ON DELETE CASCADE,
  -- The comment it's about; null for a resolved thread.
  comment_id TEXT REFERENCES comments (id) ON DELETE CASCADE,
  -- Who did it.
  actor_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX notifications_user ON notifications (user_id, created_at);
CREATE INDEX notifications_thread ON notifications (thread_id, user_id);
-- One notification per person per comment and kind: editing a comment never repeats one.
CREATE UNIQUE INDEX notifications_once ON notifications (user_id, comment_id, kind)
  WHERE comment_id IS NOT NULL;

-- Mentions from before the inbox: the last two weeks arrive unread, older ones read.
INSERT INTO notifications (id, user_id, kind, file_id, thread_id, comment_id, actor_id, created_at, read_at)
SELECT lower(hex(randomblob(16))), m.user_id, 'mention', m.file_id, c.thread_id, m.comment_id,
       c.author_id, m.created_at,
       CASE WHEN m.created_at >= (unixepoch() - 14 * 86400) * 1000 THEN NULL ELSE m.created_at END
  FROM comment_mentions m JOIN comments c ON c.id = m.comment_id
 WHERE c.author_id IS NULL OR c.author_id <> m.user_id;
