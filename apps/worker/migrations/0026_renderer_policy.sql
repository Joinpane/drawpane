-- One optional row for this instance. Existing files keep their current format.
CREATE TABLE renderer_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_renderer TEXT CHECK (default_renderer IN ('canvas', 'engine')),
  force_canvas INTEGER NOT NULL CHECK (force_canvas IN (0, 1))
);
