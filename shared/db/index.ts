/**
 * index.ts - shared/db/index.ts
 *
 * The one Postgres connection both bots use.
 *
 * Everything lives in a single local database. Firestore is deliberately NOT
 * used for core data: it costs reads, needs a network round trip from a phone
 * on mobile data, and made the two bots impossible to keep in sync because each
 * had its own collections. The only surviving cloud dependency is the GitHub
 * webhook relay, which has to be reachable from Vercel.
 */

/*
Loaded here, not left to the entry point.

The connection details live in shared/.env, and anything that touches the
database needs them - the bots, `bun run schema`, the migration script, a
one-off REPL. Importing it at the top of the entry file only works if every
entry file remembers to; importing it here means the credentials are present by
the time this module builds its client, whoever pulled it in.

env.ts never overwrites a value that is already set, so this cannot clobber a
real environment variable or a bot's own .env.
*/
import "../env.js";
import postgres from "postgres";

const sql = process.env["PG_URL"]
  ? postgres(process.env["PG_URL"], { onnotice: () => { } })
  : postgres({
    host: process.env["PGHOST"] ?? "127.0.0.1",
    port: Number(process.env["PGPORT"] ?? 5432),
    user: process.env["PGUSER"] ?? process.env["USER"] ?? "postgres",
    password: process.env["PGPASSWORD"] ?? "",
    database: process.env["PGDATABASE"] ?? "lasma_bot",
    onnotice: () => { },      // silence NOTICE spam
    max: 10,                  // pool size - plenty for two bots on one phone
    idle_timeout: 30,
  });

export default sql;

/*
Every DDL file, in dependency order. All are idempotent
(CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so re-running on every
boot is free.

migrate-docids.sql is deliberately absent - it rewrites existing data and is a
one-off you run by hand.
*/
const SCHEMA_FILES = [
  "schema.sql",
  "scan-buffer-schema.sql",
  "rank-and-meta.sql",
  "outbox-schema.sql",
  "telegram-schema.sql",
  "identity-schema.sql",
];

let ensured = false;

/**
 * Create/upgrade every table. Safe to call from both bots on every boot; the
 * work is only done once per process.
 */
export async function ensureSchema(): Promise<void> {
  if (ensured) return;

  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));

  for (const file of SCHEMA_FILES) {
    const full = path.join(here, file);
    if (!fs.existsSync(full)) {
      console.warn(`🐘 Schema file missing, skipping: ${file}`);
      continue;
    }
    try {
      await sql.unsafe(fs.readFileSync(full, "utf-8"));   // trusted local content
    } catch (err) {
      console.error(`🐘 Failed applying ${file}:`, err);
      throw err;
    }
  }

  ensured = true;
  console.log(`🐘 Postgres schema ensured (${SCHEMA_FILES.length} file(s)).`);
}

/** Is the database reachable? Used by health checks and startup diagnostics. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    console.error("🐘 Postgres unreachable:", err);
    return false;
  }
}
