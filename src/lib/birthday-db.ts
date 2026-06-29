/**
 * birthday-db.ts — Postgres data access for the birthday feature.
 * Was: Firestore collection "birthdays".
 *
 * Matches the real fields used by birthday.ts:
 *   name, date ("DD/MM"), birthYear (number|null), jid, remindYear (number|null)
 * doc id was `${jid}_${name}` with spaces → underscores; we keep that as the PK.
 */

import sql from "../db/index.js";

export interface BirthdayRow {
  docId:      string;        // `${jid}_${name}` (spaces→_)
  name:       string;
  date:       string;        // "DD/MM" — what the scheduler matches on
  birthYear:  number | null; // null if user omitted the year
  jid:        string;        // chat to announce in
  remindYear: number | null; // last year we wished them (year-lock)
}

function mapRow(r: any): BirthdayRow {
  return {
    docId:      r.doc_id,
    name:       r.name,
    date:       r.bday_date,
    birthYear:  r.birth_year !== null && r.birth_year !== undefined ? Number(r.birth_year) : null,
    jid:        r.jid,
    remindYear: r.remind_year !== null && r.remind_year !== undefined ? Number(r.remind_year) : null,
  };
}

/** All birthdays whose "DD/MM" matches today (used by the scheduler). */
export async function birthdaysOnDate(ddmm: string): Promise<BirthdayRow[]> {
  const rows = await sql`SELECT * FROM birthdays WHERE bday_date = ${ddmm}`;
  return rows.map(mapRow);
}

/** Upsert a birthday (Firestore set({merge:true}) on doc id). */
export async function saveBirthday(b: {
  docId: string; name: string; date: string; birthYear: number | null; jid: string;
}): Promise<void> {
  await sql`
    INSERT INTO birthdays (doc_id, name, bday_date, birth_year, jid, remind_year, updated_at)
    VALUES (${b.docId}, ${b.name}, ${b.date}, ${b.birthYear}, ${b.jid}, NULL, now())
    ON CONFLICT (doc_id) DO UPDATE SET
      name       = EXCLUDED.name,
      bday_date  = EXCLUDED.bday_date,
      birth_year = EXCLUDED.birth_year,
      jid        = EXCLUDED.jid,
      updated_at = now()
      -- NB: remind_year is intentionally NOT overwritten on merge
  `;
}

/** Mark a birthday as wished for `year` (the year-lock). */
export async function setRemindYear(docId: string, year: number): Promise<void> {
  await sql`UPDATE birthdays SET remind_year = ${year} WHERE doc_id = ${docId}`;
}

/** All birthdays (for a potential !birthday list). */
export async function allBirthdays(): Promise<BirthdayRow[]> {
  const rows = await sql`SELECT * FROM birthdays`;
  return rows.map(mapRow);
}

/** Delete a birthday by doc id. */
export async function deleteBirthday(docId: string): Promise<boolean> {
  const res = await sql`DELETE FROM birthdays WHERE doc_id = ${docId}`;
  return res.count > 0;
}