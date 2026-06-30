import postgres from "postgres";

const sql = process.env.PG_URL
  ? postgres(process.env.PG_URL, { onnotice: () => {} })
  : postgres({
      host:     process.env.PGHOST     ?? "127.0.0.1",
      port:     Number(process.env.PGPORT ?? 5432),
      user:     process.env.PGUSER     ?? process.env.USER ?? "postgres",
      password: process.env.PGPASSWORD ?? "",
      database: process.env.PGDATABASE ?? "lasma_bot",
      onnotice: () => {},          // silence NOTICE spam
      max:      10,                // pool size - plenty for a single-phone bot
      idle_timeout: 30,
    });

export default sql;

/**
 * Run the schema file on startup so fresh installs auto-create tables.
 * Call once from index.ts before the bot connects (optional but convenient).
 */
export async function ensureSchema(): Promise<void> {
  const fs   = await import("fs");
  const path = await import("path");
  const url  = await import("url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const schemaPath = path.join(here, "schema.sql");
  const ddl = fs.readFileSync(schemaPath, "utf-8");
  await sql.unsafe(ddl);          // schema.sql is trusted local content
  console.log("🐘 Postgres schema ensured.");
}