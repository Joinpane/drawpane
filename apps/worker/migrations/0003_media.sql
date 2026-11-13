-- Images placed in files, and file thumbnails.
--
-- Image bytes live in R2 at `media/<sha>`, addressed by their SHA-256, so the
-- same image uploaded twice is stored once. This table records which teams
-- may read each image: a row per (image, team). Thumbnails live in R2 at
-- `files/<file id>/thumbnail`; `files.thumbnail_at` says when the current one
-- was uploaded and busts caches.

CREATE TABLE media (
  sha TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sha, team_id)
);
CREATE INDEX media_team ON media (team_id, created_at);

ALTER TABLE files ADD COLUMN thumbnail_at INTEGER;
