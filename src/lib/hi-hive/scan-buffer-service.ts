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
  dueJobs, markDone, batchPendingCount, batchRows, deleteBatch, purgeStale, claimBatchReport,
  type BufferRow,
} from "./scan-buffer-db.js";
import { scanOneAccount } from "./scan-runner.js";
import { loadCreds } from "./creds.js";
import { STATUS_META, type ReportStatus } from "./scan-status.js";
import { includesStudent, includesStatus, scannedByHeader, type Destination } from "./report-targets.js";

const TICK_MS = Number(process.env["SCAN_BUFFER_TICK_MS"] ?? 500);

let started = false;                 // guard: reconnects must not stack pollers
let ticking = false;                 // guard: ticks must never overlap
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

  const header = rows[0]?.scannedBy ? scannedByHeader(rows[0].scannedBy) : "";
  const course = rows[0]?.courseCode ? ` FOR ${rows[0].courseCode.toUpperCase()}` : "";
  return `${header}📋 *AUTO SCAN REPORT${course}*\n${summary}\n\n${lines.join("\n")}\n\n🏁 *Completed at:* \`${now}\``;
}

export function startScanBufferService(sock: any) {
  if (started) return;              // idempotent — safe across reconnects
  started = true;
  console.log("🗓️ Scan buffer service started (persisted queue).");

  const tick = async () => {
    /*
    Ticks MUST NOT overlap. Each scan is a real HTTP request taking seconds,
    while the interval fires every few hundred ms — so without this guard several
    ticks run at once, each finishing a different job and then independently
    deciding the batch is complete. That race is what sent the report once per
    account instead of once per batch.
    */
    if (ticking) return;
    ticking = true;

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
            // Second line of defence: only ONE worker may ever report a batch.
            // If another already claimed it, stop here silently.
            if (!(await claimBatchReport(job.batchId))) {
              console.log(`[scanBuffer] batch ${job.batchId} already reported — skipping duplicate.`);
              continue;
            }

            const rows = await batchRows(job.batchId);

            // Destinations were resolved and stored when the batch was queued.
            // Fall back to a single report in the origin chat if absent.
            const dests: Destination[] = (rows[0]?.destinations as Destination[] | null) ?? [
              { chatId: job.chatId, status: "all", isOrigin: true, showDelay: true },
            ];

            console.log(`[scanBuffer] batch ${job.batchId}: ${dests.length} destination(s) to report to.`);
            let delivered = 0;

            for (const dest of dests) {
             try {
              // 1. Which students does this destination care about?
              let mine = rows.filter(r => includesStudent(dest, r.studentId));

              // Same safety net as the delay notice: never leave the origin
              // chat with no report because a filter matched nobody.
              if (mine.length === 0) {
                if (!dest.isOrigin) continue;
                mine = rows;
              }

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

              delivered++;
              console.log(`[scanBuffer] ✉️ report → ${dest.chatId} (${mine.length} student(s))`);
             } catch (destErr) {
               // One bad destination must not stop the others from being told.
               console.error(`[scanBuffer] destination ${dest.chatId} failed:`, destErr);
             }
            }

            /*
            Final reaction.

            Two bugs fixed here:
              • It used to go ❌ whenever ANY account wasn't marked. With several
                accounts that's nearly always true (someone is not_enrolled, or
                already_marked), so a perfectly good run ended on a cross.
                A finished run now always ends on ✅ — the report carries the
                per-student detail.
              • It used to overwrite the ❤️ on silent (non-whitelisted) chats.
                Those now keep their ❤️ and get no further reaction.
            */
            /*
            Decide silence from the DESTINATIONS, not just the stored flag.

            `origin_silent` is a newer column — rows inserted before the ALTER
            read back as false, which let the ✅ overwrite the ❤️ on
            non-whitelisted groups. Cross-check it against whether the origin
            chat is actually a destination: if it isn't, the chat was meant to
            stay silent and must keep its ❤️.
            */
            const originIsDestination = dests.some(d => d.chatId === job.chatId);
            const silent = (rows[0]?.originSilent ?? false) || !originIsDestination;

            if (!silent && rows[0]?.quotedKey) {
              try {
                await sock.sendMessage(job.chatId, {
                  react: { text: "✅", key: rows[0].quotedKey },
                });
              } catch { /* non-fatal */ }
            }

            if (delivered === 0) {
              // Nothing got through. Keep it loud so the result isn't lost silently.
              console.error(`[scanBuffer] ⚠️ batch ${job.batchId}: NO destination accepted the report.`);
              console.error(buildReport(rows).replace(/\*/g, ""));
            }

            await deleteBatch(job.batchId);
            console.log(`[scanBuffer] ✅ batch ${job.batchId} complete (${rows.length} account(s), ${delivered} report(s) sent).`);
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
    } finally {
      ticking = false;
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