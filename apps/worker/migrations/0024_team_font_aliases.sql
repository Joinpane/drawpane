-- A team's font aliases (decision 0034): text in a family the team doesn't
-- have is drawn in another, for everyone on the team, in every file, without
-- the files changing. "SF Pro" to "SF Pro Text" below 20 px and "SF Pro
-- Display" from 20 px, say. Built-in aliases (packages/model/src/
-- font-aliases.ts) aren't stored; a team's own is tried before them.
--
-- `targets` is JSON, as `FontAliasTarget[]` there: [{ "family": "...",
-- "minSize"?: px, "maxSize"?: px }], checked by `parseFontAlias` on the way in.

CREATE TABLE team_font_aliases (
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  targets TEXT NOT NULL,
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, family)
);
