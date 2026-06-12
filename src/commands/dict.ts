import { WAMessage } from "@whiskeysockets/baileys";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { Command } from "./_types.js";
import { generateSpeech } from "../lib/tts.js";

const DICT_EXE = path.join(
    import.meta.dir, "../../dict",
    process.platform === "win32" ? "dict_lookup.exe" : "dict_lookup"
);
const DICT_DIR = path.join(import.meta.dir, "../../dict");

const QUERY_TIMEOUT_MS = 30_000;

// WhatsApp text-message cap is ~4096 chars; leave headroom for our header.
const TEXT_MAX = 3800;

// Dictionary pronunciation is always English - Wiktionary is an English-language
// dictionary, so reading "love" in the user's !lang voice would be confusing.
const DICT_PRONOUNCE_LANG = "en";

// Worker management
interface PendingQuery {
    resolve: (s: string | null) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

let worker: ChildProcessWithoutNullStreams | null = null;
let queue: PendingQuery[] = [];
let buf: Buffer = Buffer.alloc(0);

function killWorker(reason: string): void {
    if (!worker) return;
    console.log(`📖 Killing dict worker: ${reason}`);
    try { worker.kill("SIGKILL"); } catch { /* already dead */ }
    worker = null;

    const pending = queue;
    queue = [];
    buf = Buffer.alloc(0);
    for (const q of pending) {
        clearTimeout(q.timer);
        q.reject(new Error(`dict worker terminated: ${reason}`));
    }
}

function parseBuffer(): void {
    while (true) {
        const headerEnd = buf.indexOf(0x0A);
        if (headerEnd < 0) return;

        const headerStr = buf.subarray(0, headerEnd).toString("ascii");
        const spaceIdx = headerStr.indexOf(" ");
        if (spaceIdx < 0) {
            console.error(`📖 Malformed header (no space): ${JSON.stringify(headerStr)}`);
            killWorker("malformed header from worker");
            return;
        }

        const status = headerStr.slice(0, spaceIdx);
        const lenStr = headerStr.slice(spaceIdx + 1);
        const len = parseInt(lenStr, 10);
        if (!Number.isFinite(len) || len < 0) {
            console.error(`📖 Malformed length: ${JSON.stringify(lenStr)}`);
            killWorker("malformed length from worker");
            return;
        }

        const totalNeeded = headerEnd + 1 + len + 1;
        if (buf.length < totalNeeded) return;

        const body = buf.subarray(headerEnd + 1, headerEnd + 1 + len);
        buf = buf.subarray(totalNeeded);

        const q = queue.shift();
        if (!q) {
            console.error(`📖 Orphan response received (${status}, ${len} bytes) - discarding`);
            continue;
        }

        clearTimeout(q.timer);
        if (status === "OK") {
            q.resolve(body.toString("utf8"));
        } else {
            q.resolve(null);
        }
    }
}

function ensureWorker(): ChildProcessWithoutNullStreams {
    if (worker && !worker.killed && worker.exitCode === null) return worker;

    if (!existsSync(DICT_EXE)) {
        throw new Error(`Dict binary not found at ${DICT_EXE}. Did you compile it?`);
    }

    console.log("📖 Spawning dict_lookup worker...");
    const w = spawn(DICT_EXE, ["--interactive"], {
        env: { ...process.env, DICT_DIR },
    });

    w.stdout.on("data", (chunk: Buffer) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        parseBuffer();
    });

    w.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`📖 ${chunk.toString("utf8")}`);
    });

    w.on("close", (code, signal) => {
        console.log(`📖 dict_lookup exited (code=${code}, signal=${signal})`);
        if (w === worker) {
            worker = null;
            const pending = queue;
            queue = [];
            buf = Buffer.alloc(0);
            for (const q of pending) {
                clearTimeout(q.timer);
                q.reject(new Error(`dict worker exited unexpectedly`));
            }
        }
    });

    w.on("error", (err) => {
        console.error("📖 dict spawn error:", err);
    });

    worker = w;

    // Cache warmup
    sendRaw("the").catch(() => { /* swallow warmup failures */ });

    return w;
}

function sendRaw(word: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const w = ensureWorker();

        const timer = setTimeout(() => {
            killWorker(`query timed out after ${QUERY_TIMEOUT_MS / 1000}s`);
        }, QUERY_TIMEOUT_MS);

        queue.push({ resolve, reject, timer });

        const clean = word.replace(/[\r\n]+/g, " ").trim();
        w.stdin.write(Buffer.from(clean + "\n", "utf8"));
    });
}

async function lookup(word: string): Promise<string | null> {
    try {
        return await sendRaw(word);
    } catch (err: any) {
        if (err.message?.includes("worker")) {
            console.log("📖 Retrying after worker restart...");
            return await sendRaw(word);
        }
        throw err;
    }
}

// Handler
async function handleDict(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    const args = text.slice("!dict ".length).trim();
    if (!args) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage: `!dict <word>`\nExample: `!dict serendipity`"
        }, { quoted: msg });
        return;
    }

    const word = args.split(/\s+/).join(" ");

    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: "📖", key: msg.key } });

        // Look up the word
        const definition = await lookup(word);
        if (!definition) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Not found in Wiktionary: *${word}*`
            }, { quoted: msg });
            return;
        }

        // Generate pronunciation audio (just the headword, like real dictionaries)
        let audioBuffer: Buffer | null = null;
        try {
            audioBuffer = await generateSpeech(word, DICT_PRONOUNCE_LANG);
        } catch (ttsErr: any) {
            console.error("📖 TTS failed, continuing without audio:", ttsErr?.message || ttsErr);
        }

        // Build the definition text, truncated if needed
        const formatted = `📖 *${word}*\n\n${definition.trim()}`;
        const definitionText = formatted.length > TEXT_MAX
            ? formatted.slice(0, TEXT_MAX - 30) + "\n\n... _(truncated)_"
            : formatted;

        /*
        Send audio first (so it appears immediately above the definition),
        then send the definition as a separate text message. WhatsApp's        
        audio captions don't render reliably across clients, so two messages
        is the only way to guarantee both are visible.
        */
        if (audioBuffer) {
            await sock.sendMessage(msg.key.remoteJid, {
                audio: audioBuffer,
                mimetype: "audio/mpeg",
            }, { quoted: msg });
        }

        await sock.sendMessage(msg.key.remoteJid, {
            text: definitionText,
        }, { quoted: msg });

    } catch (error: any) {
        console.error("Dict error:", error?.message || error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Dict lookup failed: ${error?.message || "unknown error"}`
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "dict",
    aliases: ["define", "dictionary"],
    description: "Look up a word in Wiktionary with pronunciation audio",
    usage: "!dict <word>",
    requiresArgs: true,
    handler: handleDict,
};

export default command;