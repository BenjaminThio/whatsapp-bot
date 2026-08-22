-- ── chat_members.phone_number ───────────────────────────────────────────────
--
-- WhatsApp addresses group members by a privacy id ("...@lid") rather than
-- their phone number, and supplies a display name only for contacts the client
-- has separately synced. Without a name, a lid is 15 unreadable digits: the
-- directory ended up as several hundred rows all labelled "Unnamed".
--
-- A phone number is not a name, but it IS recognisable - you can match it to
-- someone you know, and paste it into `!test bind`. Two sources:
--
--   • the participant object itself, which is a Contact and may carry
--     phoneNumber already
--   • sock.signalRepository.lidMapping.getPNForLID(), Baileys' own lid ->
--     phone-number store, which needs no network call
--
-- Nullable: a lid that has never been resolved has nothing to put here.

ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS phone_number TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_members_phone ON chat_members (phone_number);

-- hi_hive rows benefit from the same thing, so a registered student can be
-- recognised by number when no name has been seen.
ALTER TABLE hi_hive ADD COLUMN IF NOT EXISTS phone_number TEXT;
