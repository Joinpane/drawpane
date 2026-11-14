-- Invites by email (docs/decisions/0006-email.md): an owner can send the
-- link to an address as well as copy it. The address shows on the pending
-- invite; emailed_at is when it went (null: not emailed, or it failed), and
-- bounds how many invite emails a team sends in a day.
ALTER TABLE invites ADD COLUMN email TEXT;
ALTER TABLE invites ADD COLUMN emailed_at INTEGER;
CREATE INDEX invites_team_emailed ON invites (team_id, emailed_at) WHERE emailed_at IS NOT NULL;
