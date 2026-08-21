-- ── hi_hive_alias: extra ids that point at an existing credentials doc ───────
--
-- hi_hive.doc_id is a single platform id: a WhatsApp jid for a WhatsApp user, a
-- Telegram user id for a Telegram one. Both bots share the table, so the same
-- human using both ends up as two unrelated rows - two sets of creds, two
-- separate contribution counts, and a doc that only one of their accounts can
-- reach.
--
-- Rather than re-key hi_hive (doc_id is referenced by scan_buffer, tokens and
-- the ranking, and anonymous docs are keyed by student id on purpose), an alias
-- is a second id that resolves to an existing doc. One doc, many ways in.
--
--   alias_id  the platform id being bound (jid, telegram user id)
--   doc_id    the hi_hive row it resolves to
--   transport which platform alias_id belongs to, so listings can say so
--   bound_by  who ran the bind, for accountability
--
-- ON DELETE CASCADE: deleting the creds drops the aliases with them, so a
-- rebound id can never resolve to a row that is gone.

CREATE TABLE IF NOT EXISTS hi_hive_alias (
    alias_id   TEXT PRIMARY KEY,
    doc_id     TEXT NOT NULL REFERENCES hi_hive(doc_id) ON DELETE CASCADE,
    transport  TEXT,
    bound_by   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hihive_alias_doc ON hi_hive_alias (doc_id);

-- An id that is already a doc must never also be an alias, or resolution order
-- would decide which credentials a person gets.
CREATE OR REPLACE FUNCTION hi_hive_alias_not_a_doc() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM hi_hive WHERE doc_id = NEW.alias_id) THEN
        RAISE EXCEPTION 'alias_id % is already a hi_hive doc_id', NEW.alias_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hi_hive_alias_not_a_doc ON hi_hive_alias;
CREATE TRIGGER trg_hi_hive_alias_not_a_doc
    BEFORE INSERT OR UPDATE ON hi_hive_alias
    FOR EACH ROW EXECUTE FUNCTION hi_hive_alias_not_a_doc();
