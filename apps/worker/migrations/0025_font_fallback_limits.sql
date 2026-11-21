CREATE TABLE font_fallback_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  window INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
