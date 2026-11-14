-- File names as search compares them (see searchFold in @drawpane/model):
-- without accents, in lower case. D1's lower() and LIKE only fold ASCII, so
-- the Worker writes this with each name; names from before fill in the
-- first time their team searches.
ALTER TABLE files ADD COLUMN search_name TEXT;

-- The inbox: deleting a comment, file or user reaches its notifications by
-- these columns, and an edit looks them up by comment.
CREATE INDEX notifications_comment ON notifications (comment_id);
CREATE INDEX notifications_file ON notifications (file_id);
CREATE INDEX notifications_actor ON notifications (actor_id);
-- The unread count, asked for on every page: only what's unread.
CREATE INDEX notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
