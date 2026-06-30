/**
 * Vercel writes raw GitHub events to the `webhook_queue` collection. This
 * service polls that queue (same pattern as startScheduleService), formats each
 * event, sends it to the target WhatsApp chat, then DELETES the job so the queue
 * stays clean.
 *
 * Call once from index.ts on connection "open":
 *   startWebhookQueue(sock);
 */

import db from "../../firebase.js";
import { formatEvent } from "./format-event.js";

const COLLECTION = "webhook_queue";
const POLL_INTERVAL_MS = 30_000;
// Safety: ignore jobs older than this (e.g. stuck/corrupt) - delete without sending
const MAX_JOB_AGE_MS = 24 * 3_600_000;

interface QueueJob {
  token:     string;
  targetJid: string;
  events?:   string[];
  event:     string;
  payload:   any;
  processed: boolean;
  createdAt: any;   // Firestore Timestamp
}

// Track jobs we're mid-processing so overlapping polls don't double-send
const inFlight = new Set<string>();

function wantsEvent(events: string[] | undefined, event: string): boolean {
  if (!events || events.includes("all")) return true;
  return events.includes(event);
}

export function startWebhookQueue(sock: any) {
  console.log("🪝 Webhook queue consumer started.");

  const poll = async () => {
    try {
      // Oldest unprocessed jobs first
      const snap = await db.collection(COLLECTION)
        .where("processed", "==", false)
        .limit(20)
        .get();

      if (snap.empty) return;

      for (const doc of snap.docs) {
        if (inFlight.has(doc.id)) continue;
        inFlight.add(doc.id);

        const job = doc.data() as QueueJob;

        try {
          // Drop jobs that are too old (stuck/corrupt) without sending
          const createdMs = job.createdAt?.toMillis?.() ?? Date.now();
          if (Date.now() - createdMs > MAX_JOB_AGE_MS) {
            await doc.ref.delete();
            console.log(`🪝 Dropped stale job ${doc.id}`);
            continue;
          }

          // ping => friendly "connected" message
          if (job.event === "ping") {
            await sock.sendMessage(job.targetJid, {
              text: "✅ *GitHub webhook connected!*\nThis chat will now receive repo events.",
            });
            await doc.ref.delete();
            console.log(`🪝 ping => ${job.targetJid}, job deleted`);
            continue;
          }

          // Event filter (re-checked bot-side in case config changed)
          if (!wantsEvent(job.events, job.event)) {
            await doc.ref.delete(); // not wanted - drop quietly
            continue;
          }

          // Format and send
          const formatted = formatEvent(job.event, job.payload);
          if (!formatted) {
            // Sub-action not worth notifying (e.g. PR labeled) - drop
            await doc.ref.delete();
            continue;
          }

          await sock.sendMessage(job.targetJid, { text: formatted.text });
          await doc.ref.delete(); // clean up after successful send
          console.log(`🪝 ${job.event} => ${job.targetJid} (${formatted.repoName ?? "?"}), job deleted`);

        } catch (err) {
          // On failure, DON'T delete - leave it for the next poll to retry.
          console.error(`🪝 Failed to process job ${doc.id}:`, err);
        } finally {
          inFlight.delete(doc.id);
        }
      }
    } catch (err) {
      console.error("🪝 Webhook queue poll error:", err);
    }
  };

  void poll(); // immediate first pass
  setInterval(poll, POLL_INTERVAL_MS);
}