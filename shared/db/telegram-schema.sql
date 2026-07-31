-- telegram-schema.sql — tables that used to live in Firestore.
--
-- The Telegram bot kept six collections (shop, snake, sokoban, calculator,
-- ticTacToe, birthday) behind six copies of the same five functions, all keyed
-- by the Telegram user id. They are one table here: a per-(namespace, owner)
-- JSON document. Adding a new stateful feature no longer means writing another
-- database module.
--
-- Rows are namespaced rather than split into tables because the payloads are
-- small, schemaless and only ever read/written whole by their owning feature.

CREATE TABLE IF NOT EXISTS user_docs (
    namespace   TEXT NOT NULL,              -- 'shop' | 'snake' | 'sokoban' | ...
    owner_id    TEXT NOT NULL,              -- Telegram user id (or a WA jid)
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_user_docs_ns      ON user_docs (namespace);
CREATE INDEX IF NOT EXISTS idx_user_docs_updated ON user_docs (namespace, updated_at DESC);

-- ── bot_settings: small global key/value config both bots can read ───────────
-- Replaces the Firestore "temp/report" document that held the GitHub report
-- chat id, and gives the shared code somewhere to keep singleton settings.
CREATE TABLE IF NOT EXISTS bot_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Cross-platform routing ───────────────────────────────────────────────────
-- The outbox now serves two bots, so a queued row has to remember which one is
-- supposed to deliver it.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'whatsapp';
CREATE INDEX IF NOT EXISTS idx_outbox_transport ON outbox (transport, next_try_at, priority);

-- Reminders and birthdays are shared between the bots, so they need to record
-- which platform the chat id belongs to. Existing rows are WhatsApp.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE birthdays ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'whatsapp';

-- The Telegram birthday feature stores a per-row remind year like WhatsApp does,
-- but also allowed several people per chat, so doc_id stays the primary key.
ALTER TABLE birthdays ADD COLUMN IF NOT EXISTS created_by TEXT;

-- hi_hive credentials are keyed by a platform-specific id (a WhatsApp jid or a
-- Telegram user id). Recording which platform a doc came from lets `!test list`
-- and the contribution ranking stay meaningful across both bots.
ALTER TABLE hi_hive ADD COLUMN IF NOT EXISTS transport TEXT;

-- ── processed_messages needs a transport too ─────────────────────────────────
-- Message ids are only unique within a platform.
ALTER TABLE processed_messages ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'whatsapp';
