import { WAMessage, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes, writeBarcode } from "zxing-wasm";
import { Command } from "./_types.js";
import { scanQr } from "../lib/old-hi-hive/scan-qr.js";
import type { ScanQrResult } from "../lib/old-hi-hive/types.js";

/*
  !scan                          — reply to an image → scan QR, return regenerated QR + raw string
  !scan attendance               — reply to an image → scan QR, submit to attendance API
  !scan attendance <raw_qr>      — submit a raw QR string directly to attendance API

  The original !scan behaviour (image → zxing decode → regenerated QR) is
  preserved exactly. The `attendance` subcommand reuses the same image-reading
  pipeline but feeds the extracted string into the hi-hive scanQr() module
  instead of regenerating a QR image.
*/

// ─── zxing helpers (your original code, unchanged) ───────────────────────────

async function createQR(link: string): Promise<Blob | null> {
    try {
        const writeResult = await writeBarcode(link, {
            format: "QRCode",
            scale: 3,
            addQuietZones: true,
        });
        return writeResult.image;
    } catch (error) {
        console.error("Failed to generate QR:", error);
        throw error;
    }
}

async function scanQR(imageInput: File | Blob | ArrayBuffer | Uint8Array): Promise<string | null> {
    try {
        const readResults = await readBarcodes(imageInput, {
            tryHarder: true,
            formats: ["QRCode"],
            maxNumberOfSymbols: 1,
        });
        if (readResults.length > 0) return readResults[0].text;
        return null;
    } catch (error) {
        console.error("Failed to read QR:", error);
        return null;
    }
}

// ─── Image extraction helper ─────────────────────────────────────────────────

/*
  Pull an imageMessage out of the incoming message, checking:
    1. A direct image sent with !scan as the caption
    2. A quoted image (user replied to an image with !scan)
  Returns null if no image is found.
*/
function extractImageMessage(msg: WAMessage): any | null {
    const messageBody = msg.message?.ephemeralMessage?.message || msg.message;
    if (!messageBody) return null;

    // Direct image with caption
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

/*
  Download the image from a WhatsApp imageMessage and return it as a Buffer.
*/
async function downloadImage(imageMessage: any, msg: WAMessage): Promise<Buffer> {
    const stream = await downloadContentFromMessage(imageMessage, "image");
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

// ─── Attendance result formatter (from previous scan.ts) ─────────────────────

const EXPIRY_EMOJI: Record<string, string> = {
    in_window: "✅",
    too_early: "⏳",
    expired:   "⚠️",
    unknown:   "❓",
};

function formatScanResult(result: ScanQrResult): string {
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
                lines.push(`❌ *Not Marked*`);
                lines.push(`📋 ${result.message}`);
                break;
            case "invalid_qr":
                lines.push(`❌ *Invalid QR*`);
                lines.push(result.message);
                break;
            case "auth_error":
                lines.push(`🔐 *Auth Error*`);
                lines.push(result.message);
                lines.push(`\n💡 Try _!refresh_ to get a new session.`);
                break;
            case "network_error":
                lines.push(`🌐 *Network Error*`);
                lines.push(result.message);
                break;
            case "unreadable":
                lines.push(`⚠️ *Unreadable Response*`);
                lines.push(result.message);
                break;
            default:
                lines.push(`⚠️ *Unknown Status:* ${result.status}`);
                lines.push(result.message);
        }
    }

    return lines.join("\n");
}

// ─── Sub-handlers ─────────────────────────────────────────────────────────────

/*
  !scan — your original behaviour, unchanged.
  Reply to an image → decode QR → regenerate QR image → send back.
*/
async function handleScanImage(sock: any, msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid!;

    const imageMessage = extractImageMessage(msg);
    if (!imageMessage) {
        await sock.sendMessage(jid, {
            text: "⚠️ Please send an image or reply to one with `!scan`.",
        }, { quoted: msg });
        return;
    }

    if (!imageMessage.url && !imageMessage.directPath) {
        await sock.sendMessage(jid, {
            text: "⏳ WhatsApp is still processing this image. Please wait 3 seconds and try again!",
        }, { quoted: msg });
        return;
    }

    await sock.sendMessage(jid, { text: "⏳ Scanning and enhancing..." }, { quoted: msg });

    const buffer = await downloadImage(imageMessage, msg);
    const extractedLink = await scanQR(buffer);

    if (!extractedLink) {
        await sock.sendMessage(jid, {
            text: "❌ No valid QR code detected. WhatsApp compression might have blurred it!",
        });
        return;
    }

    const newQrBlob = await createQR(extractedLink);
    if (!newQrBlob) throw new Error("createQR returned null");

    const finalImageBuffer = Buffer.from(await newQrBlob.arrayBuffer());

    await sock.sendMessage(jid, {
        image: finalImageBuffer,
        caption: `✅ *QR Scanned Successfully*\n\n🔗 *Content:*\n\`${extractedLink}\``,
        mimetype: "image/png",
    }, { quoted: msg });
}

/*
  !scan attendance               — extract QR from replied image, then submit to attendance API
  !scan attendance <raw_qr>      — submit raw QR string directly to attendance API
*/
async function handleScanAttendance(sock: any, msg: WAMessage, rawQrArg: string): Promise<void> {
    const jid = msg.key.remoteJid!;

    let rawQr: string;

    if (rawQrArg) {
        // Raw QR string provided directly in the message text
        rawQr = rawQrArg;
    } else {
        // No raw string — extract from the replied/attached image
        const imageMessage = extractImageMessage(msg);
        if (!imageMessage) {
            await sock.sendMessage(jid, {
                text:
                    "⚠️ *Usage:*\n" +
                    "• Reply to a QR image: `!scan attendance`\n" +
                    "• Paste raw QR string: `!scan attendance Q01:*:abc123...`",
            }, { quoted: msg });
            return;
        }

        if (!imageMessage.url && !imageMessage.directPath) {
            await sock.sendMessage(jid, {
                text: "⏳ WhatsApp is still processing this image. Please wait 3 seconds and try again!",
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(jid, { text: "⏳ Reading QR from image..." }, { quoted: msg });

        const buffer = await downloadImage(imageMessage, msg);
        const extracted = await scanQR(buffer);

        if (!extracted) {
            await sock.sendMessage(jid, {
                text: "❌ No valid QR code detected in the image. WhatsApp compression might have blurred it!",
            });
            return;
        }

        rawQr = extracted;
        // Let the user see what was extracted before we hit the API
        await sock.sendMessage(jid, {
            text: `🔍 *QR Extracted:*\n\`${rawQr}\`\n\n⏳ Submitting to attendance API...`,
        }, { quoted: msg });
    }

    await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } });

    const result = await scanQr(rawQr);
    const reply = formatScanResult(result);

    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    await sock.sendMessage(jid, {
        react: { text: result.ok ? "✅" : "❌", key: msg.key },
    });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleScan(sock: any, msg: WAMessage, text: string): Promise<void> {
    if (!msg.key.remoteJid) return;

    // Everything after "!scan" — e.g. "", "attendance", "attendance Q01:*:abc..."
    const args = text.slice("!scan".length).trim();

    // Route: !scan attendance [raw_qr]
    if (args.toLowerCase().startsWith("attendance")) {
        const rawQrArg = args.slice("attendance".length).trim();
        try {
            await handleScanAttendance(sock, msg, rawQrArg);
        } catch (err: any) {
            console.error("!scan attendance error:", err);
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Unexpected error: ${err?.message ?? err}`,
            }, { quoted: msg });
            await sock.sendMessage(msg.key.remoteJid, {
                react: { text: "❌", key: msg.key },
            });
        }
        return;
    }

    // Route: !scan — original image scan behaviour
    try {
        await handleScanImage(sock, msg);
    } catch (err: any) {
        console.error("!scan error:", err);
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ An internal error occurred while processing the QR code.",
        }, { quoted: msg });
    }
}

// ─── Command definition ───────────────────────────────────────────────────────

const command: Command = {
    name: "scan",
    description: "Scan a QR code from an image, or submit one to mark attendance",
    usage: "!scan  |  !scan attendance  |  !scan attendance <raw_qr>",
    requiresArgs: false,
    handler: handleScan,
};

export default command;