-- Branches (docs/decisions/0012-branches.md): a branch is a file of its own,
-- copied from its main file at a revision and merged back change by change.

-- Set on a branch's file: the file it branches. Listings, search and the MCP
-- server show main files only; a branch is reached from its main file. When
-- the main file is deleted for good, its branches go with it.
ALTER TABLE files ADD COLUMN branch_of TEXT REFERENCES files (id) ON DELETE CASCADE;
CREATE INDEX files_branch_of ON files (branch_of);

CREATE TABLE branches (
  file_id TEXT PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
  -- The main file's revision the branch was made at; its nodes then are the
  -- base snapshot in R2 (files/<file_id>/branch-base.json.gz).
  base_revn INTEGER NOT NULL,
  -- Once merged, the branch is read-only history.
  merged_at INTEGER,
  merged_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  -- The main file's revision the merge landed at.
  merged_revn INTEGER,
  -- How many changes the merge took.
  merged_changes INTEGER
);
