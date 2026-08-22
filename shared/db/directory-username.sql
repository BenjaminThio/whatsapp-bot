-- ── username: the @handle, distinct from a display name ────────────────────
--
-- WhatsApp now shows two different things on a contact card: a display name
-- ("惠璘") and a handle ("@huelengtee"). They are separate fields on the Contact
-- object and either can be present without the other, so collapsing them into
-- one column loses information - and the handle is often the more stable of the
-- two, since a display name changes whenever the person feels like it.
--
-- Telegram has exactly the same split: first_name versus username.

ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE hi_hive      ADD COLUMN IF NOT EXISTS username TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_members_username ON chat_members (username);
