-- ── hi_hive: who the student actually is ────────────────────────────────────
--
-- The leaderboard could only ever print a student id, because that is the only
-- human-facing thing stored. `display_name` holds the name the chat platform
-- already knows (WhatsApp pushName, Telegram first_name/username), captured
-- from messages that arrive anyway - no lookup, no outbound message.
--
-- `jid` is the chat account the credentials belong to. hi_hive_alias already
-- maps ids to docs, but an alias is a lookup table: this column answers the
-- opposite question - "whose account is this row?" - without a join, and stays
-- correct for anonymous docs where doc_id is a student id rather than a jid.
--
-- Both are nullable. A doc added anonymously has neither until its owner is
-- bound or seen speaking.

ALTER TABLE hi_hive ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE hi_hive ADD COLUMN IF NOT EXISTS jid          TEXT;
ALTER TABLE hi_hive ADD COLUMN IF NOT EXISTS name_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_hihive_jid ON hi_hive (jid);

-- Backfill jid for personal docs, where the doc id already IS the account.
--
-- Match what an account actually looks like rather than excluding what a
-- student id looks like: a WhatsApp jid always contains '@'
-- (...@s.whatsapp.net, ...@lid, ...@g.us) and a Telegram user id is a run of
-- digits longer than the 7 a student id uses. Older docs keyed by a random
-- string are neither, and must not be mistaken for an account.
UPDATE hi_hive
   SET jid = doc_id
 WHERE jid IS NULL
   AND (doc_id LIKE '%@%' OR doc_id ~ '^[0-9]{8,}$');
