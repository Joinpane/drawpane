-- Who has each file open right now, as each file's room last reported:
-- when someone's role on a team changes, or they're removed, the Worker
-- tells only the rooms where they're connected, instead of waking every
-- file the team has. A row can outlive its socket (a room that restarted);
-- the room then finds nobody to tell and deletes it.
CREATE TABLE room_connections (
  file_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, user_id)
) WITHOUT ROWID;
CREATE INDEX room_connections_user ON room_connections (user_id);
