-- Fonts a team uploads, one row per face (a weight and style of a family).
--
-- Bytes live in R2 at `fonts/team/<sha>`, addressed by their SHA-256. The
-- family, style, weight and italic flag are read from the font's own tables
-- when it's uploaded (see packages/model/src/fonts.ts), never typed in.
-- Uploading the same face again replaces it.

CREATE TABLE team_fonts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  family TEXT NOT NULL,
  style TEXT NOT NULL,
  -- The weight class; for a variable font, the lightest weight, with weight_max the heaviest.
  weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 1000),
  weight_max INTEGER CHECK (weight_max IS NULL OR weight_max BETWEEN 1 AND 1000),
  italic INTEGER NOT NULL DEFAULT 0 CHECK (italic IN (0, 1)),
  format TEXT NOT NULL CHECK (format IN ('ttf', 'otf', 'woff', 'woff2')),
  sha TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  -- An open license the font names (OFL, Apache…), or NULL.
  license TEXT,
  -- The font marks itself "restricted license embedding".
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),
  uploaded_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
-- One row per face. A variable font and a static face of the same family
-- can sit side by side, so the weight range is part of what makes a face.
CREATE UNIQUE INDEX team_fonts_face ON team_fonts (team_id, family, weight, ifnull(weight_max, 0), italic);
CREATE INDEX team_fonts_team ON team_fonts (team_id, family);
