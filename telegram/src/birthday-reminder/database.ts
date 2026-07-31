/**
 * database.ts - relasma/src/birthday-reminder/database.ts
 *
 * Birthdays now live in the SAME Postgres table as the WhatsApp bot's, so a
 * birthday saved on one bot is visible to the other. The `transport` column
 * records which platform a chat id belongs to, which is what stops the Telegram
 * scheduler trying to message a WhatsApp jid.
 *
 * The Firestore version stored a `remindYear` that it incremented after wishing
 * someone. That worked, but it also meant the query only matched rows whose
 * remindYear happened to equal the current year, so a bot that was offline on
 * the day silently skipped that person for a whole year. The shared table uses
 * a year-lock instead: match on the date, then skip anyone already wished this
 * year. A late start still delivers.
 */

import sql from "../../../shared/db/index.js";

export const TRANSPORT = "telegram" as const;

export interface BirthdayData {
    name: string;
    day: number;
    month: number;
    /** Birth year, or null when the user didn't give one. */
    year: number | null;
    chatId: number;
}

export interface BirthdayRow extends BirthdayData {
    docId: string;
    /** Last calendar year we wished them, or null. */
    remindYear: number | null;
}

/** "DD/MM" - the shared table's match key. */
const dayMonthKey = (day: number, month: number): string =>
    `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;

function mapRow(r: any): BirthdayRow {
    const [day, month] = String(r.bday_date).split("/").map(Number);
    return {
        docId: r.doc_id,
        name: r.name,
        day: day ?? 0,
        month: month ?? 0,
        year: r.birth_year === null || r.birth_year === undefined ? null : Number(r.birth_year),
        chatId: Number(r.jid),
        remindYear: r.remind_year === null || r.remind_year === undefined ? null : Number(r.remind_year),
    };
}

/**
 * Save a birthday.
 *
 * The doc id is derived from chat + name so re-adding the same person updates
 * them instead of creating a duplicate that fires twice.
 */
export async function createNewBirthday(data: BirthdayData): Promise<string> {
    const docId = `tg:${data.chatId}_${data.name}`.replace(/\s+/g, "_");

    await sql`
        INSERT INTO birthdays (doc_id, name, bday_date, birth_year, jid, remind_year, transport, created_by, updated_at)
        VALUES (${docId}, ${data.name}, ${dayMonthKey(data.day, data.month)}, ${data.year},
                ${String(data.chatId)}, NULL, ${TRANSPORT}, ${String(data.chatId)}, now())
        ON CONFLICT (doc_id) DO UPDATE SET
            name       = EXCLUDED.name,
            bday_date  = EXCLUDED.bday_date,
            birth_year = EXCLUDED.birth_year,
            jid        = EXCLUDED.jid,
            transport  = EXCLUDED.transport,
            updated_at = now()
            -- remind_year is intentionally NOT reset, so editing a name today
            -- cannot make the bot wish the same person twice in one year.
    `;

    return docId;
}

/** Everyone with a birthday today on THIS platform who hasn't been wished yet. */
export async function getTodayBirthdays(): Promise<BirthdayRow[]> {
    const today = new Date();
    const key = dayMonthKey(today.getDate(), today.getMonth() + 1);

    const rows = await sql`
        SELECT * FROM birthdays
        WHERE bday_date = ${key}
          AND transport = ${TRANSPORT}
          AND (remind_year IS NULL OR remind_year <> ${today.getFullYear()})
    `;
    return rows.map(mapRow);
}

/** Mark someone as wished for `year`, so they aren't wished again until next year. */
export async function markWished(docId: string, year: number): Promise<void> {
    await sql`UPDATE birthdays SET remind_year = ${year} WHERE doc_id = ${docId}`;
}

/** Every birthday saved in a chat, soonest first by calendar date. */
export async function birthdaysForChat(chatId: number): Promise<BirthdayRow[]> {
    const rows = await sql`
        SELECT * FROM birthdays
        WHERE jid = ${String(chatId)} AND transport = ${TRANSPORT}
        ORDER BY bday_date
    `;
    return rows.map(mapRow);
}

export async function deleteBirthday(docId: string): Promise<boolean> {
    const res = await sql`DELETE FROM birthdays WHERE doc_id = ${docId}`;
    return res.count > 0;
}
