-- scan_buffer: persisted auto-scan queue. Survives restarts.
CREATE TABLE IF NOT EXISTS scan_buffer (
    id            TEXT PRIMARY KEY,
    batch_id      TEXT NOT NULL,        -- groups all jobs from ONE scanned QR
    doc_id        TEXT NOT NULL,        -- hi_hive account to scan for
    student_id    TEXT,                 -- real student id (label may be masked)
    label         TEXT NOT NULL,        -- display label (masked when hidden)
    raw_qr        TEXT NOT NULL,
    chat_id       TEXT NOT NULL,        -- chat the QR arrived in
    quoted_key    JSONB,
    destinations  JSONB,                -- where this batch's report should go
    due_at        BIGINT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    result_status TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scanbuf_due   ON scan_buffer (status, due_at);
CREATE INDEX IF NOT EXISTS idx_scanbuf_batch ON scan_buffer (batch_id);

-- Upgrade path for an existing table
ALTER TABLE scan_buffer ADD COLUMN IF NOT EXISTS student_id   TEXT;
ALTER TABLE scan_buffer ADD COLUMN IF NOT EXISTS destinations JSONB;

CREATE TABLE IF NOT EXISTS whitelisted_groups (
    jid        TEXT PRIMARY KEY,
    added_by   TEXT,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);