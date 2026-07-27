-- Batch metadata so the service knows how to react and who to credit.
ALTER TABLE scan_buffer ADD COLUMN IF NOT EXISTS origin_silent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scan_buffer ADD COLUMN IF NOT EXISTS scanned_by    TEXT;

-- QR contribution counter: how many QRs this student has supplied.
ALTER TABLE hi_hive ADD COLUMN IF NOT EXISTS contributions INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_hihive_contrib ON hi_hive (contributions DESC);