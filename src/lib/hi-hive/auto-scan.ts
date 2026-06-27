/**
 * auto-scan.ts — src/lib/hi-hive/auto-scan.ts
 */

import { WAMessage, WASocket, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes } from "zxing-wasm";
import { scanQr } from "./scan-qr.js";
import type { ScanQrResult, SimpleScanQrResult } from "./types.js";
import { getAllDocs } from "./creds.js";

const VALID_QR_TYPES = ["Q01", "Q02", "E01", "LQR", "CTR"];
const QR_SEPARATOR   = ":*:";

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
    console.log(`[autoScan] ✅ valid attendance QR — submitting for userId=${userId}`);
    await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

    const results: [string, SimpleScanQrResult][] = [];

    for (const [_docId, creds] of Object.entries(await getAllDocs()))
    {
      const result: ScanQrResult | undefined = await scanQr(userId, extracted);

      results.push([creds.hidden ? '*'.repeat(creds.id.length) : creds.id, {
        status: result?.status,
        datetime: new Date()
      }]);

      if (result === undefined)
      {
        console.log(`⚠️ [autoScan]: Document with ID \`${creds.id}\` is likely corrupted.`)
        continue;
      }
      else
      {
        console.log(`[autoScan]: Scanning for attendance \`${creds.id}\` done!`);
        continue;
      }
      /*
      if (result === undefined) {
        await sock.sendMessage(chatId, {
          text: "⚠️ *Auto-scan:* Creds not set. Please configure your hi_hive Firestore document.",
        }, { quoted: msg });
        await sock.sendMessage(chatId, { react: { text: "❌", key: msg.key } });
        return true;
      }

      const caption  = formatResult(result);
      const imageUrl = (result as any).imageUrl as string | null;

      if (imageUrl) {
        try {
          const imgRes = await fetch(imageUrl);
          const imgBuf = Buffer.from(await imgRes.arrayBuffer());
          await sock.sendMessage(chatId, {
            image: imgBuf, caption, mimetype: "image/png",
          }, { quoted: msg });
        } catch {
          await sock.sendMessage(chatId, { text: caption }, { quoted: msg });
        }
      } else {
        await sock.sendMessage(chatId, { text: caption }, { quoted: msg });
      }

      await sock.sendMessage(chatId, {
        react: { text: result.ok ? "✅" : "❌", key: msg.key },
      });
      */
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