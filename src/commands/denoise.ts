import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { Command } from "./_types.js";

const PY_SCRIPT_PATH = path.join(import.meta.dir, "../modules/denoise_engine.py");
const VENV_PYTHON_PATH = path.join(import.meta.dir, "../../.venv/Scripts/python.exe");
const PROCESS_TIMEOUT_MS = 2 * 60 * 1000;

function processDenoise(inputBuffer: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (!existsSync(VENV_PYTHON_PATH)) {
            return reject(new Error(`Python interpreter not found: ${VENV_PYTHON_PATH}`));
        }
        if (!existsSync(PY_SCRIPT_PATH)) {
            return reject(new Error(`Python script not found: ${PY_SCRIPT_PATH}`));
        }

        console.log(`🎧 Spawning denoise engine (input: ${(inputBuffer.length / 1024).toFixed(1)} KB)`);

        const worker = spawn(VENV_PYTHON_PATH, [PY_SCRIPT_PATH], {
            env: { ...process.env, PYTHONUNBUFFERED: "1" }
        });

        const stdoutChunks: Buffer[] = [];
        let stderrText = "";
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            console.error("🐍 Denoise timed out - killing Python process");
            worker.kill("SIGKILL");
            reject(new Error(`Python denoise timed out after ${PROCESS_TIMEOUT_MS / 1000}s.\nStderr:\n${stderrText.trim() || "(empty)"}`));
        }, PROCESS_TIMEOUT_MS);

        worker.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));

        worker.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            stderrText += text;
            process.stderr.write(`🐍 ${text}`);
        });

        worker.stdin.on("error", (err: any) => {
            if (err.code !== "EPIPE") {
                console.error("🐍 stdin error:", err);
            }
        });

        worker.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`Failed to spawn Python: ${err.message}`));
        });

        worker.on("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);

            if (code === 0) {
                const output = Buffer.concat(stdoutChunks);
                if (output.length === 0) {
                    return reject(new Error(`Python exited cleanly but produced no output. Stderr:\n${stderrText.trim() || "(empty)"}`));
                }
                return resolve(output);
            }

            const trimmedStderr = stderrText.trim() || "(no stderr - likely import crash before any handler ran)";
            reject(new Error(
                `Python exited with code ${code}${signal ? ` (signal ${signal})` : ""}.\n` +
                `--- Python stderr ---\n${trimmedStderr}\n--- end ---`
            ));
        });

        worker.stdin.write(inputBuffer, (err) => {
            if (err && (err as any).code !== "EPIPE") {
                console.error("🐍 stdin write error:", err);
            }
        });
        worker.stdin.end();
    });
}

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

        const outputBuffer = await processDenoise(inputBuffer);
        console.log(`🎧 Denoised audio: output ${(outputBuffer.length / 1024).toFixed(1)} KB`);

        /*
        Send as a proper voice note. WhatsApp renders OGG/Opus with ptt:true as
        a voice-note bubble (play button, waveform). Sending raw WAV or omitting
        ptt results in either an attachment file or an unplayable bubble.
        */
        await sock.sendMessage(msg.key.remoteJid, {
            audio: outputBuffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
        }, { quoted: msg });

        // Confirmation reaction
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