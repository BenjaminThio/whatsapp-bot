import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import { spawn } from "node:child_process";
import path from "node:path";
import { Command } from "./_types.js";

// Helper to spawn native Python, feed it the image, and catch the PNG result
async function processRembg(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const pyPath = path.join(import.meta.dir, "../modules/rembg_engine.py");
        
        // TARGET THE .venv INTERPRETER DIRECTLY!
        const venvPythonPath = path.join(import.meta.dir, "../../.venv/Scripts/python.exe");
        const worker = spawn(venvPythonPath, [pyPath]);

        const chunks: Buffer[] = [];
        let err = "";

        worker.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        worker.stderr.on("data", (chunk) => (err += chunk.toString("utf8")));

        worker.stdin.on("error", (e) => {});

        worker.on("error", reject);
        worker.on("close", (code) => {
            if (code !== 0) {
                console.error("\n🐍 [PYTHON CRASH LOG - REMOVEBG]:\n", err);
                return reject(`Process exited with code ${code}`);
            }
            resolve(Buffer.concat(chunks));
        });

        worker.stdin.write(inputBuffer);
        worker.stdin.end();
    });
}

async function handleRemoveBg(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;

    const messageBody = msg.message?.ephemeralMessage?.message || msg.message;
    if (!messageBody) return;

    // Check if the user attached an image directly, or replied to one
    const isDirectImage = !!messageBody.imageMessage;
    const isQuotedImage = !!messageBody.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

    if (!isDirectImage && !isQuotedImage) {
        await sock.sendMessage(msg.key.remoteJid, { 
            text: "⚠️ Usage: Reply to an image with `!removebg` or send an image with `!removebg` as the caption." 
        }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: "✂️", key: msg.key } });

        // Reconstruct the message payload so Baileys knows what to download
        const targetMsg = isDirectImage 
            ? msg 
            : { key: msg.key, message: messageBody.extendedTextMessage?.contextInfo?.quotedMessage };

        // 1. Download the encrypted image from WhatsApp
        const inputBuffer = await downloadMediaMessage(targetMsg as any, "buffer", {}) as Buffer;

        // 2. Blast it through the U^2-Net AI
        const outputBuffer = await processRembg(inputBuffer);

        // 3. Send the transparent PNG back to the chat!
        await sock.sendMessage(msg.key.remoteJid, {
            image: outputBuffer,
            caption: "✨ Background removed!",
            mimetype: "image/png" 
        }, { quoted: msg });

    } catch (error) {
        console.error("Rembg Error:", error);
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