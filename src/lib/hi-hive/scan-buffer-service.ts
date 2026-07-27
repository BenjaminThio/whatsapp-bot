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
 * Jobs ALWAYS run one at a time in due-time order (the loop below is a plain
 * sequential `for` + `await` — never parallel). What changes with the tick
 * interval is only PRECISION: this service only checks "what's due" once per
 * tick, so two jobs whose due times fall inside the same tick window will run
 * back-to-back in that instant instead of visibly spaced apart.
 *
 * Rule of thumb: keep SCAN_BUFFER_TICK_MS well under your smallest expected
 * delay gap. Defaults to 500ms, which comfortably resolves delays down to a
 * couple of seconds apart. If you configure AUTOSCAN_MIN/MAX_DELAY_SEC very
 * small (e.g. a 5s max for testing), drop this to 100–200ms.
 *
 * Env: SCAN_BUFFER_TICK_MS (default 500)
 */

import {
  dueJobs, markDone, batchPendingCount, batchRows, deleteBatch, purgeStale,
  type BufferRow,
} from "./scan-buffer-db.js";
import { scanOneAccount } from "./scan-runner.js";
import { loadCreds } from "./creds.js";
import { STATUS_META, type ReportStatus } from "./scan-status.js";
import { includesStudent, includesStatus, type Destination } from "./report-targets.js";

const TICK_MS = Number(process.env["SCAN_BUFFER_TICK_MS"] ?? 500);

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

            // Destinations were resolved and stored when the batch was queued.
            // Fall back to a single report in the origin chat if absent.
            const dests: Destination[] = (rows[0]?.destinations as Destination[] | null) ?? [
              { chatId: job.chatId, status: "all", isOrigin: true },
            ];

            for (const dest of dests) {
              // 1. Which students does this destination care about?
              const mine = rows.filter(r => includesStudent(dest, r.studentId));
              if (mine.length === 0) continue;

              // 2. Status gate — only send if at least one included student
              //    finished with a status this destination asked for.
              const passes = mine.some(r =>
                includesStatus(dest, (r.resultStatus ?? "scan_failed") as ReportStatus));
              if (!passes) {
                console.log(`[scanBuffer] ${dest.chatId}: status gate not met — not sending.`);
                continue;
              }

              const text = buildReport(mine);

              let sent = false;
              if (dest.isOrigin && rows[0]?.quotedKey) {
                try {
                  await sock.sendMessage(dest.chatId, { text },
                    { quoted: { key: rows[0].quotedKey, message: {} } as any });
                  sent = true;
                } catch (quoteErr) {
                  console.log(`[scanBuffer] quoted send failed, sending plain:`, quoteErr);
                }
              }
              if (!sent) {
                try {
                  await sock.sendMessage(dest.chatId, { text });
                } catch (err) {
                  console.error(`[scanBuffer] report to ${dest.chatId} failed:`, err);
                  continue;
                }
              }

              console.log(`[scanBuffer] report → ${dest.chatId} (${mine.length} student(s))`);
            }

            // React on the original QR message so the sender sees an outcome
            if (rows[0]?.quotedKey) {
              const anyFail = rows.some(r =>
                r.resultStatus !== "marked" && r.resultStatus !== "already_marked");
              try {
                await sock.sendMessage(job.chatId, {
                  react: { text: anyFail ? "❌" : "✅", key: rows[0].quotedKey },
                });
              } catch { /* non-fatal */ }
            }

            await deleteBatch(job.batchId);
            console.log(`[scanBuffer] ✅ batch ${job.batchId} complete (${rows.length} account(s)).`);
            console.log(buildReport(rows).replace(/\*/g, ""));   // full run mirrored to terminal
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
  void (async () => {
    try {
      const pending = await dueJobs(Date.now() + 365 * 24 * 3_600_000); // peek all
      console.log(`🗓️ Scan buffer: ${pending.length} pending job(s) found on startup.`);
    } catch (e) {
      console.error("🗓️ Scan buffer: could not read scan_buffer table — did you run scan-buffer-schema.sql?", e);
    }
    await tick();
  })();
  setInterval(tick, TICK_MS);

  // Hourly housekeeping
  setInterval(() => { void purgeStale(); }, 3_600_000);
}