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

/** Random integer seconds in [MIN_DELAY_SEC, MAX_DELAY_SEC]. */
export function randomDelaySec(): number {
  const lo = Math.max(0, Math.min(MIN_DELAY_SEC, MAX_DELAY_SEC));
  const hi = Math.max(lo, MAX_DELAY_SEC);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
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

/** Format "1m 05s" / "42s" for the waiting list. */
export function humanWait(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

/** "14:30:05" */
export function clock(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false });
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