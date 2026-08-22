-- ── contributors: QR credit for people with no hi_hive account ──────────────
--
-- Contributions used to be a column on hi_hive, which meant only registered
-- students could earn any. Someone who posts attendance QRs every week but
-- never ran `!test set` scored zero, and the leaderboard quietly under-counted
-- the people doing the most useful thing in the group.
--
-- This holds credit for exactly those people, keyed by their chat account. Only
-- what is needed to recognise and rank them - id, name, number - and nothing
-- resembling credentials, because they have not given any.
--
-- Registered contributors are NOT duplicated here: creditContribution() writes
-- to hi_hive.contributions when the account resolves to a doc, and to this
-- table when it does not. The leaderboard unions the two. Should someone later
-- register or get bound, mergeContributions() folds their tally into hi_hive
-- and removes the row, so nothing is lost and nothing is counted twice.

CREATE TABLE IF NOT EXISTS contributors (
    user_id           TEXT NOT NULL,
    transport         TEXT NOT NULL,
    display_name      TEXT,
    username          TEXT,
    phone_number      TEXT,
    contributions     INTEGER NOT NULL DEFAULT 0,
    first_contributed TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_contributed  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, transport)
);

CREATE INDEX IF NOT EXISTS idx_contributors_count ON contributors (contributions DESC);
