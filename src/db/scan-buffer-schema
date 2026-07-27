-- scan_buffer: persisted auto-scan queue. Survives restarts.
-- Each row = one student's pending scan, with its own due time.
CREATE TABLE IF NOT EXISTS scan_buffer (
    id            TEXT PRIMARY KEY,
    batch_id      TEXT NOT NULL,        -- groups all jobs from ONE scanned QR
    doc_id        TEXT NOT NULL,        -- hi_hive account to scan for
    label         TEXT NOT NULL,        -- display label (student id, or masked)
    raw_qr        TEXT NOT NULL,        -- the QR payload to submit
    chat_id       TEXT NOT NULL,        -- where to send the report
    quoted_key    JSONB,                -- WA message key to quote in the report
    due_at        BIGINT NOT NULL,      -- epoch ms this job should run
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | done
    result_status TEXT,                 -- ReportStatus once done
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scanbuf_due   ON scan_buffer (status, due_at);
CREATE INDEX IF NOT EXISTS idx_scanbuf_batch ON scan_buffer (batch_id);

-- whitelisted_groups: only these chats may trigger auto-scan.
CREATE TABLE IF NOT EXISTS whitelisted_groups (
    jid        TEXT PRIMARY KEY,
    added_by   TEXT,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);