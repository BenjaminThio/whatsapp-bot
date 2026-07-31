# @lasma/shared

Code and data shared by the two Lasma bots:

```
lasma-bot/
  shared/         <- this package: one database, one outbox
  whatsapp/       <- Baileys, imports ../shared/...
  telegram/       <- grammY,  imports ../shared/...
```

One workspace: dependencies are hoisted to a single `node_modules` at the root,
but each bot still runs as its own process with its own start command.

## One database

Everything lives in a single local Postgres database. Firestore is no longer
used for core data — it cost reads, needed a network round trip from a phone on
mobile data, and gave each bot its own private collections, which is what made
them impossible to keep in sync.

The only surviving cloud dependency is the GitHub webhook relay
(`telegram/api/github.ts`), which has to be reachable from Vercel.

Connection comes from `PG_URL`, or `PGHOST` / `PGPORT` / `PGUSER` /
`PGPASSWORD` / `PGDATABASE` — set once in `shared/.env` (see below).

Create or upgrade every table:

```bash
bun run shared/db/apply-schema.ts
```

Both bots also call `ensureSchema()` on boot, so this is only needed when
setting up a new machine or applying new DDL without a restart.

### Per-user documents

The Telegram bot had six database modules — shop, snake, sokoban, calculator,
tic-tac-toe, birthday — and five were the same file with the nouns swapped. They
are one table now (`user_docs`), reached through a typed handle:

```ts
const snake = userStore<SnakeGameData>("snake", codec);

await snake.set(userId, data);
const game = await snake.get(userId);          // T | null, honestly typed
await snake.setField(userId, "foodCoord", c);
await snake.mutate(userId, cur => ({ ...cur!, score: cur!.score + 1 }));
```

`codec` converts between stored JSON and richer runtime objects — that is how
`Coord` instances survive the round trip, replacing Firestore's
`FirestoreDataConverter`.

`mutate()` holds a row lock for a read-modify-write, which is what stops two
inline-button taps double-spending diamonds.

## One outbox

Neither bot calls its send API directly. Every outbound message goes to the
shared outbox, which sends inline when the connection is up and persists to
Postgres when it isn't, retrying with backoff until it lands.

```ts
await sendText("telegram", chatId, "your reminder", { priority: 1 });
await send("whatsapp", jid, { kind: "image", media: buf, caption: "..." });
```

A queued row remembers which transport owes it, so the WhatsApp drain never
tries to deliver a Telegram reminder, and a bot that is offline simply leaves
its own rows alone while the other keeps working.

Each bot registers its transport at startup:

```ts
registerTransport(whatsappTransport);   // whatsapp/src/transport.ts
registerTransport(telegramTransport);   // telegram/src/transport.ts
```

Messages are described in platform-neutral terms (`text`, `image`, `video`,
`audio`, `document`, `sticker`, `poll`, `reaction`) so shared code can reach
either bot. A WhatsApp-only command can still pass raw Baileys content through
as a `native` message — that is what `whatsapp/src/lib/outbox.ts` does, so
every existing WhatsApp call site kept working unchanged.

Reactions are cosmetic: attempted once, never queued, never retried.

## Migrating off Firestore

```bash
cd telegram
bun run scripts/migrate-firestore.ts --dry-run   # report, change nothing
bun run scripts/migrate-firestore.ts             # write
bun run scripts/migrate-firestore.ts --force     # also overwrite existing rows
```

Idempotent and non-destructive: Firestore is never modified, and an owner who
already has a Postgres row is skipped unless you pass `--force`.

One field genuinely needed translating rather than copying. Firestore's
`remindYear` meant *the year we will next wish them*; the shared `remind_year`
means *the last year we did*. Copying the number across would have marked
everyone still owed a birthday wish as already done.

## One set of secrets

`shared/.env` holds the values BOTH bots use - the AI providers, the UTAR
endpoints, the AES material, OpenWeather, the webhook relay URL and the Postgres
connection. `shared/env.ts` loads it on import and **never overwrites** anything
already set, so precedence is:

1. the real environment (`export FOO=...`, or Termux's own)
2. the bot's own `.env`, which Bun loads from the working directory
3. `shared/.env`

Bot-specific keys stay where they belong: `BOT_TOKEN`, `BASE_URL` and
and `BASE_URL` in `telegram/.env`, the Baileys pairing number with `whatsapp`.
Rotating a shared key is now a one-file job instead of two that drift.

It is gitignored, like every other `.env`.

## Performance notes

Things that were measured and changed, in case they get "simplified" back:

**Emoji lookup** (`lib/emoji-db.ts`). The dataset is 60 MB of JSONL, almost all
of it per-platform artwork URLs. Telegram used to stream the whole file and
substring-match every line on every command (11 ms near the top, 107 ms near the
bottom); WhatsApp parsed all 5,225 entries into Maps (383 ms stall, 66 MB of
heap held for the process lifetime, on a phone).

Now a byte-offset index is built once and cached next to the data. Only the
searchable fields stay in memory; the entry itself is one positioned read.

| | Before | After |
| --- | --- | --- |
| Exact lookup | 11–107 ms | **0.17 ms** |
| Cold start | 383 ms | **53 ms** |
| Heap | 66 MB | **7–10 MB** |

The index stores byte offsets computed from raw bytes, *not* from readline. That
matters: readline strips the terminator, so reconstructing an offset means
guessing `\n` vs `\r\n`, and guessing wrong drifts one byte per line and
silently corrupts everything after the first entry. The test suite samples 142
entries across the file to catch exactly that.

**Scan buffer drain** (`hi-hive/scan-buffer-service.ts`). A fixed 500 ms poll is
172,800 queries a day, essentially all returning nothing — the queue is empty
except for a minute or two after someone posts a QR. It now asks the database
when the next job is due and sleeps that long, clamped between `TICK_MS` and
`SCAN_BUFFER_IDLE_MS` (15 s) so a job queued by the *other* bot is still picked
up. Precision when work exists is unchanged.

**Image encoding.** Both renderers switched from PNG to JPEG, for the same
reason: WhatsApp and Telegram both re-encode photos to JPEG on receipt, so a
lossless PNG spends the extra time on pixels nobody receives. The chess board
went 13.1 ms → 5.8 ms; the timetable dropped `compressionLevel: 9`, which is the
worst possible setting for large flat blocks of colour.

**Dictionary** (`lib/dict.ts`). Telegram spawned a fresh `dict_lookup` per
command — a fork, an exec and re-opening a 480 MB index every time. Both bots
now share one lazily-started worker that restarts on death and idles out after
five minutes.

**Portal fetches** (`lib/concurrency.ts`). `findIsolatedSessions` compares one
student's timetable against every other registered account, and each comparison
is a live HTTP request. It ran them one after another: ten accounts at a second
each is ten seconds of a command doing nothing. `mapLimit` runs them four at a
time — nearly all the speedup without opening ten sockets at once on a phone or
looking like a scraper to the portal. Tune with `PORTAL_CONCURRENCY`.

**Credentials** (`hi-hive/creds.ts`). `getAllDocs()` reads the whole table and
sits on the auto-scan path, so every QR re-queried it. It is cached now,
invalidated by every write in the module rather than on a timer — a newly
registered student must be picked up by the *next* scan, not 30 seconds later. A
short TTL sits on top only because the other bot writes to the same table from a
different process. Tune with `CREDS_CACHE_MS`.

**AI history size guard** (`lib/ai-memory.ts`). The 800 KB cap was measured with
`.length`, which counts UTF-16 code units — a conversation in Chinese or full of
emoji was undercounted by up to 3x and sailed past the limit it existed to
enforce. It counts bytes now, and trims repeatedly rather than once, because a
single huge turn could leave the row oversized after one halving.

## Layout

| Path | What |
| --- | --- |
| `db/index.ts` | the Postgres client and `ensureSchema()` |
| `db/*.sql` | all DDL, idempotent, applied in order |
| `db/user-store.ts` | generic per-user JSON documents + global settings |
| `db/apply-schema.ts` | set up or upgrade a machine |
| `messaging/types.ts` | the neutral message model and `Transport` interface |
| `messaging/outbox.ts` | durable queue, retry policy, drain service |
| `env.ts` | loads `shared/.env` without clobbering local values |
| `assets/` | engine binaries, dict index, emoji dataset (`ASSETS_DIR` to relocate) |
| `lib/emoji-db.ts` | indexed emoji lookup over the 60 MB dataset |
| `lib/dict.ts` | shared long-lived `dict_lookup` worker |
| `lib/concurrency.ts` | bounded-parallelism `mapLimit` for portal fetches |
| `hi-hive/` | UTAR attendance: scanning, credentials, timetables, reports |
| `webhook/` | GitHub webhook registry and queue (the one Firestore user) |

`assets/data/emoji.index.json` is generated on first use and rebuilt whenever
the source dataset's size or mtime changes. It is safe to delete.
