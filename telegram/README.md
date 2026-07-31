# telegram

The Telegram half of Lasma. The WhatsApp half is `../whatsapp`; code and
data they share live in `../shared` (see its README).

## Running

```bash
bun install
bun run dev          # long polling, watch mode
```

Postgres must be reachable first. On Termux:

```bash
pg_ctl -D $PREFIX/var/lib/postgresql start
```

The bot refuses to start if it cannot reach the database, rather than coming up
and failing on the first command.

## Environment

Anything both bots use lives in `../shared/.env` and is loaded automatically —
the AI keys, the UTAR endpoints, OpenWeather, the webhook URL and the Postgres
connection. A value in this bot's own `.env` always wins over the shared one.

Only these are specific to this bot:

| Variable | Purpose |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token |
| `BASE_URL` | Vercel deployment URL |
| `YT_COOKIES` | `/play` |
| `FIREBASE_*` | only the migration script (the client SDK reading old data) |

## Database

All state is in the shared local Postgres database — the same one the WhatsApp
bot uses. Nothing about the games or the shop changed; the six Firestore modules
became thin wrappers over `shared/db/user-store.ts`, keeping their original
function names.

Birthdays now live in the shared `birthdays` table with a `transport` column, so
a birthday saved here and one saved on WhatsApp sit side by side.

First-time setup, or after pulling new DDL:

```bash
bun run schema
```

Coming from the old Firestore setup:

```bash
bun run migrate:firestore -- --dry-run
bun run migrate:firestore
```

## Sending messages

Background senders (birthday wishes, reminders) go through the shared outbox
rather than `bot.api.sendMessage`, so a wish composed while Telegram is
unreachable is queued and retried instead of lost:

```ts
await sendText("telegram", String(chatId), "🎂 ...", { priority: 2, format: "html" });
```

Replies inside a command handler can still use `ctx.reply` — those are
immediate, and the user is right there.

## Module loading

Every directory under `src/` that default-exports a grammY `Composer` is loaded
automatically at startup. A module that throws while loading is reported and
skipped; it no longer takes the whole bot down with it. `src/pixelforge` is
skipped by name — it is a native-addon sandbox, not a feature.

`chess` needs its compiled addon (`src/pixelforge/build/Release/App.node`); if it
is missing you will see one skipped module at startup and the other features
will run normally.

## Commands

Ported from the WhatsApp bot — same shared implementations, so behaviour and
data match on both sides:

| | |
| --- | --- |
| `/attendance [course]` | UTAR attendance report |
| `/scan [raw_qr]` | submit a QR to mark attendance |
| `/decode [raw_qr]` | inspect a QR offline, no server call |
| `/genqr <type> <args…>` | build an encrypted attendance QR |
| `/refresh` | re-login for a fresh sessionId |
| `/hihive <sub>` | credentials, whitelist, timetables, rankings |
| `/schedule` | one-shot and escalating reminders |
| `/query`, `/imagine` | AI chat and image generation |
| `/dict`, `/search` | Wiktionary lookup, Bing image search |
| `/convert`, `/denoise`, `/removebg` | media tools |
| `/lang`, `/say` | voice language and text-to-speech |
| `/weather`, `/temp` | OpenWeather |
| `/birthday`, `/play`, `/emojipedia` | as before |
| `/webhook`, `/report` | GitHub notifications |
| `/help`, `/debug` | command list, service health |

Photos posted in a chat are auto-scanned for attendance QRs. Caption an image
`/ignore` (or `!ignore`) to opt it out.

## Telegram-exclusive features

`shop`, `snake`, `sokoban`, `chess`, `calculator`, `tic-tac-toe` and `delete`
have no WhatsApp equivalent and are not part of the cross-bot sync.
