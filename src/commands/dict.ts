import { WAMessage } from "@whiskeysockets/baileys";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { Command } from "./_types.js";
import { generateSpeech } from "../lib/tts.js";
import { extractLanguages, gttsCodeForLanguage } from "../lib/langmap.js";

const DICT_EXE = path.join(
    import.meta.dir, "../../dict",
    process.platform === "win32" ? "dict_lookup.exe" : "dict_lookup"
);
const DICT_DIR = path.join(import.meta.dir, "../../dict");
const QUERY_TIMEOUT_MS = 30_000;
const TEXT_MAX = 3800;

/*
Max number of per-language pronunciations to send for one word. A word like
"love" exists in 20+ languages; sending 20 audio clips would be spam.
*/
const MAX_PRONUNCIATIONS = 4;

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

// Pronunciation planning
interface PronunciationPlan {
    langName: string;   // Wiktionary display name, e.g. "French"
    gttsCode: string;   // gTTS code, e.g. "fr"
}

/*
From the definition text, work out which languages to pronounce and in what
voice. Reads the `=== Language ===` headers, maps each to a gTTS code, drops
unsupported languages and duplicate voices, and caps the count.
*/
function planPronunciations(definition: string): PronunciationPlan[] {
    const langs = extractLanguages(definition);
    const plans: PronunciationPlan[] = [];
    const seenCodes = new Set<string>();

    for (const langName of langs) {
        const code = gttsCodeForLanguage(langName);
        if (!code) continue;                 // gTTS can't speak this language
        if (seenCodes.has(code)) continue;   // e.g. Bokmål + Nynorsk both => "no"
        seenCodes.add(code);
        plans.push({ langName, gttsCode: code });
        if (plans.length >= MAX_PRONUNCIATIONS) break;
    }

    return plans;
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

        // 1. Look up the word
        const definition = await lookup(word);
        if (!definition) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Not found in Wiktionary: *${word}*`
            }, { quoted: msg });
            return;
        }

        // 2. Send the definition text first
        const formatted = `📖 *${word}*\n\n${definition.trim()}`;
        const definitionText = formatted.length > TEXT_MAX
            ? formatted.slice(0, TEXT_MAX - 30) + "\n\n... _(truncated)_"
            : formatted;
        await sock.sendMessage(msg.key.remoteJid, { text: definitionText }, { quoted: msg });
        /*
        3. Figure out which languages to pronounce, based on the definition's
            own language sections - not the user's !lang setting.
        */
        const plans = planPronunciations(definition);

        if (plans.length === 0) {
            // No gTTS-supported language found among the sections - skip audio silently
            console.log(`📖 No pronounceable language for "${word}"`);
            return;
        }

        // 4. Generate and send one labeled pronunciation per language
        for (const plan of plans) {
            try {
                const audio = await generateSpeech(word, plan.gttsCode);
                await sock.sendMessage(msg.key.remoteJid, {
                    audio,
                    mimetype: "audio/mpeg",
                }, { quoted: msg });
                /*
                Label which language this pronunciation is - sent as a tiny
                follow-up so the user knows which voice they just heard.
                */
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `🔊 _${plan.langName} pronunciation of_ *${word}*`
                });
            } catch (ttsErr: any) {
                console.error(`📖 TTS failed for ${plan.langName} (${plan.gttsCode}):`, ttsErr?.message || ttsErr);
                // Skip this language, continue with the rest
            }
        }

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
    description: "Look up a word in Wiktionary with per-language pronunciation",
    usage: "!dict <word>",
    requiresArgs: true,
    handler: handleDict,
};

export default command;