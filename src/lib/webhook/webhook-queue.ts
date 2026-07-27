/**
 * webhook-queue.ts — src/lib/webhook/webhook-queue.ts
 *
 * EVENT-DRIVEN replacement for the old 30-second polling loop.
 *
 * Why the old version hit `resource_exhausted`:
 *   • It ran `.get()` every 30s = 2,880 queries/day. Firestore bills a MINIMUM
 *     of 1 read per query even when zero documents match, so an idle queue still
 *     burned ~2,880 reads/day.
 *   • Worse, startWebhookQueue() was called on every connection "open" event.
 *     Each reconnect started ANOTHER setInterval that was never cleared, so the
 *     pollers stacked. ~20 reconnects/day × 2,880 = 57,600 reads → over the
 *     50,000/day free tier.
 *
 * The fix:
 *   1. onSnapshot() real-time listener instead of polling. Firestore charges
 *      1 read per DOCUMENT DELIVERED, not per poll — an idle queue costs ~0
 *      reads/day instead of thousands.
 *   2. A hard idempotency guard so reconnects can never stack listeners, plus
 *      detach-on-restart.
 *   3. Jobs are still deleted after sending, so the collection stays tiny and
 *      the initial snapshot is cheap.
 */

import db from "../../firebase.js";
import { formatEvent } from "./format-event.js";

const COLLECTION = "webhook_queue";
const MAX_JOB_AGE_MS = 24 * 3_600_000;

let unsubscribe: null | (() => void) = null;   // active listener, if any
const inFlight = new Set<string>();

function wantsEvent(events: string[] | undefined, event: string): boolean {
  if (!events || events.includes("all")) return true;
  return events.includes(event);
}

async function processDoc(sock: any, doc: any) {
  if (inFlight.has(doc.id)) return;
  inFlight.add(doc.id);

  const job = doc.data() as any;
  try {
    const createdMs = job.createdAt?.toMillis?.() ?? Date.now();
    if (Date.now() - createdMs > MAX_JOB_AGE_MS) {
      await doc.ref.delete();
      console.log(`🪝 dropped stale job ${doc.id}`);
      return;
    }

    if (job.event === "ping") {
      await sock.sendMessage(job.targetJid, {
        text: "✅ *GitHub webhook connected!*\nThis chat will now receive repo events.",
      });
      await doc.ref.delete();
      return;
    }

    if (!wantsEvent(job.events, job.event)) {
      await doc.ref.delete();
      return;
    }

    const formatted = formatEvent(job.event, job.payload);
    if (!formatted) { await doc.ref.delete(); return; }

    await sock.sendMessage(job.targetJid, { text: formatted.text });
    await doc.ref.delete();
    console.log(`🪝 ${job.event} → ${job.targetJid} (${formatted.repoName ?? "?"})`);
  } catch (err) {
    // Don't delete — the listener will redeliver on the next change, or the
    // document stays for a manual retry. No busy-looping either way.
    console.error(`🪝 failed to process ${doc.id}:`, err);
  } finally {
    inFlight.delete(doc.id);
  }
}

/**
 * Start the real-time listener. Safe to call on every reconnect: any previous
 * listener is detached first, so they can never stack.
 */
export function startWebhookQueue(sock: any) {
  if (unsubscribe) {
    // Reconnect: drop the old listener before attaching a new one.
    try { unsubscribe(); } catch { /* ignore */ }
    unsubscribe = null;
    console.log("🪝 previous webhook listener detached.");
  }

  unsubscribe = db.collection(COLLECTION)
    .where("processed", "==", false)
    .onSnapshot(
      (snap: any) => {
        // Only newly ADDED docs cost a read; steady state is free.
        for (const change of snap.docChanges()) {
          if (change.type === "added") void processDoc(sock, change.doc);
        }
      },
      (err: any) => {
        console.error("🪝 webhook listener error:", err);
        unsubscribe = null;
        // Reconnect with backoff rather than hammering Firestore.
        setTimeout(() => startWebhookQueue(sock), 60_000);
      }
    );

  console.log("🪝 Webhook queue listener started (event-driven, no polling).");
}

/** Detach explicitly (e.g. on shutdown). */
export function stopWebhookQueue() {
  if (unsubscribe) { try { unsubscribe(); } catch {} unsubscribe = null; }
}