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

import { formatClock } from "../utils/datetime.js";
import {
  dueJobs, nextDueAt, markDone, batchPendingCount, batchRows, deleteBatch, purgeStale, claimBatchReport,
  releaseBatchReport, undeliveredBatches,
  type BufferRow,
} from "./scan-buffer-db.js";
import { scanOneAccount } from "./scan-runner.js";
import { loadCreds } from "./creds.js";
import { STATUS_META, type ReportStatus } from "./scan-status.js";
import { includesStudent, includesStatus, scannedByHeader, isSilentChat, type Destination } from "./destinations.js";
import { sendText, react, getTransport } from "../messaging/outbox.js";
import type { TransportName } from "../messaging/types.js";

const TICK_MS = Number(process.env["SCAN_BUFFER_TICK_MS"] ?? 500);

/*
Which bot a destination belongs to.

Rows queued before the two bots shared a database have no transport field. A
WhatsApp jid always contains "@" and a Telegram chat id never does, so the chat
id itself is a reliable fallback.
*/
const transportFor = (chatId: string, stored?: TransportName): TransportName =>
  stored ?? (chatId.includes("@") ? "whatsapp" : "telegram");

/** Can we deliver to this chat right now? */
const canDeliver = (chatId: string, stored?: TransportName): boolean => {
  const t = getTransport(transportFor(chatId, stored));
  return !!t && t.isReady();
};

let started = false;                 // guard: reconnects must not stack pollers
let ticking = false;                 // guard: ticks must never overlap
const inFlight = new Set<string>();  // jobs currently being processed

// Rendered in the bot's configured timezone, not the host's - see formatClock
const clock = (d: Date) => formatClock(d.getTime());

function buildReport(rows: BufferRow[]): string {
  const now = clock(new Date());
  const header = rows[0]?.scannedBy ? scannedByHeader(rows[0].scannedBy) : "";

  // Tally across every course in the batch
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

  const line = (r: BufferRow, indent: string) => {
    const status = (r.resultStatus ?? "scan_failed") as ReportStatus;
    const m = STATUS_META[status] ?? STATUS_META.scan_failed;
    return `${indent}${m.emoji} \`${r.label}\` ➔ *${m.label}*\n${indent}     _${m.sentence}_`;
  };

  const courses = [...new Set(rows.map(r => r.courseCode ?? "Unknown"))];

  // Single course → the familiar flat layout, course named in the title
  if (courses.length <= 1) {
    const course = rows[0]?.courseCode ? ` FOR ${rows[0].courseCode.toUpperCase()}` : "";
    const lines = rows.map(r => line(r, ""));
    return `${header}📋 *AUTO SCAN REPORT${course}*\n${summary}\n\n${lines.join("\n")}\n\n🏁 *Completed at:* \`${now}\``;
  }

  // Several courses in one image → a block per course, each with its own tally
  const blocks = courses.map(course => {
    const mine = rows.filter((r: BufferRow) => (r.courseCode ?? "Unknown") === course);
    const sub = new Map<string, number>();
    for (const r of mine) {
      const s = r.resultStatus ?? "scan_failed";
      sub.set(s, (sub.get(s) ?? 0) + 1);
    }
    const subSummary = [...sub.entries()]
      .map(([s, n]) => {
        const m = STATUS_META[s as ReportStatus] ?? STATUS_META.scan_failed;
        return `${m.emoji} ${n}`;
      })
      .join(" · ");
    return `📚 *${course.toUpperCase()}*  _${subSummary}_\n${mine.map(r => line(r, "   ")).join("\n")}`;
  });

  return `${header}📋 *AUTO SCAN REPORT*\n_${courses.length} courses_ · ${summary}\n\n${blocks.join("\n\n")}\n\n🏁 *Completed at:* \`${now}\``;
}

/*
The socket is deliberately NOT captured here. It is read fresh from
getSock() at each send, because a reconnect replaces the socket and a captured
reference goes permanently dead. See src/lib/current-sock.ts.
*/
export function startScanBufferService(_sockIgnored?: any) {
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
            // Recomputed live — never trusted from the row (see isSilentChat).
            const silent = await isSilentChat(job.chatId);

            /*
            Stored destinations are the normal path. The fallback only matters if
            the `destinations` column is absent — and it must NOT resurrect the
            origin chat when that chat is meant to stay silent.
            */
            const dests: Destination[] = (rows[0]?.destinations as Destination[] | null)
              ?? (silent ? [] : [{ chatId: job.chatId, status: "all", isOrigin: true, showDelay: true }]);

            console.log(`[scanBuffer] batch ${job.batchId}: ${dests.length} destination(s) to report to.`);

            /*
            If the socket is down there is no point burning the claim — release
            it and let a later tick retry once the connection is back. This is
            exactly the case that used to lose reports: the scans succeeded but
            the connection had dropped during the batch, so every send threw
            428 Connection Closed and the batch was deleted anyway.
            */
            if (!canDeliver(job.chatId)) {
              console.warn(`[scanBuffer] socket is closed — deferring report for batch ${job.batchId}.`);
              await releaseBatchReport(job.batchId);
              continue;
            }

            let delivered = 0;

            for (const dest of dests) {
             try {
              // 1. Which students does this destination care about?
              let mine = rows.filter((r: BufferRow) => includesStudent(dest, r.studentId));

              // Same safety net as the delay notice: never leave the origin
              // chat with no report because a filter matched nobody.
              if (mine.length === 0) {
                if (!dest.isOrigin) continue;
                mine = rows;
              }

              // 2. Status gate — only send if at least one included student
              //    finished with a status this destination asked for.
              const passes = mine.some((r: BufferRow) =>
                includesStatus(dest, (r.resultStatus ?? "scan_failed") as ReportStatus));
              if (!passes) {
                console.log(`[scanBuffer] ${dest.chatId}: status gate not met — not sending.`);
                continue;
              }

              const text = buildReport(mine);

              let sent = false;
              if (dest.isOrigin && rows[0]?.quotedKey) {
                try {
                  await sendText(transportFor(dest.chatId, dest.transport), dest.chatId, text, { priority: 5 });
                  sent = true;
                } catch (quoteErr) {
                  console.log(`[scanBuffer] quoted send failed, sending plain:`, quoteErr);
                }
              }
              if (!sent) {
                try {
                  await sendText(transportFor(dest.chatId, dest.transport), dest.chatId, text, { priority: 5 });
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
            if (silent) {
              console.log(`[scanBuffer] ${job.chatId} is silent — keeping ❤️, no ✅.`);
            } else if (rows[0]?.quotedKey) {
              try {
                await react(transportFor(job.chatId), job.chatId, "✅", { key: rows[0].quotedKey });
              } catch { /* non-fatal */ }
            }

            if (delivered === 0) {
              /*
              Nothing got through. Do NOT delete — release the claim so a later
              tick retries. Rows are still purged after 24h, so this can't grow
              unbounded, but a transient disconnect no longer costs the report.
              */
              console.error(`[scanBuffer] ⚠️ batch ${job.batchId}: no destination accepted the report — will retry.`);
              console.error(buildReport(rows).replace(/\*/g, ""));
              await releaseBatchReport(job.batchId);
              continue;
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

  /*
  Recovery sweep: batches whose jobs all finished but whose report never
  reached anyone (socket was down at the time). The normal path only fires when
  the LAST job completes, so without this a deferred report would never be
  retried.
  */
  const sweep = async () => {
    if (!getTransport('whatsapp')?.isReady() && !getTransport('telegram')?.isReady()) return;
    try {
      const batchIds = await undeliveredBatches(5);
      for (const batchId of batchIds) {
        const rows = await batchRows(batchId);
        if (rows.length === 0) continue;

        if (!(await claimBatchReport(batchId))) continue;   // someone else has it

        const dests: Destination[] = (rows[0]?.destinations as Destination[] | null)
          ?? ((await isSilentChat(rows[0].chatId))
                ? []
                : [{ chatId: rows[0].chatId, status: "all", isOrigin: true, showDelay: true }]);

        let delivered = 0;
        for (const dest of dests) {
          try {
            let mine = rows.filter((r: BufferRow) => includesStudent(dest, r.studentId));
            if (mine.length === 0) {
              if (!dest.isOrigin) continue;
              mine = rows;
            }
            const passes = mine.some((r: BufferRow) =>
              includesStatus(dest, (r.resultStatus ?? "scan_failed") as ReportStatus));
            if (!passes) continue;

            await sendText(transportFor(dest.chatId, dest.transport), dest.chatId, buildReport(mine), { priority: 5 });
            delivered++;
            console.log(`[scanBuffer] 🔁 retried report → ${dest.chatId}`);
          } catch (err) {
            console.error(`[scanBuffer] retry to ${dest.chatId} failed:`, err);
          }
        }

        if (delivered === 0) {
          await releaseBatchReport(batchId);   // still down — try again later
        } else {
          await deleteBatch(batchId);
          console.log(`[scanBuffer] ✅ batch ${batchId} delivered on retry.`);
        }
      }
    } catch (err) {
      console.error("[scanBuffer] sweep error:", err);
    }
  };

  // Immediate pass recovers anything that came due while the bot was offline
  /*
  Sleep until there is actually work, instead of asking every half second.

  A fixed 500 ms interval meant 172,800 queries a day, essentially all of them
  returning nothing - the queue is empty except for the minute or two after
  someone posts a QR. On a phone that is wasted wakeups and wasted battery for
  no gain in precision.

  Now the loop asks the database when the next job is due and sleeps exactly
  that long, clamped:

    - never below TICK_MS, so a burst of jobs due at once still runs in order
      rather than spinning
    - never above IDLE_POLL_MS, so a job inserted by the OTHER bot (which this
      process gets no notification about) is still picked up promptly

  Precision when work exists is unchanged: the wait is computed from the real
  due time, so a job 3.2 s out is woken at 3.2 s, not on the next 500 ms
  boundary.
  */
  const IDLE_POLL_MS = Number(process.env["SCAN_BUFFER_IDLE_MS"] ?? 15_000);

  let stopped = false;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await tick();

      let waitMs = IDLE_POLL_MS;
      try {
        const next = await nextDueAt();
        if (next !== null) {
          waitMs = Math.min(IDLE_POLL_MS, Math.max(TICK_MS, next - Date.now()));
        }
      } catch {
        // Unreadable queue: fall back to the idle cadence rather than spinning
        waitMs = IDLE_POLL_MS;
      }

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  };

  void (async () => {
    try {
      const pending = await dueJobs(Date.now() + 365 * 24 * 3_600_000); // peek all
      console.log(`🗓️ Scan buffer: ${pending.length} pending job(s) found on startup.`);
    } catch (e) {
      console.error("🗓️ Scan buffer: could not read scan_buffer table — did you run scan-buffer-schema.sql?", e);
    }
    await loop();
  })();

  setInterval(() => { void sweep(); }, 15_000);   // retry undelivered reports

  // Hourly housekeeping
  setInterval(() => { void purgeStale(); }, 3_600_000);
}