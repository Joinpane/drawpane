-- The kit store (docs/decisions/0022-kit-store.md): which kits a team has
-- added, and the file each one became, so the store can say "Added". A kit
-- whose file is deleted for good goes with it; one in the trash isn't
-- counted (the query checks).

CREATE TABLE team_kits (
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  -- The kit's id in the registry's index.
  kit_id TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  added_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, kit_id, file_id)
);
CREATE INDEX team_kits_file ON team_kits (file_id);
