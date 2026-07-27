-- migrate-docids.sql — convert anonymous creds from random doc_ids to student ids.
-- Run once:  psql -d lasma_bot -f migrate-docids.sql
--
-- Personal creds (owner_id IS NULL, doc_id = the user's jid) are LEFT ALONE —
-- only anonymous rows (owner_id IS NOT NULL) are re-keyed.

BEGIN;

-- 1. Drop duplicates first: if the same student was added twice under different
--    random ids, keep the most recently updated row.
DELETE FROM hi_hive a
USING hi_hive b
WHERE a.owner_id IS NOT NULL
  AND b.owner_id IS NOT NULL
  AND a.student_id = b.student_id
  AND a.updated_at < b.updated_at;

-- 2. Re-key remaining anonymous rows to use student_id as doc_id.
--    Skip any whose student_id already collides with an existing doc_id
--    (e.g. a personal row) to avoid a PK violation.
UPDATE hi_hive h
SET doc_id = h.student_id
WHERE h.owner_id IS NOT NULL
  AND h.doc_id <> h.student_id
  AND NOT EXISTS (
    SELECT 1 FROM hi_hive x WHERE x.doc_id = h.student_id
  );

COMMIT;

-- Check the result:
--   SELECT doc_id, student_id, email, owner_id FROM hi_hive ORDER BY owner_id NULLS FIRST;