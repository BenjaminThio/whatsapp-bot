import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { scanQr } from "../../../shared/hi-hive/scan-qr.js";
import type { ScanQrResult } from "../../../shared/hi-hive/types.js";
import { cmd } from "../config/prefixes.js";
import { findImage, isMediaReady, downloadMedia } from "../lib/media.js";
import { readQrCode, createQrImage } from "../../../shared/lib/qr.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";
import { queueReply, reactNow } from "../lib/outbox.js";

/*
  !scan                          - reply to an image => scan QR, return regenerated QR + raw string
  !scan attendance               - reply to an image => scan QR, submit to attendance API
  !scan attendance <raw_qr>      - submit a raw QR string directly to attendance API
*/

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
        return lines.join("\n");
    }

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

    return lines.join("\n");
}

/**
 * Pull a QR string out of the attached/replied image.
 *
 * Returns null after telling the user why - the caller just stops.
 */
async function qrFromImage(ctx: CommandContext, notice: string): Promise<string | null> {
    const image = findImage(ctx.msg);
    if (!image) {
        await ctx.sendUsage();
        return null;
    }
    if (!isMediaReady(image)) {
        await ctx.replyText("⏳ WhatsApp is still processing this image. Wait a few seconds and try again.");
        return null;
    }

    await ctx.replyText(notice);

    const buffer = await downloadMedia(image);
    const extracted = await readQrCode(buffer);

    if (!extracted) {
        await ctx.replyText("❌ No valid QR code detected. WhatsApp compression might have blurred it!");
        return null;
    }
    return extracted;
}

/*
  !scan - decode a QR from an image and send back a crisp regenerated one.
*/
async function handleScanImage(ctx: CommandContext): Promise<void> {
    const extractedLink = await qrFromImage(ctx, "⏳ Scanning and enhancing...");
    if (!extractedLink) return;

    const finalImageBuffer = await createQrImage(extractedLink);

    await ctx.reply({
        image: finalImageBuffer,
        caption: `✅ *QR Scanned Successfully*\n\n🔗 *Content:*\n\`${extractedLink}\``,
        mimetype: "image/png",
    });
}

/*
  !scan attendance [raw_qr] - submit a QR to the attendance API.

  Exported because !test reuses it as a subcommand. It takes chatId/userId
  explicitly so !test can scan on behalf of another doc.
*/
export async function handleScanAttendance(
    _sock: WASocket,
    msg: WAMessage,
    chatId: string,
    userId: string,
    rawQrArg: string | undefined,
    ctx?: CommandContext
): Promise<void> {
    const reply = (content: any) => queueReply(chatId, content, msg);

    let rawQr: string;

    if (rawQrArg) {
        rawQr = rawQrArg;
    } else if (ctx) {
        const extracted = await qrFromImage(ctx, "⏳ Reading QR from image...");
        if (!extracted) return;
        rawQr = extracted;
        await reply({ text: `🔍 *QR Extracted:*\n\`${rawQr}\`\n\n⏳ Submitting to attendance API...` });
    } else {
        await reply({
            text:
                "⚠️ *Usage:*\n" +
                `• Reply to a QR image: \`${cmd("scan attendance")}\`\n` +
                `• Paste raw QR string: \`${cmd("scan attendance")} Q01:*:abc123...\``,
        });
        return;
    }

    await reactNow(chatId, "⏳", msg.key);

    const result = await scanQr(userId, rawQr);
    if (result === undefined) {
        await reply({ text: `Creds are not set. Please do \`${cmd("test")}\` for more info.` });
        return;
    }

    const text = formatScanResult(result);

    // Send as image+caption if the server provided a result image, else plain text
    const imageUrl = (result as any).imageUrl as string | undefined;
    const resultImage = imageUrl ? await fetchImageBuffer(imageUrl) : null;

    if (resultImage) {
        await reply({ image: resultImage, caption: text, mimetype: "image/png" });
    } else {
        if (imageUrl) console.error("[scan] Failed to fetch result image:", imageUrl);
        await reply({ text });
    }

    await reactNow(chatId, result.ok ? "✅" : "❌", msg.key);
}

async function handleScan(sock: WASocket, msg: WAMessage, _text: string, ctx: CommandContext): Promise<void> {
    // Route: !scan attendance [raw_qr]
    if (ctx.sub === "attendance" || ctx.sub === "att") {
        try {
            await handleScanAttendance(sock, msg, ctx.chatId, ctx.userId, ctx.rest(1) || undefined, ctx);
        } catch (err: any) {
            console.error("!scan attendance error:", err);
            await ctx.replyText(`❌ Unexpected error: ${err?.message ?? err}`);
            await ctx.react("❌");
        }
        return;
    }

    // Route: !scan - decode and regenerate
    try {
        await handleScanImage(ctx);
    } catch (err: any) {
        console.error("!scan error:", err);
        await ctx.replyText("❌ An internal error occurred while processing the QR code.");
    }
}

const command: Command = {
    name: "scan",
    description: "Scan a QR code from an image, or submit one to mark attendance",
    usage: `${cmd("scan")} | ${cmd("scan attendance")} | ${cmd("scan attendance")} <raw_qr>`,
    usageHint:
        "⚠️ *Usage:*\n" +
        `• Send or reply to an image with \`${cmd("scan")}\` - decode and re-render the QR\n` +
        `• \`${cmd("scan attendance")}\` on a QR image - submit it for attendance\n` +
        `• \`${cmd("scan attendance")} Q01:*:abc123...\` - submit a raw QR string`,
    requiresArgs: false,
    handler: handleScan,
};

export default command;
