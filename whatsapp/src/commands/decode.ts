import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { decodeQr } from "../../../shared/hi-hive/legacy/decode-qr.js";
import type { DecodedQr } from "../../../shared/hi-hive/legacy/types.js";
import { cmd } from "../config/prefixes.js";
import { findImage, isMediaReady, downloadMedia } from "../lib/media.js";
import { readQrCode, isAttendanceQr, VALID_QR_TYPES } from "../../../shared/lib/qr.js";

/*
  !decode                - send or reply to a QR image => scan => validate header => decode offline
  !decode <raw_qr>       - decode a raw QR string directly

  "Fits the attendance header" means the string starts with one of the known QR
  types (E01, Q01, Q02, LQR, CTR) followed by ":*:". If the image holds a QR
  that isn't one of ours, the user is told what was found rather than getting a
  generic "decode failed".
*/

const VERDICT_LABEL: Record<string, string> = {
    in_window: "✅ LIKELY VALID",
    expired:   "❌ LIKELY EXPIRED",
    too_early: "⏳ NOT OPEN YET",
    unknown:   "❓ UNKNOWN",
};

function formatDecoded(decoded: DecodedQr, source: "image" | "text"): string {
    const lines: string[] = [];

    lines.push(source === "image"
        ? "🖼️ *Decoded from image (offline - no server call)*"
        : "🔍 *Decoded QR (offline - no server call)*");
    lines.push("─".repeat(36));
    lines.push(`*Type:*     ${decoded.type}`);
    lines.push(`*Class ID:* ${decoded.classId ?? "-"}`);
    lines.push(`*Raw:*      \`${decoded.raw}\``);
    lines.push("");

    const info = decoded.info;

    if (decoded.type === "Q01" || decoded.type === "Q02") {
        lines.push("📋 *Class Info*");
        lines.push(`• Course:    ${info.courseCode  || "-"}`);
        lines.push(`• Session:   ${info.sessionType || "-"}`);
        lines.push(`• Group:     ${info.group       || "-"}`);
        lines.push(`• Date/Time: ${info.datetime    || "-"}`);
        lines.push(`• Hours:     ${info.hours       || "-"}`);
    } else if (decoded.type === "E01") {
        lines.push("📋 *Event Info*");
        lines.push(`• Event: ${info.eventName || "-"}`);
        lines.push(`• From:  ${info.from      || "-"}`);
        lines.push(`• To:    ${info.to        || "-"}`);
        lines.push(`• Venue: ${info.venue     || "-"}`);
    } else {
        lines.push(`📋 *QR Type:* ${decoded.type}`);
    }

    lines.push("");
    lines.push("─".repeat(36));
    lines.push(`⏱️ *Expiry:* ${VERDICT_LABEL[decoded.expiry.verdict] ?? decoded.expiry.verdict}`);
    lines.push(`_${decoded.expiry.reason}_`);
    lines.push("_(Prediction only - server clock is the final authority)_");

    return lines.join("\n");
}

/** Decode a raw string and report the outcome. Shared by both routes. */
async function decodeAndReply(ctx: CommandContext, rawQr: string, source: "image" | "text"): Promise<void> {
    const result = decodeQr(ctx.userId, rawQr);

    if (!result.ok) {
        await ctx.replyText(`❌ *Decode failed*\n${result.error}`);
        return;
    }

    await ctx.replyText(formatDecoded(result.decoded, source));
}

async function handleDecodeImage(ctx: CommandContext): Promise<void> {
    const image = findImage(ctx.msg);
    if (!image) {
        await ctx.sendUsage();
        return;
    }
    if (!isMediaReady(image)) {
        await ctx.replyText("⏳ WhatsApp is still processing this image. Wait a moment and try again.");
        return;
    }

    await ctx.replyText("⏳ Reading QR from image...");

    const buffer = await downloadMedia(image);
    const extracted = await readQrCode(buffer);

    if (!extracted) {
        await ctx.replyText(
            "❌ *No QR code detected in the image.*\n" +
            "WhatsApp compression may have blurred it - try sending the original file."
        );
        return;
    }

    if (!isAttendanceQr(extracted)) {
        await ctx.replyText(
            `⚠️ *QR code found, but it's not an attendance QR.*\n\n` +
            `🔗 *Content:* \`${extracted}\`\n\n` +
            `_Expected one of: ${VALID_QR_TYPES.join(", ")} before \`:*:\`_`
        );
        return;
    }

    await decodeAndReply(ctx, extracted, "image");
}

async function handleDecode(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext): Promise<void> {
    try {
        if (ctx.hasArgs) {
            await decodeAndReply(ctx, ctx.match, "text");
        } else {
            await handleDecodeImage(ctx);
        }
    } catch (err: any) {
        console.error("!decode error:", err);
        await ctx.replyText(`❌ Unexpected error: ${err?.message ?? err}`);
    }
}

const command: Command = {
    name: "decode",
    aliases: ["d"],
    description: "Offline-inspect a QR code from an image or a raw QR string",
    usage: `${cmd("decode")} | ${cmd("decode")} <raw_qr>`,
    usageHint:
        "⚠️ *Usage:*\n" +
        `• Send/reply to a QR image: \`${cmd("decode")}\`\n` +
        `• Paste a raw QR string: \`${cmd("decode")} Q01:*:abc123...\``,
    requiresArgs: false,
    handler: handleDecode,
};

export default command;
