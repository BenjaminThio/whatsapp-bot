import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import path from "node:path";
import { Command } from "./_types.js";
import { runPythonScript } from "../lib/subprocess.js";

const PROJECT_ROOT = path.join(import.meta.dir, "../..");
const PY_SCRIPT = path.join(import.meta.dir, "../modules/denoise_engine.py");
const TIMEOUT_MS = 2 * 60 * 1000;

async function handleDenoise(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;

    const messageBody = msg.message?.ephemeralMessage?.message || msg.message;
    if (!messageBody) return;

    const isDirectAudio = !!(messageBody as any).audioMessage;
    const isQuotedAudio = !!(messageBody as any).extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;

    if (!isDirectAudio && !isQuotedAudio) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage: Reply to an audio message with `!denoise` or attach audio with `!denoise` as the caption."
        }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: "🎧", key: msg.key } });

        const targetMsg = isDirectAudio
            ? msg
            : { key: msg.key, message: (messageBody as any).extendedTextMessage?.contextInfo?.quotedMessage };

        const inputBuffer = await downloadMediaMessage(targetMsg as any, "buffer", {}) as Buffer;
        console.log(`🎧 Downloaded audio: ${(inputBuffer.length / 1024).toFixed(1)} KB`);

        const outputBuffer = await runPythonScript(PROJECT_ROOT, PY_SCRIPT, {
            input: inputBuffer,
            label: "denoise",
            timeoutMs: TIMEOUT_MS,
        });
        console.log(`🎧 Denoised audio: output ${(outputBuffer.length / 1024).toFixed(1)} KB`);

        // Send as a proper voice note (OGG/Opus + ptt:true renders as a voice bubble)
        await sock.sendMessage(msg.key.remoteJid, {
            audio: outputBuffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        }, { quoted: msg });

        await sock.sendMessage(msg.key.remoteJid, { react: { text: "✅", key: msg.key } });

    } catch (error: any) {
        console.error("Denoise Error:", error?.message || error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Failed to process the audio. Check server logs."
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "denoise",
    aliases: ["clean", "dn"],
    description: "Clean up audio by high-pass filtering and removing background noise",
    usage: "!denoise (attach or reply to an audio message)",
    requiresArgs: false,
    handler: handleDenoise,
};

export default command;