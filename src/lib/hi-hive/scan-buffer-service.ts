/**
 * scan-buffer-service.ts — src/lib/hi-hive/scan-buffer-service.ts
 *
 * Drains the persisted scan_buffer. Started once from index.ts on connection
 * "open". Because the queue lives in Postgres, a crash/restart loses nothing:
 * on boot this picks up every still-pending job and immediately runs whatever
 * became overdue while the bot was down.
 *
 *   startScanBufferService(sock);
 *
 * Env: SCAN_BUFFER_TICK_MS (default 2000)
 */

import {
  dueJobs, markDone, batchPendingCount, batchRows, deleteBatch, purgeStale,
  type BufferRow,
} from "./scan-buffer-db.js";
import { scanOneAccount } from "./scan-runner.js";
import { loadCreds } from "./creds.js";
import { STATUS_META, type ReportStatus } from "./scan-status.js";

const TICK_MS = Number(process.env["SCAN_BUFFER_TICK_MS"] ?? 2000);

let started = false;                 // guard: reconnects must not stack pollers
const inFlight = new Set<string>();  // jobs currently being processed

const clock = (d: Date) => d.toLocaleTimeString("en-US", { hour12: false });

function buildReport(rows: BufferRow[]): string {
  const now = clock(new Date());

  const lines = rows.map(r => {
    const status = (r.resultStatus ?? "scan_failed") as ReportStatus;
    const m = STATUS_META[status] ?? STATUS_META.scan_failed;
    return `${m.emoji} *[${now}]* \`${r.label}\` ➔ *${m.label}*\n     _${m.sentence}_`;
  });

  const tally = new Map<string, number>();
  for (const r of rows) {
    const s = r.resultStatus ?? "scan_failed";
    tally.set(s, (tally.get(s) ?? 0) + 1);
  }
  const summary = [...tally.entries()]
    .map(([s, n]) => {
      const m = STATUS_META[s as ReportStatus] ?? STATUS_META.scan_failed;
      return `${m.emoji} ${n} ${m.label.toLowerCase()}`;
    })
    .join(" · ");

  return `📋 *AUTO SCAN REPORT*\n${summary}\n\n${lines.join("\n")}\n\n🏁 *Completed at:* \`${now}\``;
}

export function startScanBufferService(sock: any) {
  if (started) return;              // idempotent — safe across reconnects
  started = true;
  console.log("🗓️ Scan buffer service started (persisted queue).");

  const tick = async () => {
    try {
      const jobs = await dueJobs();
      if (jobs.length === 0) return;

      for (const job of jobs) {
        if (inFlight.has(job.id)) continue;
        inFlight.add(job.id);

        try {
          const creds = await loadCreds(job.docId);
          let status: ReportStatus;

          if (!creds) {
            status = "scan_failed";
            console.log(`[scanBuffer] ${job.label}: creds missing for ${job.docId}`);
          } else {
            status = await scanOneAccount(job.docId, creds, job.label, job.rawQr);
          }

          await markDone(job.id, status);
          console.log(`[scanBuffer] ${job.label} → ${status}`);

          // Last job of the batch? Send the report and clean up.
          const remaining = await batchPendingCount(job.batchId);
          if (remaining === 0) {
            const rows = await batchRows(job.batchId);
            const text = buildReport(rows);
            const quoted = rows[0]?.quotedKey
              ? { quoted: { key: rows[0].quotedKey, message: {} } as any }
              : undefined;
            await sock.sendMessage(job.chatId, { text }, quoted);
            await deleteBatch(job.batchId);
            console.log(`[scanBuffer] batch ${job.batchId} complete — report sent.`);
          }
        } catch (err) {
          // Leave it pending so the next tick retries rather than losing the job
          console.error(`[scanBuffer] job ${job.label} failed:`, err);
        } finally {
          inFlight.delete(job.id);
        }
      }
    } catch (err) {
      console.error("[scanBuffer] tick error:", err);
    }
  };

  // Immediate pass recovers anything that came due while the bot was offline
  void tick();
  setInterval(tick, TICK_MS);

  // Hourly housekeeping
  setInterval(() => { void purgeStale(); }, 3_600_000);
}