-- Sign-in with GitHub and Google: the provider accounts linked to each user.
-- A user can have several (and passkeys too); a provider account belongs to
-- one user.
CREATE TABLE oauth_identities (
  provider TEXT NOT NULL CHECK (provider IN ('github', 'google')),
  -- The provider's stable id for the account (GitHub's numeric id, Google's `sub`)
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Shown in account settings ("@ana" on GitHub, the address on Google)
  label TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX oauth_identities_user ON oauth_identities (user_id);
