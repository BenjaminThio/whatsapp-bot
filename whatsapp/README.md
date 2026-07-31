# whatsapp-bot

A WhatsApp bot (Lasma), built on Baileys and run 24/7 from Termux.

## Command prefixes

Prefixes are configurable. The **first** entry is the "primary" one - the one the
bot uses whenever it prints a command back at you (help, usage hints, errors).
All of them are accepted as input.

```
COMMAND_PREFIXES="!,/"
```

Defaults to `!,/`, so `!scan` and `/scan` both work out of the box.

## Skipping the QR auto-scanner

Every image that lands in a chat is inspected for an attendance QR. To share one
without submitting it, put the directive anywhere in the image caption:

```
!ignore
/ignore              any configured prefix works
here you go !ignore
```

The bot reacts 🚫 to confirm it left the image alone. A bare word (`ignore`
without a prefix) does **not** suppress a scan, so ordinary chatter can never
silently kill a real one.

```
SCAN_IGNORE_WORDS="ignore,noscan,skip"
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMMAND_PREFIXES` | `!,/` | Accepted command prefixes, first is primary |
| `SCAN_IGNORE_WORDS` | `ignore,noscan,skip` | Words that opt an image out of auto-scanning |
| `OUTBOX_TICK_MS` | `3000` | How often the outbox drains |
| `OUTBOX_MAX_BYTES` | `25165824` | Largest message that may be persisted for retry |
| `IMAGE_CATCHUP_SEC` | `7200` | How far back to catch up on images after a reconnect |
| `SCAN_BUFFER_TICK_MS` | `500` | Auto-scan queue resolution |
| `AUTOSCAN_MIN_DELAY_SEC` / `AUTOSCAN_MAX_DELAY_SEC` | `0` / `5` | Random spread applied to auto-scans |
| `PM_FILTER_PARTICIPANTS` | on | Set `0` to show every student in private-chat reports |
| `PG_URL` or `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` | localhost / `lasma_bot` | Postgres connection |

Plus the feature keys: `AI_API_KEY`, `OPEN_WEATHER_API_KEY`,
`ATTENDANCE_QR_SCAN_API_DOMAIN`, `UTAR_SCAN_URL`, `UTAR_REPORT_URL`,
`VERCEL_WEBHOOK_URL`.

## Architecture notes

### Outbox (`src/lib/outbox.ts`)

Nothing calls `sock.sendMessage()` directly. Every outbound message is handed to
the outbox, which sends inline when the socket is up and persists to Postgres
when it isn't, retrying with exponential backoff until it lands. Any Baileys
content shape works - text, images, documents, audio, video, polls - and Buffers
inside the content are encoded so a half-sent video survives a restart.

```ts
await ctx.replyText("done");                       // quotes the user's message
await ctx.reply({ image: buf, caption: "..." });
await queueText(jid, "reminder", { priority: 1 }); // from a background service
```

`reactNow()` is the exception: reactions are cosmetic, so they are attempted
once and dropped if the socket is down.

### Command context (`src/lib/command-context.ts`)

Handlers receive a parsed `ctx` rather than slicing the raw text themselves:

```ts
ctx.match        // everything after the command word
ctx.args         // match split on whitespace
ctx.quotedArgs   // shell-style, keeps "quoted phrases" together
ctx.sub          // args[0] lowercased, for subcommand switches
ctx.chatId / ctx.userId / ctx.isGroup
ctx.reply() / ctx.replyText() / ctx.send() / ctx.react() / ctx.sendUsage()
```

Set `requiresArgs: true` on a command and the dispatcher rejects an empty
invocation with `usageHint ?? usage` before the handler ever runs.

### Schema

`ensureSchema()` applies every DDL file in `src/db/` (all idempotent) on boot, so
a fresh clone creates its own tables. `migrate-docids.sql` is excluded - it
rewrites data and is a one-off you run by hand.
