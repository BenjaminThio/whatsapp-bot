/**
 * auto-scan.ts — src/lib/hi-hive/auto-scan.ts
 */

import { WAMessage, WASocket, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes } from "zxing-wasm/full";
import { ensureZXingReady } from "./zxing-init.js";
import { scanQr } from "./scan-qr.js";
import type { ScanQrResult, SimpleScanQrResult } from "./types.js";
import { getAllDocs } from "./creds.js";
import { validateAccount, buildScheduleSlots, matchesSchedule, isAlreadyRecorded } from "./account-validation.js";
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

    // ── Submit attendance ───────────────────────────────────────────────────
    console.log(`[autoScan] ✅ valid attendance QR — validating accounts for userId=${userId}`);
    await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

    // Decode the QR once so we know its course/datetime/group (for smart-skip)
    const decoded = decodeQr(userId, extracted);
    const qrInfo  = decoded.ok ? decoded.decoded.info : undefined;

    const results: [string, SimpleScanQrResult][] = [];

    for (const [docId, creds] of Object.entries(await getAllDocs()))
    {
      const label = creds.hidden ? "*".repeat(creds.id.length) : creds.id;

      // ── Feature 1: account-existence validation ──────────────────────────
      // Fetch this account's attendance and confirm the profile Student ID
      // matches its credentials. A fake account (e.g. 999999) won't match.
      const check = await validateAccount(docId, creds.id);

      if (!check.exists) {
        console.log(`[autoScan] ⛔ skipping ${label}: ${check.reason}`);
        results.push([label, { status: "rejected", datetime: new Date() }]);
        continue;
      }
      console.log(`[autoScan] ✔ ${label} verified: ${check.reason}`);

      // ── Skip if this class is ALREADY recorded as attended ────────────────
      // Reuses the attendance we just fetched for validation (no extra call).
      // If the class isn't recorded yet, or a previous attempt failed/was an
      // absence, we fall through and (re)scan.
      if (check.attendance && qrInfo?.courseCode && qrInfo?.datetime) {
        const already = isAlreadyRecorded(check.attendance, {
          courseCode:   qrInfo.courseCode,
          classDatetime: qrInfo.datetime,
          group:        qrInfo.group ?? "",
        });
        if (already.recorded) {
          console.log(`[autoScan] ✅ ${label}: ${qrInfo.courseCode} @ ${qrInfo.datetime} already recorded — skipping re-scan`);
          results.push([label, { status: "marked", datetime: new Date() }]);
          continue;
        }
      }

      // ── Feature 3 (optional): smart-schedule skip ────────────────────────
      // Skip if the QR doesn't match this account's historical timetable.
      // Off by default; needs ≥1 week of history to have any slots.
      if (SMART_SCHEDULE_SKIP && check.attendance && qrInfo?.courseCode && qrInfo?.datetime) {
        const slots = buildScheduleSlots(check.attendance);
        const fits = matchesSchedule(slots, {
          courseCode:   qrInfo.courseCode,
          classDatetime: qrInfo.datetime,
          group:        qrInfo.group ?? "",
        });
        if (!fits) {
          console.log(`[autoScan] 🧠 smart-skip ${label}: QR (${qrInfo.courseCode} @ ${qrInfo.datetime}) not in known schedule`);
          results.push([label, { status: "rejected", datetime: new Date() }]);
          continue;
        }
      }

      // ── Submit the scan for THIS account (was a bug: used userId before) ──
      const result: ScanQrResult | undefined = await scanQr(docId, extracted);

      results.push([label, {
        status: result?.status,
        datetime: new Date(),
      }]);

      if (result === undefined) {
        console.log(`⚠️ [autoScan]: Document with ID \`${creds.id}\` is likely corrupted.`);
        continue;
      } else {
        console.log(`[autoScan]: Scanning for attendance \`${creds.id}\` done! (status=${result.status})`);
        continue;
      }
    }

    
    // Optional helper function to format the time nicely (e.g., "14:30:05")
    const formatTime = (date: Date) => {
        return date.toLocaleTimeString('en-US', { hour12: false });
    };

    const reportLines = results.map(([studentId, result]: [string, SimpleScanQrResult]) => {
        const time = formatTime(result.datetime);

        if (result.status === undefined) {
            return `❌ *[${time}]* \`${studentId}\` ➔ _Failed to scan_`;
        } else {
            return `${result.status === 'marked' ? '✅' : '❌'} *[${time}]* \`${studentId}\` ➔ *Status:* \`${result.status}\``;
        }
    });

    const finalMessage = `📋 *AUTO SCAN REPORT*\n\n${reportLines.join('\n')}\n\n🏁 *Completed at:* \`${formatTime(new Date())}\``;

    await sock.sendMessage(chatId, { 
        text: finalMessage 
    }, { quoted: msg });

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