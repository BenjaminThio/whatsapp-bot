/**
 * scan-buffer.ts — src/lib/hi-hive/scan-buffer.ts
 *
 * Spreads auto-scans over a random window instead of firing them all at once,
 * so the submissions don't look robotic/simultaneous.
 *
 * Design (as requested): we do NOT sleep the whole process. Each student is put
 * in a buffer with its own "due at" timestamp. A tick loop repeatedly checks the
 * clock and runs whichever jobs have come due, until the buffer is empty. Every
 * wait is an `await` on a timer, which yields to the event loop — the bot keeps
 * handling other messages the entire time.
 *
 * Env:
 *   AUTOSCAN_MIN_DELAY_SEC  (default 0)
 *   AUTOSCAN_MAX_DELAY_SEC  (default 60)
 *   AUTOSCAN_TICK_MS        (default 1000)
 */

import { formatClock } from "../utils/datetime.js";

export const MIN_DELAY_SEC = Number(process.env["AUTOSCAN_MIN_DELAY_SEC"] ?? 0);
export const MAX_DELAY_SEC = Number(process.env["AUTOSCAN_MAX_DELAY_SEC"] ?? 5);
const TICK_MS              = Number(process.env["AUTOSCAN_TICK_MS"] ?? 1000);

export interface BufferJob<T> {
  /** Whatever payload the runner needs (docId, creds, label…) */
  payload: T;
  /** Display label for the notification (usually the student id) */
  label: string;
  /** Epoch ms when this job should run */
  dueAt: number;
  /** Seconds of delay assigned (for the notification) */
  delaySec: number;
}

/**
 * Random FRACTIONAL seconds in [MIN_DELAY_SEC, MAX_DELAY_SEC], e.g. 1.53, 2.34,
 * 4.71. Whole-second values collide often with a small range and few students
 * (two people both rolling "3" out of 0–5), and tied jobs end up running
 * back-to-back in the same instant. Fractions make ties effectively impossible.
 * Rounded to 2 decimals — finer than that is pointless at this timescale.
 */
export function randomDelaySec(): number {
  const lo = Math.max(0, Math.min(MIN_DELAY_SEC, MAX_DELAY_SEC));
  const hi = Math.max(lo, MAX_DELAY_SEC);
  const raw = lo + Math.random() * (hi - lo);
  return Math.round(raw * 100) / 100;
}

/**
 * Build the buffer: assign each item a random delay and a due timestamp.
 * Returned sorted by dueAt ascending (soonest first, longest last).
 */
export function buildBuffer<T>(
  items: { payload: T; label: string }[],
  startedAt: number = Date.now()
): BufferJob<T>[] {
  return items
    .map(({ payload, label }) => {
      const delaySec = randomDelaySec();
      return { payload, label, delaySec, dueAt: startedAt + delaySec * 1000 };
    })
    .sort((a, b) => a.dueAt - b.dueAt);
}

/** Format "1m 05.4s" / "42.7s" for the waiting list (handles fractions). */
export function humanWait(sec: number): string {
  if (sec < 60) {
    // One decimal is enough to read; drop it when it's a whole second
    return Number.isInteger(sec) ? `${sec}s` : `${sec.toFixed(1)}s`;
  }
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sStr = Number.isInteger(s) ? String(s).padStart(2, "0") : s.toFixed(1).padStart(4, "0");
  return `${m}m ${sStr}s`;
}

/**
 * "14:30:05", in the bot's configured timezone.
 *
 * toLocaleTimeString() renders in the host's zone, and a proot-distro Ubuntu
 * has none set - so scan times came out in UTC while the phone showed UTC+8.
 */
export function clock(d: Date): string {
  return formatClock(d.getTime());
}

/**
 * Build the "please wait" notification. Students are listed soonest-first, so
 * the LAST line is the longest wait — i.e. when the whole run will finish.
 */
export function formatWaitingNotice<T>(jobs: BufferJob<T>[]): string {
  if (jobs.length === 0) return "";

  const lines = jobs.map(j =>
    `⏳ \`${j.label}\` ➔ in *${humanWait(j.delaySec)}*  _(at ${clock(new Date(j.dueAt))})_`
  );

  const last = jobs[jobs.length - 1];
  return (
    `🕒 *AUTO SCAN QUEUED*\n` +
    `_Scans are spread out to avoid firing all at once._\n\n` +
    `${lines.join("\n")}\n\n` +
    `🏁 *Expected to finish at:* \`${clock(new Date(last.dueAt))}\`  ` +
    `_(longest wait: ${humanWait(last.delaySec)})_`
  );
}

/**
 * Run the buffer: tick the clock, execute jobs as they come due, until empty.
 * Never blocks — each wait yields to the event loop.
 *
 * @param jobs    buffer from buildBuffer (any order; we re-sort defensively)
 * @param runner  async fn executed per job when its time arrives
 */
export async function runBuffer<T>(
  jobs: BufferJob<T>[],
  runner: (job: BufferJob<T>) => Promise<void>
): Promise<void> {
  const pending = [...jobs].sort((a, b) => a.dueAt - b.dueAt);

  while (pending.length > 0) {
    const now = Date.now();

    // Take everything that has come due (usually one, but handles clumps)
    const dueNow: BufferJob<T>[] = [];
    while (pending.length > 0 && pending[0].dueAt <= now) {
      dueNow.push(pending.shift()!);
    }

    if (dueNow.length > 0) {
      // Run sequentially so submissions stay staggered rather than parallel
      for (const job of dueNow) {
        try {
          await runner(job);
        } catch (err) {
          console.error(`[scanBuffer] job "${job.label}" threw:`, err);
        }
      }
      continue;   // re-check immediately in case more are due
    }

    // Nothing due yet — sleep until the next job (capped at one tick so the
    // loop stays responsive). `await` here yields; it does NOT block the bot.
    const waitMs = Math.min(TICK_MS, Math.max(0, pending[0].dueAt - Date.now()));
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}


/**
 * Waiting list grouped by course — for images containing several QRs.
 *
 * Students are listed soonest-first within each course, and the overall finish
 * time is taken from the very last job across all courses.
 */
export function formatWaitingNoticeGrouped(
  jobs: { label: string; delaySec: number; dueAt: number; courseCode: string | null }[]
): string {
  if (jobs.length === 0) return "";

  const sorted = [...jobs].sort((a, b) => a.dueAt - b.dueAt);
  const courses = [...new Set(sorted.map(j => j.courseCode ?? "Unknown"))];

  // Single course → keep the original flat layout
  if (courses.length === 1) {
    const lines = sorted.map(j =>
      `⏳ \`${j.label}\` ➔ in *${humanWait(j.delaySec)}*  _(at ${clock(new Date(j.dueAt))})_`);
    const last = sorted[sorted.length - 1];
    return (
      `🕒 *AUTO SCAN QUEUED*\n` +
      `_Scans are spread out to avoid firing all at once._\n\n` +
      `${lines.join("\n")}\n\n` +
      `🏁 *Expected to finish at:* \`${clock(new Date(last.dueAt))}\`  ` +
      `_(longest wait: ${humanWait(last.delaySec)})_`
    );
  }

  // Several courses → one block each
  const blocks = courses.map(course => {
    const mine = sorted.filter(j => (j.courseCode ?? "Unknown") === course);
    const lines = mine.map(j =>
      `   ⏳ \`${j.label}\` ➔ in *${humanWait(j.delaySec)}*  _(at ${clock(new Date(j.dueAt))})_`);
    return `📚 *${course.toUpperCase()}*\n${lines.join("\n")}`;
  });

  const last = sorted[sorted.length - 1];
  return (
    `🕒 *AUTO SCAN QUEUED*\n` +
    `_${courses.length} courses detected in this image._\n\n` +
    `${blocks.join("\n\n")}\n\n` +
    `🏁 *Expected to finish at:* \`${clock(new Date(last.dueAt))}\`  ` +
    `_(longest wait: ${humanWait(last.delaySec)})_`
  );
}