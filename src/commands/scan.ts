import { WAMessage, WASocket, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes, writeBarcode } from "zxing-wasm/full";
import { ensureZXingReady } from "../lib/hi-hive/zxing-init.js";
import { Command } from "./_types.js";
import { scanQr } from "../lib/hi-hive/scan-qr.js";
import type { ScanQrResult } from "../lib/hi-hive/types.js";

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
        ensureZXingReady();
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
        ensureZXingReady();
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
async function downloadImage(imageMessage: any, _msg: WAMessage): Promise<Buffer> {
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
        // "marked" covers both fresh attendance and "already recorded"
        lines.push(`✅ *${result.message}*`);
        if (result.courseCode) lines.push(`📚 *Course:* ${result.courseCode}`);
    } else {
        switch (result.status) {
            case "rejected":
                lines.push(`❌ *Not Marked*`);
                lines.push(`📋 ${result.message}`);
                break;
            case "token_expired":
                lines.push(`🔐 *Session Expired*`);
                lines.push(result.message);
                lines.push(`\n💡 Update _utarEncryptedData_ in creds.json, or set _utarStudentId_ for auto-generation.`);
                break;
            case "scanner_page":
                lines.push(`⏱️ *Scanner Page Returned*`);
                lines.push(result.message);
                lines.push(`\n💡 GPS may be wrong, or the QR window has passed.`);
                break;
            case "invalid_qr":
                lines.push(`❌ *Invalid QR*`);
                lines.push(result.message);
                break;
            case "auth_error":
                lines.push(`🔐 *Auth / Server Error*`);
                lines.push(result.message);
                lines.push(`\n💡 Check _utarStudentId_ / _utarEncryptedData_ in creds.json.`);
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
export async function handleScanAttendance(sock: WASocket, msg: WAMessage, chatId: string, userId: string, rawQrArg: string | undefined): Promise<void> {
    let rawQr: string;

    if (rawQrArg) {
        // Raw QR string provided directly in the message text
        rawQr = rawQrArg;
    } else {
        // No raw string — extract from the replied/attached image
        const imageMessage = extractImageMessage(msg);
        if (!imageMessage) {
            await sock.sendMessage(chatId, {
                text:
                    "⚠️ *Usage:*\n" +
                    "• Reply to a QR image: `!scan attendance`\n" +
                    "• Paste raw QR string: `!scan attendance Q01:*:abc123...`",
            }, { quoted: msg });
            return;
        }

        if (!imageMessage.url && !imageMessage.directPath) {
            await sock.sendMessage(chatId, {
                text: "⏳ WhatsApp is still processing this image. Please wait 3 seconds and try again!",
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(chatId, { text: "⏳ Reading QR from image..." }, { quoted: msg });

        const buffer = await downloadImage(imageMessage, msg);
        const extracted = await scanQR(buffer);

        if (!extracted) {
            await sock.sendMessage(chatId, {
                text: "❌ No valid QR code detected in the image. WhatsApp compression might have blurred it!",
            });
            return;
        }

        rawQr = extracted;
        // Let the user see what was extracted before we hit the API
        await sock.sendMessage(chatId, {
            text: `🔍 *QR Extracted:*\n\`${rawQr}\`\n\n⏳ Submitting to attendance API...`,
        }, { quoted: msg });
    }

    await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

    const result = await scanQr(userId, rawQr);
    if (result === undefined)
    {
        await sock.sendMessage(chatId, { text: 'Creds are not set. Please do !test for more info.' });
        return;
    }
    else
    {
        const reply = formatScanResult(result);

        // Send as image+caption if the server provided a result image, else plain text
        if ((result as any).imageUrl) {
            try {
                const imgRes = await fetch((result as any).imageUrl);
                const imgBuf = Buffer.from(await imgRes.arrayBuffer());
                await sock.sendMessage(chatId, {
                    image:    imgBuf,
                    caption:  reply,
                    mimetype: "image/png",
                }, { quoted: msg });
            } catch (imgErr) {
                console.error("[scan] Failed to fetch result image:", imgErr);
                // Fall back to plain text if image fetch fails
                await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
            }
        } else {
            await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
        }

        await sock.sendMessage(chatId, {
            react: { text: result.ok ? "✅" : "❌", key: msg.key },
        });
    }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleScan(sock: any, msg: WAMessage, text: string): Promise<void> {
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

    // Everything after "!scan" — e.g. "", "attendance", "attendance Q01:*:abc..."
    const args = text.slice("!scan".length).trim();

    // Route: !scan attendance [raw_qr]
    if (args.toLowerCase().startsWith("attendance")) {
        const rawQrArg = args.slice("attendance".length).trim();
        try {
            await handleScanAttendance(sock, msg, chatId, userId, rawQrArg);
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

/*
import { WAMessage, WASocket, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes, writeBarcode } from "zxing-wasm/full";
import { Command } from "./_types.js";
import { scanQr } from "../lib/hi-hive/scan-qr.js";
import type { ScanQrResult } from "../lib/hi-hive/types.js";

// ─── zxing helpers (your original code, unchanged) ───────────────────────────

async function createQR(link: string): Promise<Blob | null> {
    try {
        ensureZXingReady();
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
        // "marked" covers both fresh attendance and "already recorded"
        lines.push(`✅ *${result.message}*`);
        if (result.courseCode) lines.push(`📚 *Course:* ${result.courseCode}`);
    } else {
        switch (result.status) {
            case "rejected":
                lines.push(`❌ *Not Marked*`);
                lines.push(`📋 ${result.message}`);
                break;
            case "token_expired":
                lines.push(`🔐 *Session Expired*`);
                lines.push(result.message);
                lines.push(`\n💡 Update _utarEncryptedData_ in creds.json, or set _utarStudentId_ for auto-generation.`);
                break;
            case "scanner_page":
                lines.push(`⏱️ *Scanner Page Returned*`);
                lines.push(result.message);
                lines.push(`\n💡 GPS may be wrong, or the QR window has passed.`);
                break;
            case "invalid_qr":
                lines.push(`❌ *Invalid QR*`);
                lines.push(result.message);
                break;
            case "auth_error":
                lines.push(`🔐 *Auth / Server Error*`);
                lines.push(result.message);
                lines.push(`\n💡 Check _utarStudentId_ / _utarEncryptedData_ in creds.json.`);
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

async function handleScanAttendance(sock: WASocket, msg: WAMessage, rawQrArg: string): Promise<void> {
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

    let rawQr: string;

    if (rawQrArg) {
        // Raw QR string provided directly in the message text
        rawQr = rawQrArg;
    } else {
        // No raw string — extract from the replied/attached image
        const imageMessage = extractImageMessage(msg);
        if (!imageMessage) {
            await sock.sendMessage(chatId, {
                text:
                    "⚠️ *Usage:*\n" +
                    "• Reply to a QR image: `!scan attendance`\n" +
                    "• Paste raw QR string: `!scan attendance Q01:*:abc123...`",
            }, { quoted: msg });
            return;
        }

        if (!imageMessage.url && !imageMessage.directPath) {
            await sock.sendMessage(chatId, {
                text: "⏳ WhatsApp is still processing this image. Please wait 3 seconds and try again!",
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(chatId, { text: "⏳ Reading QR from image..." }, { quoted: msg });

        const buffer = await downloadImage(imageMessage, msg);
        const extracted = await scanQR(buffer);

        if (!extracted) {
            await sock.sendMessage(chatId, {
                text: "❌ No valid QR code detected in the image. WhatsApp compression might have blurred it!",
            });
            return;
        }

        rawQr = extracted;
        // Let the user see what was extracted before we hit the API
        await sock.sendMessage(chatId, {
            text: `🔍 *QR Extracted:*\n\`${rawQr}\`\n\n⏳ Submitting to attendance API...`,
        }, { quoted: msg });
    }

    await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

    const result = await scanQr(userId, rawQr);
    if (result === undefined)
    {
        await sock.sendMessage(chatId, { text: 'Creds are not set. Please do !test for more info.' });
        return;
    }
    else
    {
        const reply = formatScanResult(result);

        await sock.sendMessage(chatId, { text: reply }, { quoted: msg });

        // Send the server's result image (Tick.png ✅ or Cross.png ❌) if available
        if ((result as any).imageUrl) {
            try {
                const imgRes  = await fetch((result as any).imageUrl);
                const imgBuf  = Buffer.from(await imgRes.arrayBuffer());
                await sock.sendMessage(chatId, {
                    image:    imgBuf,
                    mimetype: "image/png",
                }, { quoted: msg });
            } catch (imgErr) {
                console.error("[scan] Failed to fetch result image:", imgErr);
            }
        }

        await sock.sendMessage(chatId, {
            react: { text: result.ok ? "✅" : "❌", key: msg.key },
        });
    }
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
*/