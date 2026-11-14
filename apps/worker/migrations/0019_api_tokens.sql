-- Personal access tokens (docs/decisions/0011-mcp-server.md): for MCP clients
-- and other tools acting as a person. Only the token's SHA-256 is kept.

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  -- The start of the token, to recognise it by ("dp_pat_Ab3x…").
  prefix TEXT NOT NULL,
  -- What it may do: 'read' for now.
  scope TEXT NOT NULL CHECK (scope IN ('read')),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  -- Null: it doesn't expire.
  expires_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens (user_id, created_at);
