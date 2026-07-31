/**
 * local.ts - relasma/src/local.ts
 *
 * Long-polling entry point (the one you run on Termux).
 *
 * Startup order matters:
 *   1. Postgres schema, so no feature hits a missing table
 *   2. Feature modules, so their commands are registered before polling starts
 *   3. Transport + outbox, so anything queued while the bot was down goes out
 */

import { bot } from "./bot.js";
import { remindBirthday } from "./birthday-reminder/index.js";
import { registerModules } from "./modules.js";
import { ensureSchema, pingDatabase } from "../../shared/db/index.js";
import {
    registerTransport, startOutboxService, flushOutbox, purgeProcessed,
} from "../../shared/messaging/outbox.js";
import { telegramTransport, setBotRunning } from "./transport.js";
import { startScheduleService } from "./reminder/index.js";
import { startWebhookQueue } from "../../shared/webhook/webhook-queue.js";

const BIRTHDAY_CHECK_MS = 60_000;
const PROCESSED_PURGE_MS = 6 * 3_600_000;

async function main(): Promise<void> {
    if (!(await pingDatabase())) {
        console.error(
            "🐘 Postgres is unreachable. Set PG_URL (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE) in .env.\n" +
            "   On Termux:  pg_ctl -D $PREFIX/var/lib/postgresql start"
        );
        process.exit(1);
    }

    try {
        await ensureSchema();
    } catch (err) {
        console.error("🐘 Could not ensure the Postgres schema:", err);
        process.exit(1);
    }

    const { loaded, failed } = await registerModules(c => bot.use(c));
    console.log(
        `📦 Modules loaded: ${loaded}` + (failed.length > 0 ? ` (skipped: ${failed.join(", ")})` : "")
    );

    registerTransport(telegramTransport);

    /*
    Birthday sweep. It runs once a minute rather than once a second: the old
    interval fired 86,400 database queries a day to answer a question whose
    answer changes at most once a day, and the year-lock means a late check
    still delivers.
    */
    setInterval(() => { void remindBirthday(); }, BIRTHDAY_CHECK_MS);
    setInterval(() => { void purgeProcessed(); }, PROCESSED_PURGE_MS);

    bot.catch((err) => {
        // grammY would otherwise reject the update and retry it forever
        console.error("💥 Unhandled bot error:", err.error);
    });

    /*
    bot.start() only resolves when the bot stops, so everything that must happen
    once polling is live is hooked to onStart instead of awaited after it.
    */
    await bot.start({
        onStart: (info) => {
            console.log(`🟢 @${info.username} is online.`);
            setBotRunning(true);
            startOutboxService();
            void flushOutbox("telegram");   // deliver anything queued while offline
            void remindBirthday();          // catch up on today's birthdays
            startScheduleService();         // arms reminders, incl. any missed
            try {
                startWebhookQueue();
            } catch (err) {
                // Firestore credentials are optional - the rest of the bot works without them
                console.warn("🪝 GitHub webhook queue not started:", err instanceof Error ? err.message : err);
            }
        },
    });
}

const shutdown = (signal: string): void => {
    console.log(`\n${signal} received - stopping.`);
    setBotRunning(false);
    void bot.stop();
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await main();
