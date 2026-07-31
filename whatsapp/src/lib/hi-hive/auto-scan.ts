/**
 * auto-scan.ts — src/lib/hi-hive/auto-scan.ts
 *
 * Every image that arrives is inspected for an attendance QR. Scanning is
 * unconditional; the whitelist only decides who hears about it.
 *
 * A caption containing `!ignore` (see config/scan-ignore.ts) opts an image out
 * entirely, so a QR can be shared without being submitted.
 */

import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { getAllDocs } from "../../../../shared/hi-hive/creds.js";
import { formatWaitingNoticeGrouped, randomDelaySec } from "../../../../shared/hi-hive/scan-buffer.js";
import { alreadyProcessed, queueText, reactNow } from "../outbox.js";
import { enqueueBatch, newId as newBufferId, incrementContribution } from "../../../../shared/hi-hive/scan-buffer-db.js";
import { resolveDestinations, includesStudent, resolveScannedBy, scannedByHeader } from "./report-targets.js";
import { decodeQr } from "../../../../shared/hi-hive/legacy/decode-qr.js";
import { findImage, isMediaReady, downloadMedia, formatBytes } from "../media.js";
import { readQrCodes, isAttendanceQr, QR_SEPARATOR } from "../../../../shared/lib/qr.js";
import { extractMessageText } from "../wa-text.js";
import { resolveIds } from "../jid.js";
import { isScanIgnored } from "../../config/scan-ignore.js";

/*
Duplicate delivery guard — PERSISTENT.

Baileys can deliver the same message twice ("notify" then "append", or a replay
after reconnect). It used to be an in-memory Set, which was fine for that, but
the set is empty after a restart — and now that we deliberately catch up on
images received while the bot was offline, an in-memory guard would let a QR be
re-scanned that had already been handled before the restart.

alreadyProcessed() is backed by Postgres with an INSERT ... ON CONFLICT, so the
check and the record are one atomic operation.
*/

export async function tryAutoScan(sock: WASocket, msg: WAMessage): Promise<boolean> {
  // Wrap EVERYTHING in try-catch so exceptions don't silently swallow the result
  try {
    const image = findImage(msg);
    if (!image || image.fromQuoted) {
      // Only freshly-sent images are auto-scanned; a reply to an old photo is
      // the user talking about it, not submitting it.
      return false;
    }

    if (!isMediaReady(image)) {
      console.log(`[autoScan] skip: image not ready yet`);
      return false;
    }

    // ── Opt-out ─────────────────────────────────────────────────────────────
    const caption = extractMessageText(msg);
    if (isScanIgnored(caption)) {
      console.log(`[autoScan] caption asks to ignore this image — not scanning.`);
      const jid = msg.key.remoteJid;
      if (jid) await reactNow(jid, "🚫", msg.key);
      return true;   // handled: no scan, and no command dispatch either
    }

    const ids = resolveIds(msg);
    if (!ids) {
      console.log(`[autoScan] skip: could not resolve chat/user for ${msg.key.remoteJid}`);
      return false;
    }
    const { chatId, userId } = ids;
    console.log(`[autoScan] chatId=${chatId}  userId=${userId}`);

    // ── Download and read ───────────────────────────────────────────────────
    const buf = await downloadMedia(image);
    console.log(`[autoScan] downloaded ${formatBytes(buf.length)}`);

    const allTexts = await readQrCodes(buf);
    if (allTexts.length === 0) {
      console.log(`[autoScan] no QR found in image (${formatBytes(buf.length)})`);
      return false;
    }

    // Prefer an attendance-format QR; a photo may also contain unrelated codes.
    const distinctQrs = allTexts.filter(isAttendanceQr);
    if (distinctQrs.length === 0) {
      console.log(`[autoScan] ${allTexts.length} QR(s) found but none are attendance QRs: ` +
        allTexts.map(t => t.split(QR_SEPARATOR)[0]).join(", "));
      return false;
    }
    if (distinctQrs.length > 1) {
      console.log(`[autoScan] 📚 ${distinctQrs.length} attendance QRs in this image — all will be scanned.`);
    }
    distinctQrs.forEach((q, i) => console.log(`[autoScan] QR[${i}]: ${q.slice(0, 60)}`));

    // ── Decode every QR (course code per QR, used for headers and grouping) ─
    const qrEntries = distinctQrs.map(raw => {
      const d = decodeQr(userId, raw);
      const info = d.ok ? d.decoded.info : undefined;
      return {
        raw,
        courseCode: info?.courseCode ?? null,
        datetime:   info?.datetime   ?? null,
      };
    });
    for (const q of qrEntries) {
      console.log(`[autoScan] QR course=${q.courseCode ?? "?"} datetime=${q.datetime ?? "?"}`);
    }

    // ── Duplicate delivery guard ────────────────────────────────────────────
    if (await alreadyProcessed(msg.key.id)) {
      console.log(`[autoScan] message ${msg.key.id} already handled — ignoring duplicate delivery.`);
      return true;
    }

    // ── Scanning is UNCONDITIONAL ────────────────────────────────────────────
    // Every QR is scanned wherever it lands. The whitelist only decides whether
    // this chat hears back about it — see resolveDestinations().
    const { destinations, originSilent } = await resolveDestinations(sock, msg, chatId);

    // Who supplied this QR? Used for the header and the contribution ranking.
    const scannedBy = await resolveScannedBy(sock, msg, chatId);
    if (scannedBy.docId) {
      try { await incrementContribution(scannedBy.docId); }
      catch (e) { console.error("[autoScan] contribution credit failed:", e); }
    }
    console.log(`[autoScan] scanned by ${scannedBy.label} (${scannedBy.docId ?? "unregistered"})`);

    // Non-whitelisted group with no reportSettings rule: scan silently and just
    // thank the sender with a ❤️ instead of the usual ⏳/✅ flow.
    await reactNow(chatId, originSilent ? "❤️" : "⏳", msg.key);

    console.log(`[autoScan] destinations=${destinations.length} originSilent=${originSilent}`);

    // ── Build the batch and PERSIST it ───────────────────────────────────────
    const accounts = Object.entries(await getAllDocs()) as [string, { id: string; hidden: boolean }][];
    if (accounts.length === 0) {
      if (!originSilent) {
        await queueText(chatId, "📭 No accounts registered to scan.", { quotedKey: msg.key });
      }
      return true;
    }

    const batchId   = newBufferId();
    const startedAt = Date.now();

    /*
    One message = ONE batch, containing a job for every (account × QR) pair.

    Keeping it in a single batch is what makes multi-QR safe: the completion
    check and the atomic report claim already work per-batch, so several courses
    produce exactly one delay notice and one report — never the duplicate
    batches that previously came from processing an image twice.
    */
    const jobs = accounts
      .flatMap(([docId, creds]) =>
        qrEntries.map(q => {
          const delaySec = randomDelaySec();
          return {
            id:           newBufferId(),
            batchId,
            docId,
            studentId:    creds.id,
            label:        creds.hidden ? "*".repeat(creds.id.length) : creds.id,
            rawQr:        q.raw,
            chatId,
            quotedKey:    msg.key,
            destinations,
            originSilent,
            scannedBy:    scannedBy.label,
            courseCode:   q.courseCode,
            dueAt:        startedAt + Math.round(delaySec * 1000),
            delaySec,
          };
        })
      )
      .sort((a, b) => a.dueAt - b.dueAt);

    console.log(`[autoScan] ${accounts.length} account(s) × ${qrEntries.length} QR(s) = ${jobs.length} job(s)`);

    await enqueueBatch(jobs.map(({ delaySec, ...row }) => row));

    // ── Delay message: one filtered copy per destination ─────────────────────
    // The status gate can't apply yet (nothing has been scanned), so a
    // destination hears the queue notice if any of its students are in it.
    for (const dest of destinations) {
      if (!dest.showDelay) {
        console.log(`[autoScan] ${dest.chatId}: showDelay=false — skipping queue notice.`);
        continue;
      }

      let mine = jobs.filter(j => includesStudent(dest, j.studentId));

      // Safety net: a filter that matches nobody would leave the ORIGIN chat
      // silent, which looks like the bot ignored the QR. Fall back to showing
      // everyone there. Configured (non-origin) chats stay strictly filtered.
      if (mine.length === 0) {
        if (!dest.isOrigin) continue;
        console.log(`[autoScan] ${dest.chatId}: filter matched nobody — showing all (origin chat).`);
        mine = jobs;
      }

      try {
        await queueText(
          dest.chatId,
          scannedByHeader(scannedBy.label) + formatWaitingNoticeGrouped(mine),
          {
            priority: 4,
            quotedKey: dest.isOrigin ? msg.key : undefined,
            quoted: dest.isOrigin ? msg : undefined,
          }
        );
      } catch (err) {
        console.error(`[autoScan] delay notice to ${dest.chatId} failed:`, err);
      }
    }

    console.log(`[autoScan] queued batch ${batchId} (${jobs.length} accounts)`);
    // The scan-buffer service picks these up as they come due.

    await reactNow(chatId, "✅", msg.key);
    return true;

  } catch (err) {
    // Catch-all so exceptions never silently kill the handler
    console.error(`[autoScan] UNCAUGHT ERROR:`, err);
    return false;
  }
}
