# Lasma

Two bots, one core.

```
lasma-bot/
├── package.json          workspace root - one node_modules, one bun.lock
├── tsconfig.base.json    compiler settings both projects extend
├── .venv/                one Python environment, shared by both bots
├── shared/               @lasma/shared - database, outbox, hi-hive, assets
├── whatsapp/             Baileys
└── telegram/             grammY
```

Both bots run as separate processes against the same local Postgres. Neither
depends on the other being up.

## Running

```bash
bun install          # once, at the root - installs all three workspaces
bun run schema       # once, creates/upgrades the database
```

Then each bot, in its own terminal:

```bash
bun run whatsapp     # or: cd whatsapp && bun run dev
bun run telegram     # or: cd telegram && bun run dev
```

On Termux, start Postgres first - see `SETUP-TERMUX.md` for a full rebuild
from a blank install.

## Configuration

`shared/.env` holds everything both bots use - the AI keys, the UTAR endpoints,
OpenWeather, and the Postgres connection. It is loaded automatically and never
overwrites a value that is already set, so precedence is:

1. the real environment (`export FOO=...`)
2. the bot's own `.env`
3. `shared/.env`

Bot-specific keys stay local: `BOT_TOKEN` in `telegram/.env` (plus the
`FIREBASE_*` block the one-off Firestore migration needs). The WhatsApp bot has
no `.env` of its own - everything it reads is shared.

## Why one workspace

Every dependency used to be installed up to three times - `@google/genai` in all
three projects, `postgres` and `zxing-wasm` twice, plus three lockfiles that
could drift to different versions of the same library. Bun workspaces hoist all
of it into one `node_modules` at the root: 557 MB across three trees became
349 MB in one, and there is a single lockfile to reason about.

Imports across projects stay relative (`../../shared/lib/x.js`). Node resolution
walks up from the importing file, so a module in `shared/` finds its
dependencies in the root `node_modules` without any path aliases.

## Python

One `.venv` at the root, found by `shared/lib/subprocess.ts` regardless of which
bot is running. Set `PYTHON_BIN` to override it.

Termux has no venv - the engines run through the system `python3` against the
`.py` sources directly, which is the same code path, just a different
interpreter.

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Windows
.venv/bin/pip install -r requirements.txt         # Linux
```

## Assets

`shared/assets/` holds what both bots read at runtime:

| | |
| --- | --- |
| `data/emoji.jsonl` | 60 MB emoji dataset; `emoji.index.json` beside it is generated |
| `dict/dict.dat`, `dict.idx` | ~680 MB Wiktionary index |
| `dict/src/` | the C that builds that index |
| `engines/*.py` | gTTS, rembg, denoise, yt-dlp helpers |

Point `ASSETS_DIR` elsewhere if you keep them outside the repo.

**Rebuilding the dictionary index.** The raw
`enwiktionary-latest-pages-articles.xml` dump is not kept in the repo - it is
11 GB and only ever an input. Download it from
[dumps.wikimedia.org](https://dumps.wikimedia.org/enwiktionary/latest/) and run
`dict/src/dict_indexer.c` against it to regenerate `dict.dat` and `dict.idx`.

## Layout

| Path | What |
| --- | --- |
| `shared/db/` | Postgres client, schema, per-user document store |
| `shared/messaging/` | the transport-agnostic durable outbox |
| `shared/hi-hive/` | UTAR attendance: scanning, credentials, timetables |
| `shared/lib/` | emoji index, dict worker, AI, TTS, QR, HTTP, concurrency |
| `shared/webhook/` | GitHub webhooks (the one Firestore user) |
| `whatsapp/src/commands/` | one file per `!command` |
| `telegram/src/<feature>/` | one folder per `/command` group |

See `shared/README.md` for the database, outbox and performance notes.
