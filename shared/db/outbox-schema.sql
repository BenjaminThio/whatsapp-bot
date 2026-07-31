-- ── outbox: durable outbound WhatsApp messages ───────────────────────────────
-- Every message the bot wants to send is written here first. A drain service
-- delivers them when the socket is up. Nothing is lost to a disconnect.
CREATE TABLE IF NOT EXISTS outbox (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'message',-- message | text | image | reaction (last 3 legacy)
    body          JSONB NOT NULL,                 -- sendMessage content (Buffers tagged + base64)
    options       JSONB,                          -- e.g. { quotedKey }
    priority      INTEGER NOT NULL DEFAULT 5,     -- lower = sooner
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_try_at   BIGINT NOT NULL,                -- epoch ms
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error    TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_ready ON outbox (next_try_at, priority);
CREATE INDEX IF NOT EXISTS idx_outbox_chat  ON outbox (chat_id, created_at);

-- ── processed_messages: survive-restart duplicate guard ──────────────────────
-- The in-memory Set was lost on restart, so catching up on offline messages
-- could re-scan a QR that had already been handled.
CREATE TABLE IF NOT EXISTS processed_messages (
    msg_id      TEXT PRIMARY KEY,
    handled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processed_at ON processed_messages (handled_at);