-- A deleted project goes to the trash with its files, instead of taking
-- them with it: its files move to the trash, and the project stays,
-- hidden, until the last of them is deleted for good. Restoring any of
-- its files brings it back.
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
