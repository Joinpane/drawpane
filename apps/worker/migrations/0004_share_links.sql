-- Links that let anyone play a file's prototype without an account.
--
-- The URL token is `<id>.<mac>`, where the mac is an HMAC of the id under the
-- Worker's SESSION_SECRET. Only the id is stored, so a copy of this database
-- alone can't open anyone's prototype. Revoking sets `revoked_at`; a file has
-- at most one live link, and resetting it revokes the old one and makes a new
-- one.

CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX share_links_file ON share_links (file_id, revoked_at);
