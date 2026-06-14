import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import path from "node:path";
import { Command } from "./_types.js";
import { runPythonScript } from "../lib/subprocess.js";

const PROJECT_ROOT = path.join(import.meta.dir, "../..");
const PY_SCRIPT = path.join(import.meta.dir, "../modules/rembg_engine.py");
const TIMEOUT_MS = 2 * 60 * 1000;   // rembg can be slow, esp. first-run model load

async function handleRemoveBg(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;

    const messageBody = msg.message?.ephemeralMessage?.message || msg.message;
    if (!messageBody) return;

    const isDirectImage = !!(messageBody as any).imageMessage;
    const isQuotedImage = !!(messageBody as any).extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

    if (!isDirectImage && !isQuotedImage) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage: Reply to an image with `!removebg` or send an image with `!removebg` as the caption."
        }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: "✂️", key: msg.key } });

        const targetMsg = isDirectImage
            ? msg
            : { key: msg.key, message: (messageBody as any).extendedTextMessage?.contextInfo?.quotedMessage };

        const inputBuffer = await downloadMediaMessage(targetMsg as any, "buffer", {}) as Buffer;
        console.log(`✂️ Downloaded image: ${(inputBuffer.length / 1024).toFixed(1)} KB`);

        const outputBuffer = await runPythonScript(PROJECT_ROOT, PY_SCRIPT, {
            input: inputBuffer,
            label: "removebg",
            timeoutMs: TIMEOUT_MS,
        });
        console.log(`✂️ Background removed: output ${(outputBuffer.length / 1024).toFixed(1)} KB`);

        await sock.sendMessage(msg.key.remoteJid, {
            image: outputBuffer,
            caption: "✨ Background removed!",
            mimetype: "image/png"
        }, { quoted: msg });

    } catch (error: any) {
        console.error("Rembg Error:", error?.message || error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Failed to process the image. Check server logs."
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "removebg",
    aliases: ["rbg", "nobg"],
    description: "Remove the background from an image using AI",
    usage: "!removebg (attach or reply to an image)",
    requiresArgs: false,
    handler: handleRemoveBg,
};

export default command;