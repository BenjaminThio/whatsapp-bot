# DB Studio

Two views over the bot's data, served by one process:

  /            tables and rows, Firestore-console style, editable
  /directory   groups and people the bots can see, read-only overview

```bash
db
```

from the Termux prompt, or inside the proot:

```bash
bun run studio
```

Then open the printed URL — `http://127.0.0.1:4321` — in the phone's browser.

## Why

The schema lives across six `.sql` files plus a generic JSONB document store,
and after a few weeks away none of it is in your head. This shows what tables
exist, what each column is, every row, and lets you change values in place.

## Layout

Three panes, like the Firestore console:

```
  Tables            Rows                    Fields
  ─────────         ─────────────           ──────────────────
  hi_hive     2  →  2504142            →    doc_id      PK  text
  user_docs   3     60111@s.whats...        student_id      text
  schedules   0                             hidden          boolean
                                            data            jsonb
```

On a phone it shows one pane at a time with a back arrow, so it stays usable in
portrait.

- **Tap a value** to edit it. JSONB opens as pretty-printed JSON.
- **Search** casts the whole row to text, so one box finds anything without you
  knowing which column holds it.
- **Set null** appears on nullable columns; clearing a text box does the same.
- **Delete this row** is at the bottom of the field list, behind a confirm.

## What it will not let you do

- **Edit a primary key.** Changing the thing that identifies a row is a delete
  plus an insert, not an edit, and doing it silently would orphan anything
  referencing it.
- **Edit a table with no primary key at all.** Such rows cannot be addressed
  uniquely, and an `UPDATE` without a unique target can rewrite every row. Those
  tables are read-only here.
- **Reach it from the network.** It binds to `127.0.0.1`. There is no login, so
  `--host 0.0.0.0` hands your whole database to anyone on the same wifi. The
  flag exists for debugging from a laptop; think before using it.

## Notes on correctness

Identifiers cannot be parameterised in SQL, so every table and column name is
checked against the live catalog before being interpolated — an identifier that
is not already in the database never reaches a query. Values always travel as
query parameters.

JSONB values are handed to postgres.js as objects rather than pre-stringified
text. Stringifying and casting with `::jsonb` looks tidier and is wrong:
postgres.js JSON-encodes the string it is given, so the column ends up holding a
JSON *string*. `jsonb_typeof()` reports `"string"`, and every path query against
it returns null.

## Options

```bash
bun run studio --port 5000     # different port
bun run studio --host 0.0.0.0  # reachable from the network - see the warning
```
