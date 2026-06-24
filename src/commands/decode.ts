import { WAMessage, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes } from "zxing-wasm";
import { Command } from "./_types.js";
import { decodeQr } from "../lib/old-hi-hive/decode-qr.js";
import type { DecodedQr } from "../lib/old-hi-hive/types.js";

/*
  !decode                — send or reply to a QR image → zxing scan → validate attendance header → decode offline
  !decode <raw_qr>       — decode a raw QR string directly (original behaviour, unchanged)

  "Fits the attendance header" means the extracted string starts with one of
  the known QR types (E01, Q01, Q02, LQR, CTR) followed by the ":*:" separator.
  If the image contains a QR but it's not an attendance QR, the user is told
  what was found rather than giving a generic "decode failed" error.
*/

// ─── Known attendance QR types (from decode-qr.ts / scanner.py) ──────────────

const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"];
const QR_SEPARATOR   = ":*:";

function isAttendanceQr(raw: string): boolean {
    const sep = raw.indexOf(QR_SEPARATOR);
    if (sep === -1) return false;
    return VALID_QR_TYPES.includes(raw.substring(0, sep));
}

// ─── Image helpers (same pattern as scan.ts) ──────────────────────────────────

function extractImageMessage(msg: WAMessage): any | null {
    const messageBody = msg.message?.ephemeralMessage?.message || msg.message;
    if (!messageBody) return null;

    // Direct image sent with !decode as caption
    if ((messageBody as any).imageMessage) {
        return (messageBody as any).imageMessage;
    }

    // Reply to an image
    const quoted = (messageBody as any).extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted?.imageMessage) {
        return quoted.imageMessage;
    }

    return null;
}

async function downloadImage(imageMessage: any): Promise<Buffer> {
    const stream = await downloadContentFromMessage(imageMessage, "image");
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

async function scanQR(imageInput: Uint8Array): Promise<string | null> {
    try {
        const results = await readBarcodes(imageInput, {
            tryHarder: true,
            formats: ["QRCode"],
            maxNumberOfSymbols: 1,
        });
        return results.length > 0 ? results[0].text : null;
    } catch {
        return null;
    }
}

// ─── Result formatter ─────────────────────────────────────────────────────────

const VERDICT_LABEL: Record<string, string> = {
    in_window: "✅ LIKELY VALID",
    expired:   "❌ LIKELY EXPIRED",
    too_early: "⏳ NOT OPEN YET",
    unknown:   "❓ UNKNOWN",
};

function formatDecoded(decoded: DecodedQr, source: "image" | "text"): string {
    const lines: string[] = [];

    const sourceNote = source === "image"
        ? "🖼️ *Decoded from image (offline — no server call)*"
        : "🔍 *Decoded QR (offline — no server call)*";

    lines.push(sourceNote);
    lines.push("─".repeat(36));
    lines.push(`*Type:*     ${decoded.type}`);
    lines.push(`*Class ID:* ${decoded.classId ?? "—"}`);
    lines.push(`*Raw:*      \`${decoded.raw}\``);
    lines.push("");

    const info = decoded.info;

    if (decoded.type === "Q01" || decoded.type === "Q02") {
        lines.push("📋 *Class Info*");
        lines.push(`• Course:    ${info.courseCode  || "—"}`);
        lines.push(`• Session:   ${info.sessionType || "—"}`);
        lines.push(`• Group:     ${info.group       || "—"}`);
        lines.push(`• Date/Time: ${info.datetime    || "—"}`);
        lines.push(`• Hours:     ${info.hours       || "—"}`);
    } else if (decoded.type === "E01") {
        lines.push("📋 *Event Info*");
        lines.push(`• Event: ${info.eventName || "—"}`);
        lines.push(`• From:  ${info.from      || "—"}`);
        lines.push(`• To:    ${info.to        || "—"}`);
        lines.push(`• Venue: ${info.venue     || "—"}`);
    } else {
        lines.push(`📋 *QR Type:* ${decoded.type}`);
    }

    lines.push("");
    lines.push("─".repeat(36));
    lines.push(`⏱️ *Expiry:* ${VERDICT_LABEL[decoded.expiry.verdict] ?? decoded.expiry.verdict}`);
    lines.push(`_${decoded.expiry.reason}_`);
    lines.push("_(Prediction only — server clock is the final authority)_");

    return lines.join("\n");
}

// ─── Sub-handlers ─────────────────────────────────────────────────────────────

async function handleDecodeImage(sock: any, msg: WAMessage): Promise<void> {
    if (!msg.key.remoteJid) return;

    let chatId: string = '';
    let userId: string = '';

    if (!msg.key.participant && msg.key.remoteJid.endsWith('@lid'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.remoteJid;
    }
    else if (msg.key.participant && msg.key.remoteJid.endsWith('@g.us'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.participant;
    }
    else
    {
        console.log('Unexpected result...');
        return;
    }

    const imageMessage = extractImageMessage(msg);
    if (!imageMessage) {
        await sock.sendMessage(chatId, {
            text:
                "⚠️ *Usage:*\n" +
                "• Send/reply to a QR image: `!decode`\n" +
                "• Paste raw QR string: `!decode Q01:*:abc123...`",
        }, { quoted: msg });
        return;
    }

    if (!imageMessage.url && !imageMessage.directPath) {
        await sock.sendMessage(chatId, {
            text: "⏳ WhatsApp is still processing this image. Please wait a moment and try again.",
        }, { quoted: msg });
        return;
    }

    await sock.sendMessage(chatId, { text: "⏳ Reading QR from image..." }, { quoted: msg });

    const buffer = await downloadImage(imageMessage);
    const extracted = await scanQR(buffer);

    // No QR detected at all
    if (!extracted) {
        await sock.sendMessage(chatId, {
            text: "❌ *No QR code detected in the image.*\nWhatsApp compression may have blurred it — try sending the original file.",
        }, { quoted: msg });
        return;
    }

    // QR found but it's not an attendance QR
    if (!isAttendanceQr(extracted)) {
        await sock.sendMessage(chatId, {
            text:
                `⚠️ *QR code found, but it's not an attendance QR.*\n\n` +
                `🔗 *Content:* \`${extracted}\`\n\n` +
                `_Expected one of: ${VALID_QR_TYPES.join(", ")} before \`:*:\`_`,
        }, { quoted: msg });
        return;
    }

    // Valid attendance QR — decode it
    const result = decodeQr(userId, extracted);

    if (!result.ok) {
        await sock.sendMessage(chatId, {
            text: `❌ *Decode failed*\n${result.error}`,
        }, { quoted: msg });
        return;
    }

    await sock.sendMessage(chatId, {
        text: formatDecoded(result.decoded, "image"),
    }, { quoted: msg });
}

async function handleDecodeText(sock: any, msg: WAMessage, rawQr: string): Promise<void> {
    if (!msg.key.remoteJid) return;

    let chatId: string = '';
    let userId: string = '';

    if (!msg.key.participant && msg.key.remoteJid.endsWith('@lid'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.remoteJid;
    }
    else if (msg.key.participant && msg.key.remoteJid.endsWith('@g.us'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.participant;
    }
    else
    {
        console.log('Unexpected result...');
        return;
    }

    const result = decodeQr(userId, rawQr);

    if (!result.ok) {
        await sock.sendMessage(chatId, {
            text: `❌ *Decode failed*\n${result.error}`,
        }, { quoted: msg });
        return;
    }

    await sock.sendMessage(chatId, {
        text: formatDecoded(result.decoded, "text"),
    }, { quoted: msg });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleDecode(sock: any, msg: WAMessage, text: string): Promise<void> {
    if (!msg.key.remoteJid) return;

    const rawQr = text.slice("!decode".length).trim();

    try {
        if (rawQr) {
            // Raw QR string provided as text — original behaviour
            await handleDecodeText(sock, msg, rawQr);
        } else {
            // No text after !decode — look for an image
            await handleDecodeImage(sock, msg);
        }
    } catch (err: any) {
        console.error("!decode error:", err);
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Unexpected error: ${err?.message ?? err}`,
        }, { quoted: msg });
    }
}

// ─── Command definition ───────────────────────────────────────────────────────

const command: Command = {
    name: "decode",
    aliases: ["d"],
    description: "Offline-inspect a QR code from an image or a raw QR string",
    usage: "!decode  |  !decode <raw_qr>",
    requiresArgs: false,
    handler: handleDecode,
};

export default command;