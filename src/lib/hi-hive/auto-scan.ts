/**
 * auto-scan.ts — src/lib/hi-hive/auto-scan.ts
 */

import { WAMessage, WASocket, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes } from "zxing-wasm/full";
import { ensureZXingReady } from "./zxing-init.js";
import { scanQr } from "./scan-qr.js";
import type { ScanQrResult } from "./types.js";
import { getAllDocs } from "./creds.js";
import { validateAccount, buildScheduleSlots, matchesSchedule, isAlreadyRecorded } from "./account-validation.js";
import { canonicalCode } from "./course-aliases.js";
import { ReportStatus, STATUS_META, fromScanStatus, formatStatusLine } from "./scan-status.js";
import { formatWaitingNotice, randomDelaySec } from "./scan-buffer.js";
import { enqueueBatch, newId as newBufferId, isWhitelisted } from "./scan-buffer-db.js";
import { decodeQr } from "../old-hi-hive/decode-qr.js";

const VALID_QR_TYPES = ["Q01", "Q02", "E01", "LQR", "CTR"];
const QR_SEPARATOR   = ":*:";

// ── Feature 3: smart-schedule skip ────────────────────────────────────────────
// When ON, an account's scan is skipped if the QR's course/day/time/group has
// never appeared in that account's historical attendance (i.e. not their class).
// OFF by default — flip with SMART_SCHEDULE_SKIP=1 once you trust it.
const SMART_SCHEDULE_SKIP = process.env["SMART_SCHEDULE_SKIP"] === "1";

const EXPIRY_EMOJI: Record<string, string> = {
  in_window: "✅",
  too_early: "⏳",
  expired:   "⚠️",
  unknown:   "❓",
};

function isAttendanceQr(raw: string): boolean {
  const sep = raw.indexOf(QR_SEPARATOR);
  if (sep === -1) return false;
  return VALID_QR_TYPES.includes(raw.substring(0, sep));
}

function resolveIds(msg: WAMessage): { chatId: string; userId: string } | null {
  const jid = msg.key.remoteJid;
  if (!jid) return null;
  if (msg.key.participant && jid.endsWith("@g.us")) {
    return { chatId: jid, userId: msg.key.participant };
  }
  if (!msg.key.participant) {
    return { chatId: jid, userId: jid };
  }
  return null;
}

function formatResult(result: ScanQrResult): string {
  const lines: string[] = [];
  if (result.expiry) {
    const icon = EXPIRY_EMOJI[result.expiry.verdict] ?? "❓";
    lines.push(`${icon} *Pre-check:* ${result.expiry.reason}`);
  }
  lines.push("");
  if (result.ok) {
    lines.push(`✅ *${result.message}*`);
    if (result.courseCode) lines.push(`📚 *Course:* ${result.courseCode}`);
  } else {
    switch (result.status) {
      case "rejected":
        lines.push(`❌ *Not Marked*\n📋 ${result.message}`); break;
      case "token_expired":
        lines.push(`🔐 *Session Expired*\n${result.message}`); break;
      case "scanner_page":
        lines.push(`⏱️ *QR Window Missed*\n${result.message}`); break;
      case "auth_error":
        lines.push(`🔐 *Auth Error*\n${result.message}`); break;
      case "network_error":
        lines.push(`🌐 *Network Error*\n${result.message}`); break;
      default:
        lines.push(`⚠️ *${result.status}*\n${result.message}`);
    }
  }
  return lines.join("\n");
}

export async function tryAutoScan(sock: WASocket, msg: WAMessage): Promise<boolean> {
  // Wrap EVERYTHING in try-catch so exceptions don't silently swallow the result
  try {
    // ── Log every single field we inspect ──────────────────────────────────
    const jid         = msg.key.remoteJid;
    const participant = msg.key.participant;
    const msgKeys     = Object.keys(msg.message ?? {});
    const bodyKeys    = Object.keys(
      (msg.message?.ephemeralMessage?.message ?? msg.message ?? {}) as object
    );

    console.log(`[autoScan] called — jid=${jid} participant=${participant}`);
    console.log(`[autoScan] msg.message keys: ${msgKeys.join(", ")}`);
    console.log(`[autoScan] body keys: ${bodyKeys.join(", ")}`);

    // ── Extract imageMessage ────────────────────────────────────────────────
    const body = (msg.message?.ephemeralMessage?.message ?? msg.message) as any;
    const imageMessage = body?.imageMessage ?? null;

    if (!imageMessage) {
      console.log(`[autoScan] skip: no imageMessage in body`);
      return false;
    }

    console.log(`[autoScan] imageMessage found — url=${!!imageMessage.url} directPath=${!!imageMessage.directPath}`);

    if (!imageMessage.url && !imageMessage.directPath) {
      console.log(`[autoScan] skip: image not ready yet`);
      return false;
    }

    // ── Resolve chatId / userId ─────────────────────────────────────────────
    const ids = resolveIds(msg);
    if (!ids) {
      console.log(`[autoScan] skip: resolveIds returned null for jid=${jid} participant=${participant}`);
      return false;
    }
    const { chatId, userId } = ids;
    console.log(`[autoScan] chatId=${chatId}  userId=${userId}`);

    // ── Download image ──────────────────────────────────────────────────────
    console.log(`[autoScan] downloading image...`);
    const stream = await downloadContentFromMessage(imageMessage, "image");
    let buf = Buffer.from([]);
    for await (const chunk of stream) buf = Buffer.concat([buf, chunk]);
    console.log(`[autoScan] downloaded ${buf.length} bytes`);

    // ── Read QR with zxing ──────────────────────────────────────────────────
    console.log(`[autoScan] running zxing...`);
    ensureZXingReady();   // load local wasm (no CDN fetch) — safe to call repeatedly
    let extracted: string | null = null;
    try {
      const results = await readBarcodes(buf, {
        tryHarder: true,
        formats: ["QRCode"],
        maxNumberOfSymbols: 1,
      });
      extracted = results.length > 0 ? results[0].text : null;
    } catch (zxingErr) {
      console.log(`[autoScan] zxing error: ${zxingErr}`);
      return false;
    }

    if (!extracted) {
      console.log(`[autoScan] no QR found in image`);
      return false;
    }
    console.log(`[autoScan] QR extracted: ${extracted.slice(0, 80)}`);

    // ── Check attendance QR format ──────────────────────────────────────────
    if (!isAttendanceQr(extracted)) {
      console.log(`[autoScan] not an attendance QR (type=${extracted.split(QR_SEPARATOR)[0]}) — ignoring`);
      return false;
    }

    // ── Whitelist gate (GROUPS ONLY) ────────────────────────────────────────
    // Private chats always scan. Groups must be whitelisted via `!test whitelist`,
    // so a QR dropped in some random group is ignored.
    const isGroup = chatId.endsWith("@g.us");
    if (isGroup && !(await isWhitelisted(chatId))) {
      console.log(`[autoScan] group ${chatId} is not whitelisted — ignoring QR.`);
      return false;   // fall through to normal message handling
    }

    console.log(`[autoScan] ✅ valid attendance QR — queueing accounts`);
    await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

    // ── Build the batch and PERSIST it ───────────────────────────────────────
    // The queue lives in Postgres, not memory, so a crash/restart can't lose it.
    const accounts = Object.entries(await getAllDocs());
    if (accounts.length === 0) {
      await sock.sendMessage(chatId, { text: "📭 No accounts registered to scan." }, { quoted: msg });
      return true;
    }

    const batchId  = newBufferId();
    const startedAt = Date.now();

    const jobs = accounts
      .map(([docId, creds]) => {
        const delaySec = randomDelaySec();
        return {
          id:        newBufferId(),
          batchId,
          docId,
          label:     creds.hidden ? "*".repeat(creds.id.length) : creds.id,
          rawQr:     extracted,
          chatId,
          quotedKey: msg.key,
          dueAt:     startedAt + delaySec * 1000,
          delaySec,
        };
      })
      .sort((a, b) => a.dueAt - b.dueAt);

    await enqueueBatch(jobs.map(({ delaySec, ...row }) => row));

    // Waiting list — soonest first, so the LAST line is when it all finishes
    await sock.sendMessage(chatId, { text: formatWaitingNotice(jobs) }, { quoted: msg });
    console.log(`[autoScan] queued batch ${batchId} (${jobs.length} accounts)`);

    // The scan-buffer service picks these up as they come due.

    await sock.sendMessage(chatId, { 
        react: { text: "✅", key: msg.key } 
    });
    return true;

  } catch (err) {
    // Catch-all so exceptions never silently kill the handler
    console.error(`[autoScan] UNCAUGHT ERROR:`, err);
    return false;
  }
}