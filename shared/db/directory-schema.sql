-- ── The chat directory: who and where the bots can see ──────────────────────
--
-- A passive census. Nothing here is scraped from anyone's device or fetched by
-- messaging people: WhatsApp hands the bot full membership for every group it
-- belongs to in a single call, and both platforms attach a display name to
-- every message that arrives.
--
-- Kept separate from hi_hive on purpose. hi_hive is credentials - people who
-- deliberately registered. This is everyone the bot happens to share a room
-- with, most of whom never asked to be in a database. Two tables, so "delete
-- the census" never means "delete someone's account".
--
--   chats         one row per group or DM the bot can see
--   chat_members  one row per person per chat

CREATE TABLE IF NOT EXISTS chats (
    chat_id      TEXT NOT NULL,
    transport    TEXT NOT NULL,
    -- "group" or "dm"
    kind         TEXT NOT NULL DEFAULT 'group',
    name         TEXT,
    description  TEXT,
    -- Denormalised so the overview does not need a count(*) per chat
    member_count INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chat_id, transport)
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id      TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    transport    TEXT NOT NULL,
    display_name TEXT,
    is_admin     BOOLEAN NOT NULL DEFAULT false,
    -- When the bot first and last had evidence this person was here
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when they are observed sending a message, as opposed to merely
    -- appearing in a member list
    last_spoke   TIMESTAMPTZ,
    PRIMARY KEY (chat_id, user_id, transport)
);

CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members (user_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members (chat_id, transport);
CREATE INDEX IF NOT EXISTS idx_chats_transport    ON chats (transport);
