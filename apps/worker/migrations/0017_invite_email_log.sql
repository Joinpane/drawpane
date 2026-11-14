-- Invite emails a team has sent, for the daily cap (INVITE_EMAILS_PER_DAY).
-- Kept apart from the invites themselves: taking an invite back deletes it,
-- and that mustn't give its email back to the cap. A slot is reserved before
-- sending (one statement checks and takes it) and given back only if sending
-- fails.
CREATE TABLE invite_emails (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL
);
CREATE INDEX invite_emails_team ON invite_emails (team_id, sent_at);
