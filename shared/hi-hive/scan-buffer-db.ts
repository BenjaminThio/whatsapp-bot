/**
 * scan-buffer-db.ts — src/lib/hi-hive/scan-buffer-db.ts
 *
 * Postgres-backed auto-scan queue. Replaces the old in-memory array so pending
 * scans survive a crash/restart: on startup the service re-reads whatever is
 * still `pending` and runs anything already overdue.
 */

import crypto from "crypto";
import sql from "../db/index.js";

export interface BufferRow {
  id:           string;
  batchId:      string;
  docId:        string;
  studentId:    string;          // real id — labels may be masked for hidden creds
  label:        string;
  rawQr:        string;
  chatId:       string;
  quotedKey:    any | null;
  destinations: any[] | null;    // resolved report destinations for this batch
  originSilent: boolean;         // true = origin chat gets ❤️ only, no messages
  scannedBy:    string;          // display label of whoever supplied the QR
  courseCode:   string | null;   // course on the QR, for the report header
  dueAt:        number;
  status:       "pending" | "done";
  resultStatus: string | null;
}

export const newId = () => crypto.randomBytes(12).toString("base64url");

const map = (r: any): BufferRow => ({
  id: r.id, batchId: r.batch_id, docId: r.doc_id,
  studentId: r.student_id ?? r.label, label: r.label,
  rawQr: r.raw_qr, chatId: r.chat_id, quotedKey: r.quoted_key ?? null,
  destinations: r.destinations ?? null,
  originSilent: r.origin_silent ?? false,
  scannedBy: r.scanned_by ?? "Unknown User",
  courseCode: r.course_code ?? null,
  dueAt: Number(r.due_at), status: r.status,
  resultStatus: r.result_status ?? null,
});

/** Insert a whole batch of jobs in one transaction. */
export async function enqueueBatch(rows: Omit<BufferRow, "status" | "resultStatus">[]): Promise<void> {
  await sql.begin(async (tx: any) => {
    for (const r of rows) {
      await tx`
        INSERT INTO scan_buffer
          (id, batch_id, doc_id, student_id, label, raw_qr, chat_id,
           quoted_key, destinations, origin_silent, scanned_by, course_code, due_at, status)
        VALUES
          (${r.id}, ${r.batchId}, ${r.docId}, ${r.studentId}, ${r.label}, ${r.rawQr},
           ${r.chatId}, ${r.quotedKey ? sql.json(r.quotedKey) : null},
           ${r.destinations ? sql.json(r.destinations as any) : null},
           ${r.originSilent ?? false}, ${r.scannedBy ?? "Unknown User"},
           ${r.courseCode ?? null}, ${r.dueAt}, 'pending')
      `;
    }
  });
}

/** Pending jobs whose time has come (includes anything overdue after downtime). */
export async function dueJobs(nowMs: number = Date.now()): Promise<BufferRow[]> {
  const rows = await sql`
    SELECT * FROM scan_buffer
    WHERE status = 'pending' AND due_at <= ${nowMs}
    ORDER BY due_at ASC
    LIMIT 25
  `;
  return rows.map(map);
}

/** Mark one job finished with its outcome. */
export async function markDone(id: string, resultStatus: string): Promise<void> {
  await sql`
    UPDATE scan_buffer
    SET status = 'done', result_status = ${resultStatus}
    WHERE id = ${id}
  `;
}

/** Are all jobs in this batch finished? */
export async function batchPendingCount(batchId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM scan_buffer
    WHERE batch_id = ${batchId} AND status = 'pending'
  `;
  return Number(rows[0]?.n ?? 0);
}

/** All rows of a batch (for building the final report). */
export async function batchRows(batchId: string): Promise<BufferRow[]> {
  const rows = await sql`
    SELECT * FROM scan_buffer WHERE batch_id = ${batchId} ORDER BY due_at ASC
  `;
  return rows.map(map);
}

/** Delete a finished batch once its report has been sent. */
export async function deleteBatch(batchId: string): Promise<void> {
  await sql`DELETE FROM scan_buffer WHERE batch_id = ${batchId}`;
}

/** Housekeeping: drop anything older than 24h so the table can't grow forever. */
export async function purgeStale(): Promise<number> {
  const res = await sql`
    DELETE FROM scan_buffer WHERE created_at < now() - interval '24 hours'
  `;
  return res.count ?? 0;
}

// ─── Group whitelist ──────────────────────────────────────────────────────────

export async function isWhitelisted(jid: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM whitelisted_groups WHERE jid = ${jid} LIMIT 1`;
  return rows.length > 0;
}

export async function addWhitelist(jid: string, addedBy: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO whitelisted_groups (jid, added_by) VALUES (${jid}, ${addedBy})
    ON CONFLICT (jid) DO NOTHING
    RETURNING jid
  `;
  return rows.length > 0;   // false = already whitelisted
}

export async function removeWhitelist(jid: string): Promise<boolean> {
  const res = await sql`DELETE FROM whitelisted_groups WHERE jid = ${jid}`;
  return (res.count ?? 0) > 0;
}

export async function listWhitelist(): Promise<{ jid: string; addedBy: string | null }[]> {
  const rows = await sql`SELECT jid, added_by FROM whitelisted_groups ORDER BY added_at`;
  return rows.map((r: any) => ({ jid: r.jid, addedBy: r.added_by ?? null }));
}


/*
QR contribution ranking moved to hi-hive/contributions.ts.

It used to live here as incrementContribution() + getRankings(), both of which
only knew about hi_hive - so a contribution from someone without an account was
dropped and never appeared on any leaderboard. The replacement routes credit to
hi_hive or to the contributors ledger depending on whether the account resolves,
and the leaderboard unions the two.
*/

/**
 * Atomically claim the right to send this batch's report.
 *
 * Returns true for exactly ONE caller. Concurrent workers that finish the last
 * jobs at the same instant will get false, so the report can never be sent
 * twice — which is what caused the duplicate-report spam.
 */
export async function claimBatchReport(batchId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE scan_buffer
    SET reported = TRUE
    WHERE batch_id = ${batchId} AND reported = FALSE
    RETURNING id
  `;
  return rows.length > 0;
}


/**
 * Give the report claim back so a later tick can retry.
 *
 * Used when every destination failed — typically because the WhatsApp socket
 * was closed at that moment. Without this the batch stayed flagged as reported
 * and the result was lost even though the scans had succeeded.
 */
export async function releaseBatchReport(batchId: string): Promise<void> {
  await sql`
    UPDATE scan_buffer SET reported = FALSE WHERE batch_id = ${batchId}
  `;
}

/**
 * Batches whose jobs have all finished but whose report was never delivered.
 * The normal completion path fires when the last job finishes; this is the
 * recovery path for when that send failed (offline, socket closed, restart).
 */
export async function undeliveredBatches(limit = 5): Promise<string[]> {
  const rows = await sql<{ batch_id: string }[]>`
    SELECT batch_id
    FROM scan_buffer
    GROUP BY batch_id
    HAVING COUNT(*) FILTER (WHERE status = 'pending') = 0
       AND BOOL_AND(reported = FALSE)
    LIMIT ${limit}
  `;
  return rows.map((r: any) => r.batch_id);
}
/**
 * When the next pending job comes due, or null when the queue is empty.
 *
 * Lets the drain service sleep until there is actually something to do instead
 * of asking every half second. One indexed aggregate, no rows returned.
 */
export async function nextDueAt(): Promise<number | null> {
  const rows = await sql<{ next: string | null }[]>`
    SELECT MIN(due_at)::text AS next FROM scan_buffer WHERE status = 'pending'
  `;
  const next = rows[0]?.next;
  return next === null || next === undefined ? null : Number(next);
}
