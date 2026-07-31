/**
 * apply-schema.ts - shared/db/apply-schema.ts
 *
 * Create or upgrade every table, then exit. Both bots also call ensureSchema()
 * on boot, so this is mainly for setting a machine up before the first run, or
 * for applying new DDL without restarting a live bot.
 *
 *   bun run shared/db/apply-schema.ts
 */

import sql, { ensureSchema, pingDatabase } from "./index.js";

async function main(): Promise<void> {
    if (!(await pingDatabase())) {
        console.error(
            "\nCould not reach Postgres. Check PG_URL, or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.\n" +
            "Inside the Ubuntu proot, start it with:\n" +
            "  su postgres -c \"/usr/lib/postgresql/*/bin/pg_ctl -D /var/lib/postgresql/data start\"\n"
        );
        process.exit(1);
    }

    await ensureSchema();

    const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
    `;

    console.log(`\nTables in ${process.env["PGDATABASE"] ?? "lasma_bot"}:`);
    for (const t of tables) console.log(`  - ${t.table_name}`);
    console.log("");

    await sql.end();
}

await main();
