-- Keyboard shortcuts a person has changed from the defaults: a JSON object of
-- action id → shortcut ({ key, mod?, shift?, alt? }), or null for "none".
-- They follow the account, so they're the same in every browser.
ALTER TABLE users ADD COLUMN shortcuts TEXT NOT NULL DEFAULT '{}';
