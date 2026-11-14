-- Who an invite link is for, in the owner's words ("Lee, design"): invites
-- are links, not emails, so the Members page needs something to tell
-- pending ones apart by.
ALTER TABLE invites ADD COLUMN note TEXT;
