// Postgres data access for reminders.

import crypto from "crypto";
import sql from "../db/index.js";

export type ScheduleTransport = "whatsapp" | "telegram";

export interface ScheduleRow {
  /** Which bot owns this chat id. Absent on rows written before the two bots shared a database. */
  transport?: ScheduleTransport;
  id:             string;
  jid:            string;
  activity:       string;
  fireAt:         number;       // epoch ms
  requester:      string;
  fired:          boolean;
  groupId:        string | null;
  deadlineAt:     number | null;
  milestoneLabel: string | null;
}

// Firestore generated 20-char auto-ids; we generate similar app-side so the
// existing id.slice(0,6) short-id UX is unchanged.
export function newId(): string {
  return crypto.randomBytes(12).toString("base64url"); // 16 url-safe chars
}

// Map a DB row (snake_case, bigint→string) into the camelCase shape code expects
function mapRow(r: any): ScheduleRow {
  return {
    id:             r.id,
    jid:            r.jid,
    activity:       r.activity,
    fireAt:         Number(r.fire_at),
    requester:      r.requester,
    fired:          r.fired,
    groupId:        r.group_id ?? null,
    deadlineAt:     r.deadline_at !== null && r.deadline_at !== undefined ? Number(r.deadline_at) : null,
    milestoneLabel: r.milestone_label ?? null,
    transport:      r.transport ?? "whatsapp",
  };
}

// Unfired reminders due at/before `beforeMs`.
export async function dueReminders(
  beforeMs: number,
  transport?: ScheduleTransport
): Promise<ScheduleRow[]> {
  /*
  Scoped by transport so each bot only arms its own rows. Without it the
  Telegram poller would try to deliver a WhatsApp reminder to a chat id that
  does not exist on Telegram, burn its retries, and drop it.
  */
  const rows = transport
    ? await sql`
        SELECT * FROM schedules
        WHERE fired = FALSE AND fire_at <= ${beforeMs} AND transport = ${transport}
      `
    : await sql`
        SELECT * FROM schedules
        WHERE fired = FALSE AND fire_at <= ${beforeMs}
      `;
  return rows.map(mapRow);
}

// All pending (unfired) reminders for a chat.
export async function pendingForChat(
  jid: string,
  transport?: ScheduleTransport
): Promise<ScheduleRow[]> {
  const rows = transport
    ? await sql`SELECT * FROM schedules WHERE jid = ${jid} AND fired = FALSE AND transport = ${transport} ORDER BY fire_at`
    : await sql`SELECT * FROM schedules WHERE jid = ${jid} AND fired = FALSE ORDER BY fire_at`;
  return rows.map(mapRow);
}

// Count pending reminders for a chat (for the per-chat cap).
export async function pendingCount(
  jid: string,
  transport?: ScheduleTransport
): Promise<number> {
  const rows = transport
    ? await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM schedules WHERE jid = ${jid} AND fired = FALSE AND transport = ${transport}`
    : await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM schedules WHERE jid = ${jid} AND fired = FALSE`;
  return Number(rows[0]?.n ?? 0);
}

// Mark a single reminder fired.
export async function markFired(id: string): Promise<void> {
  await sql`UPDATE schedules SET fired = TRUE WHERE id = ${id}`;
}

// Insert one reminder.
export async function insertReminder(r: ScheduleRow): Promise<void> {
  await sql`
    INSERT INTO schedules
      (id, jid, activity, fire_at, requester, fired, group_id, deadline_at, milestone_label, transport, created_at)
    VALUES
      (${r.id}, ${r.jid}, ${r.activity}, ${r.fireAt}, ${r.requester}, ${r.fired},
       ${r.groupId}, ${r.deadlineAt}, ${r.milestoneLabel}, ${r.transport ?? "whatsapp"}, now())
  `;
}

// Insert many reminders in one transaction (escalation milestones).
export async function insertMany(rows: ScheduleRow[]): Promise<void> {
  await sql.begin(async (tx: any) => {
    for (const r of rows) {
      await tx`
        INSERT INTO schedules
          (id, jid, activity, fire_at, requester, fired, group_id, deadline_at, milestone_label, transport, created_at)
        VALUES
          (${r.id}, ${r.jid}, ${r.activity}, ${r.fireAt}, ${r.requester}, ${r.fired},
           ${r.groupId}, ${r.deadlineAt}, ${r.milestoneLabel}, ${r.transport ?? "whatsapp"}, now())
      `;
    }
  });
}