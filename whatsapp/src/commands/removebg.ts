import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { engine } from "../../../shared/assets/index.js";
import { Command, CommandContext } from "./_types.js";
import { runPythonScript } from "../../../shared/lib/subprocess.js";
import { cmd } from "../config/prefixes.js";
import { findImage, isMediaReady, downloadMedia, formatBytes } from "../lib/media.js";

const PROJECT_ROOT = process.cwd();
const PY_SCRIPT = engine("rembg_engine").pyScript;
const TIMEOUT_MS = 2 * 60 * 1000;   // rembg can be slow, esp. first-run model load

async function handleRemoveBg(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    const image = findImage(ctx.msg);
    if (!image) {
        await ctx.sendUsage();
        return;
    }
    if (!isMediaReady(image)) {
        await ctx.replyText("⏳ WhatsApp is still processing this image. Wait a few seconds and try again.");
        return;
    }

    try {
        await ctx.react("✂️");

        const inputBuffer = await downloadMedia(image);
        console.log(`✂️ Downloaded image: ${formatBytes(inputBuffer.length)}`);

        const outputBuffer = await runPythonScript(PROJECT_ROOT, PY_SCRIPT, {
            input: inputBuffer,
            label: "removebg",
            timeoutMs: TIMEOUT_MS,
        });
        console.log(`✂️ Background removed: output ${formatBytes(outputBuffer.length)}`);

        await ctx.reply({
            image: outputBuffer,
            caption: "✨ Background removed!",
            mimetype: "image/png",
        });

    } catch (error: any) {
        console.error("Rembg Error:", error?.message || error);
        await ctx.replyText("❌ Failed to process the image. Check server logs.");
    }
}

const command: Command = {
    name: "removebg",
    aliases: ["rbg", "nobg"],
    description: "Remove the background from an image using AI",
    usage: `${cmd("removebg")} (attach or reply to an image)`,
    usageHint:
        `⚠️ *Usage:* reply to an image with \`${cmd("removebg")}\`, ` +
        `or send an image with \`${cmd("removebg")}\` as the caption.`,
    requiresArgs: false,
    handler: handleRemoveBg,
};

export default command;
