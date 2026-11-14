-- Emails about the inbox (docs/decisions/0006-email.md). A notification is
-- emailed once, if it's still unread a few minutes after it happened; the
-- cron claims it (emailed_at) before sending, and a failure that's worth
-- retrying gives it back, up to a few attempts.
ALTER TABLE notifications ADD COLUMN emailed_at INTEGER;
ALTER TABLE notifications ADD COLUMN email_attempts INTEGER NOT NULL DEFAULT 0;
-- The address the action came from (https://design.example.com): where the
-- email's links go. The Worker has no other way to know its own domain.
ALTER TABLE notifications ADD COLUMN origin TEXT;
-- What the cron looks for: not emailed, not read.
CREATE INDEX notifications_to_email ON notifications (created_at)
  WHERE emailed_at IS NULL AND read_at IS NULL;

-- How each person wants to hear: as it happens (a few minutes after, if
-- they haven't seen it), once a day at an hour they pick, or not by email.
ALTER TABLE users ADD COLUMN email_notifications TEXT NOT NULL DEFAULT 'instant'
  CHECK (email_notifications IN ('instant', 'daily', 'off'));
ALTER TABLE users ADD COLUMN digest_hour INTEGER NOT NULL DEFAULT 9
  CHECK (digest_hour BETWEEN 0 AND 23);
-- An IANA zone ("Europe/Lisbon") for the digest hour; UTC until the app says.
ALTER TABLE users ADD COLUMN time_zone TEXT;
ALTER TABLE users ADD COLUMN last_digest_at INTEGER;
