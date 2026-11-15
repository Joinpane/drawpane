-- Agents that write (docs/decisions/0021-agent-tools.md): tokens get a scope,
-- and an agent writes inside a session, live in the file or on a branch.

-- A token reads ('read') or reads and writes ('write'). SQLite can't change a
-- CHECK, so the table is rebuilt; every existing token stays read-only.
CREATE TABLE api_tokens_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- The start of the token, to recognise it by ("dp_pat_Ab3x…").
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  -- Null: it doesn't expire.
  expires_at INTEGER
);
INSERT INTO api_tokens_new (id, user_id, name, token_hash, prefix, scope, created_at, last_used_at, expires_at)
  SELECT id, user_id, name, token_hash, prefix, 'read', created_at, last_used_at, expires_at FROM api_tokens;
DROP TABLE api_tokens;
ALTER TABLE api_tokens_new RENAME TO api_tokens;
CREATE INDEX api_tokens_user ON api_tokens (user_id, created_at);

-- An agent's working session: who it acts for, through which token, and the
-- file it writes to (the file itself when live, a branch of it otherwise).
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only this token may use the session; revoking it ends the session.
  token_id TEXT REFERENCES api_tokens (id) ON DELETE SET NULL,
  -- The file the session was started on.
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  -- Where its writes land: file_id when live, the branch it made otherwise.
  target_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'branch')),
  -- As people see it: "Claude, for Ana".
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX agent_sessions_user ON agent_sessions (user_id, created_at);
CREATE INDEX agent_sessions_target ON agent_sessions (target_id);
