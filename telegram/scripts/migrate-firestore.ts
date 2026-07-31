/**
 * migrate-firestore.ts - relasma/scripts/migrate-firestore.ts
 *
 * One-off: copy everything out of Firestore into the unified Postgres database.
 *
 *   bun run scripts/migrate-firestore.ts --dry-run     # report, change nothing
 *   bun run scripts/migrate-firestore.ts               # actually write
 *   bun run scripts/migrate-firestore.ts --force       # also overwrite existing rows
 *
 * Safe to run more than once: by default an owner that already has a Postgres
 * row is skipped, so a re-run only picks up what was missed. --force replaces
 * them instead, which is what you want if you migrated, kept playing on
 * Firestore for a bit, and want to re-sync.
 *
 * Nothing in Firestore is deleted. Verify Postgres looks right, then clean up
 * the old collections by hand.
 */

import { collection, getDocs, type DocumentData, type QueryDocumentSnapshot } from "firebase/firestore";
import db from "./firebase-client.js";
import sql, { ensureSchema, pingDatabase } from "../../shared/db/index.js";
import { setSetting } from "../../shared/db/user-store.js";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

interface Stats {
    read: number;
    written: number;
    skipped: number;
    failed: number;
}

const blank = (): Stats => ({ read: 0, written: 0, skipped: 0, failed: 0 });

/** Firestore collection -> user_docs namespace. */
const DOC_COLLECTIONS: { collection: string; namespace: string }[] = [
    { collection: "shop", namespace: "shop" },
    { collection: "snake", namespace: "snake" },
    { collection: "sokoban", namespace: "sokoban" },
    { collection: "calculator", namespace: "calculator" },
    // The Firestore name was camelCase; the namespace matches the new module.
    { collection: "ticTacToe", namespace: "tic_tac_toe" },
];

async function readCollection(name: string): Promise<QueryDocumentSnapshot<DocumentData>[]> {
    const snap = await getDocs(collection(db, name));
    return snap.docs;
}

/**
 * Coordinates are stored as {x, y} in both systems, so the payloads move across
 * untouched. This only strips Firestore's own wrapper types (Timestamp, etc.)
 * which JSONB cannot represent.
 */
function plainify(value: any): any {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(plainify);
    if (typeof value === "object") {
        // Firestore Timestamp -> epoch millis
        if (typeof value.toMillis === "function") return value.toMillis();
        if (typeof value.toDate === "function") return value.toDate().getTime();
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) out[k] = plainify(v);
        return out;
    }
    return value;
}

async function migrateUserDocs(collectionName: string, namespace: string): Promise<Stats> {
    const stats = blank();

    let docs: QueryDocumentSnapshot<DocumentData>[];
    try {
        docs = await readCollection(collectionName);
    } catch (err) {
        console.error(`  ✗ could not read Firestore collection "${collectionName}":`, err);
        return stats;
    }

    for (const doc of docs) {
        stats.read++;
        const ownerId = doc.id;
        const data = plainify(doc.data());

        try {
            if (DRY_RUN) {
                const existing = await sql`
                    SELECT 1 FROM user_docs WHERE namespace = ${namespace} AND owner_id = ${ownerId}
                `;
                if (existing.length > 0 && !FORCE) stats.skipped++;
                else stats.written++;
                continue;
            }

            const result = FORCE
                ? await sql`
                    INSERT INTO user_docs (namespace, owner_id, data)
                    VALUES (${namespace}, ${ownerId}, ${sql.json(data)})
                    ON CONFLICT (namespace, owner_id) DO UPDATE
                    SET data = EXCLUDED.data, updated_at = now()
                    RETURNING owner_id
                `
                : await sql`
                    INSERT INTO user_docs (namespace, owner_id, data)
                    VALUES (${namespace}, ${ownerId}, ${sql.json(data)})
                    ON CONFLICT (namespace, owner_id) DO NOTHING
                    RETURNING owner_id
                `;

            if (result.length > 0) stats.written++;
            else stats.skipped++;
        } catch (err) {
            stats.failed++;
            console.error(`  ✗ ${namespace}/${ownerId}:`, err instanceof Error ? err.message : err);
        }
    }

    return stats;
}

/**
 * Birthdays go into the shared `birthdays` table rather than user_docs, so the
 * WhatsApp bot can see them too.
 *
 * The two schemas mean OPPOSITE things by their year column, so this is the one
 * field that needs real translation rather than a copy:
 *
 *   Firestore `remindYear`  = the year we will NEXT wish them. The query matched
 *                             rows where remindYear == currentYear, sent the
 *                             message, then incremented it.
 *   Postgres  `remind_year` = the last year we DID wish them. The query matches
 *                             on the date and skips anyone already wished this
 *                             year.
 *
 * So remindYear > thisYear means they have been wished through remindYear - 1,
 * and remindYear <= thisYear means this year's wish is still outstanding.
 * Copying the number across unchanged would mark everyone still owed a wish as
 * already done, and silently skip them.
 */
async function migrateBirthdays(): Promise<Stats> {
    const stats = blank();

    let docs: QueryDocumentSnapshot<DocumentData>[];
    try {
        docs = await readCollection("birthday");
    } catch (err) {
        console.error("  ✗ could not read Firestore collection \"birthday\":", err);
        return stats;
    }

    const thisYear = new Date().getFullYear();

    for (const doc of docs) {
        stats.read++;
        const d = doc.data() as {
            name?: string; day?: number; month?: number;
            year?: number; remindYear?: number; chatId?: number;
        };

        if (!d.name || !d.day || !d.month || d.chatId === undefined) {
            stats.failed++;
            console.error(`  ✗ birthday/${doc.id}: missing name, day, month or chatId`);
            continue;
        }

        const docId = `tg:${d.chatId}_${d.name}`.replace(/\s+/g, "_");
        const bdayDate = `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}`;

        // See the note above: "will wish in Y" becomes "last wished in Y - 1".
        const remindYear = typeof d.remindYear === "number" && d.remindYear > thisYear
            ? d.remindYear - 1
            : null;

        /*
        The old /birthday command defaulted a missing year to the current one,
        so a stored year equal to this year almost always means "no year given"
        rather than "born this year".
        */
        const birthYear = typeof d.year === "number" && d.year !== thisYear ? d.year : null;

        try {
            if (DRY_RUN) { stats.written++; continue; }

            const result = FORCE
                ? await sql`
                    INSERT INTO birthdays (doc_id, name, bday_date, birth_year, jid, remind_year, transport, created_by)
                    VALUES (${docId}, ${d.name}, ${bdayDate}, ${birthYear},
                            ${String(d.chatId)}, ${remindYear}, 'telegram', ${String(d.chatId)})
                    ON CONFLICT (doc_id) DO UPDATE SET
                        name = EXCLUDED.name, bday_date = EXCLUDED.bday_date,
                        birth_year = EXCLUDED.birth_year, jid = EXCLUDED.jid,
                        remind_year = EXCLUDED.remind_year, transport = EXCLUDED.transport,
                        updated_at = now()
                    RETURNING doc_id
                `
                : await sql`
                    INSERT INTO birthdays (doc_id, name, bday_date, birth_year, jid, remind_year, transport, created_by)
                    VALUES (${docId}, ${d.name}, ${bdayDate}, ${birthYear},
                            ${String(d.chatId)}, ${remindYear}, 'telegram', ${String(d.chatId)})
                    ON CONFLICT (doc_id) DO NOTHING
                    RETURNING doc_id
                `;

            if (result.length > 0) stats.written++;
            else stats.skipped++;
        } catch (err) {
            stats.failed++;
            console.error(`  ✗ birthday/${doc.id}:`, err instanceof Error ? err.message : err);
        }
    }

    return stats;
}

/** The GitHub report chat id lived in Firestore's temp/report document. */
async function migrateReportChat(): Promise<Stats> {
    const stats = blank();
    try {
        const docs = await readCollection("temp");
        const report = docs.find(d => d.id === "report");
        if (!report) return stats;

        const chatId = (report.data() as { chatId?: number }).chatId;
        if (chatId === undefined || chatId === null) return stats;

        stats.read++;
        if (!DRY_RUN) await setSetting("github_report_chat", { transport: "telegram", chatId });
        stats.written++;
    } catch (err) {
        stats.failed++;
        console.error("  ✗ temp/report:", err instanceof Error ? err.message : err);
    }
    return stats;
}

function report(label: string, s: Stats): void {
    const bits = [`read ${s.read}`, `written ${s.written}`];
    if (s.skipped > 0) bits.push(`skipped ${s.skipped}`);
    if (s.failed > 0) bits.push(`FAILED ${s.failed}`);
    console.log(`  ${s.failed > 0 ? "⚠" : "✓"} ${label.padEnd(14)} ${bits.join(", ")}`);
}

async function main(): Promise<void> {
    console.log(
        `\n🔄 Firestore -> Postgres migration${DRY_RUN ? "  (DRY RUN - nothing will be written)" : ""}` +
        `${FORCE ? "  (FORCE - existing rows will be overwritten)" : ""}\n`
    );

    if (!(await pingDatabase())) {
        console.error("Could not reach Postgres. Check PG_URL / PGHOST etc. and try again.\n");
        process.exit(1);
    }
    await ensureSchema();
    console.log("");

    const totals = blank();
    const add = (s: Stats): void => {
        totals.read += s.read; totals.written += s.written;
        totals.skipped += s.skipped; totals.failed += s.failed;
    };

    for (const { collection: name, namespace } of DOC_COLLECTIONS) {
        const s = await migrateUserDocs(name, namespace);
        report(name, s);
        add(s);
    }

    const bd = await migrateBirthdays();
    report("birthday", bd);
    add(bd);

    const rc = await migrateReportChat();
    report("temp/report", rc);
    add(rc);

    console.log(
        `\n${totals.failed > 0 ? "⚠️" : "✅"} Total: ${totals.read} read, ${totals.written} written, ` +
        `${totals.skipped} skipped, ${totals.failed} failed.`
    );

    if (DRY_RUN) {
        console.log("\nThis was a dry run. Re-run without --dry-run to write.\n");
    } else if (totals.failed === 0) {
        console.log(
            "\nFirestore was NOT modified. Check the data looks right, then you can " +
            "delete the old collections by hand.\n"
        );
    } else {
        console.log("\nSome rows failed - fix the errors above and re-run (already-migrated rows are skipped).\n");
    }

    await sql.end();
    process.exit(totals.failed > 0 ? 1 : 0);
}

await main();
