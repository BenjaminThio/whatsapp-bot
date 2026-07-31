import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { engine } from "../../../shared/assets/index.js";
import { Command, CommandContext } from "./_types.js";
import { runPythonScript } from "../../../shared/lib/subprocess.js";
import { cmd } from "../config/prefixes.js";
import { findMedia, isMediaReady, downloadMedia, formatBytes } from "../lib/media.js";

const PROJECT_ROOT = process.cwd();
const PY_SCRIPT = engine("denoise_engine").pyScript;
const TIMEOUT_MS = 2 * 60 * 1000;

async function handleDenoise(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    const audio = findMedia(ctx.msg, ["audio"]);
    if (!audio) {
        await ctx.sendUsage();
        return;
    }
    if (!isMediaReady(audio)) {
        await ctx.replyText("⏳ WhatsApp is still processing this audio. Wait a few seconds and try again.");
        return;
    }

    try {
        await ctx.react("🎧");

        const inputBuffer = await downloadMedia(audio);
        console.log(`🎧 Downloaded audio: ${formatBytes(inputBuffer.length)}`);

        const outputBuffer = await runPythonScript(PROJECT_ROOT, PY_SCRIPT, {
            input: inputBuffer,
            label: "denoise",
            timeoutMs: TIMEOUT_MS,
        });
        console.log(`🎧 Denoised audio: output ${formatBytes(outputBuffer.length)}`);

        // Send as a proper voice note (OGG/Opus + ptt:true renders as a voice bubble)
        await ctx.reply({
            audio: outputBuffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        });

        await ctx.react("✅");

    } catch (error: any) {
        console.error("Denoise Error:", error?.message || error);
        await ctx.replyText("❌ Failed to process the audio. Check server logs.");
    }
}

const command: Command = {
    name: "denoise",
    aliases: ["clean", "dn"],
    description: "Clean up audio by high-pass filtering and removing background noise",
    usage: `${cmd("denoise")} (attach or reply to an audio message)`,
    usageHint:
        `⚠️ *Usage:* reply to an audio message with \`${cmd("denoise")}\`, ` +
        `or attach audio with \`${cmd("denoise")}\` as the caption.`,
    requiresArgs: false,
    handler: handleDenoise,
};

export default command;
