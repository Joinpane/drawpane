-- A file the team starts new files from (New file → Your team).
ALTER TABLE files ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;
CREATE INDEX files_templates ON files (team_id, is_template, deleted_at);
