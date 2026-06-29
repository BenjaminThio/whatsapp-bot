-- schema.sql — full Postgres schema for the bot (everything except the webhook
-- system, which stays on Firestore so Vercel can reach it behind CGNAT).
--
-- Run once:  psql -d lasma_bot -f schema.sql
-- (or let the bot call ensureSchema() on startup)

-- ── hi_hive: student credentials (personal + anonymous) ──
-- Personal: doc_id = userId, owner_id NULL.  Anonymous: doc_id = random, owner_id set.
CREATE TABLE IF NOT EXISTS hi_hive (
    doc_id      TEXT PRIMARY KEY,
    student_id  TEXT NOT NULL,
    email       TEXT NOT NULL,
    hidden      BOOLEAN NOT NULL DEFAULT FALSE,
    owner_id    TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hihive_owner   ON hi_hive (owner_id);
CREATE INDEX IF NOT EXISTS idx_hihive_student ON hi_hive (student_id);
CREATE INDEX IF NOT EXISTS idx_hihive_email   ON hi_hive (email);

-- ── ai_memory: per-chat AI history ──
CREATE TABLE IF NOT EXISTS ai_memory (
    chat_id     TEXT PRIMARY KEY,
    history     JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── schedules: reminders (one-shot + escalation milestones) ──
CREATE TABLE IF NOT EXISTS schedules (
    id              TEXT PRIMARY KEY,
    jid             TEXT NOT NULL,
    activity        TEXT NOT NULL,
    fire_at         BIGINT NOT NULL,        -- epoch ms
    requester       TEXT NOT NULL,
    fired           BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    group_id        TEXT,
    deadline_at     BIGINT,
    milestone_label TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedules_due   ON schedules (fired, fire_at);
CREATE INDEX IF NOT EXISTS idx_schedules_jid   ON schedules (jid, fired);
CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules (group_id);

-- ── birthdays: year-locked birthday reminders ──
CREATE TABLE IF NOT EXISTS birthdays (
    doc_id      TEXT PRIMARY KEY,           -- `${jid}_${name}` (spaces→_)
    name        TEXT NOT NULL,
    bday_date   TEXT NOT NULL,              -- "DD/MM" — scheduler matches on this
    birth_year  INTEGER,                    -- NULL if user omitted the year
    jid         TEXT NOT NULL,              -- chat to announce in
    remind_year INTEGER,                    -- last year we wished them (year-lock)
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_birthdays_date ON birthdays (bday_date);
CREATE INDEX IF NOT EXISTS idx_birthdays_jid  ON birthdays (jid);

-- ── user_prefs: per-chat settings (e.g. ttsLang) as a JSONB blob ──
CREATE TABLE IF NOT EXISTS user_prefs (
    user_id     TEXT PRIMARY KEY,
    prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);