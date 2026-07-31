/**
 * dict.ts - shared/lib/dict.ts
 *
 * Wiktionary lookups through a long-lived `dict_lookup` worker.
 *
 * The two bots had different strategies and both were wrong in some way:
 * WhatsApp kept a persistent worker (good) but the protocol handling lived
 * inside the command file, and Telegram spawned a fresh process per command -
 * which on a phone is a fork, an exec, and re-opening a 480 MB index every time
 * someone asks for a word.
 *
 * One worker, shared. It is started lazily on the first lookup, restarted
 * automatically if it dies, and idles out after a period of no use so a bot
 * that never runs /dict doesn't hold the index open.
 *
 * Wire protocol (from dict_lookup --interactive):
 *
 *     <- "<word>\n"
 *     -> "<STATUS> <byteLength>\n<body>\n"
 *
 * STATUS is "OK" or an error token. Requests are answered in order, so a plain
 * FIFO of pending promises is enough to match replies to callers.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dictBinary, DICT_DIR } from "../assets/index.js";

const QUERY_TIMEOUT_MS = Number(process.env["DICT_TIMEOUT_MS"] ?? 30_000);

/** Shut the worker down after this long with no lookups. */
const IDLE_SHUTDOWN_MS = Number(process.env["DICT_IDLE_MS"] ?? 5 * 60_000);

interface Pending {
    resolve: (value: string | null) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

let worker: ChildProcessWithoutNullStreams | null = null;
let queue: Pending[] = [];
let buffer: Buffer = Buffer.alloc(0);
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Is the dictionary available on this host at all? */
export function isDictAvailable(): boolean {
    return existsSync(dictBinary());
}

function rejectAll(reason: string): void {
    const pending = queue;
    queue = [];
    buffer = Buffer.alloc(0);
    for (const p of pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
    }
}

function killWorker(reason: string): void {
    if (!worker) return;
    console.log(`📖 Stopping dict worker: ${reason}`);
    try { worker.kill("SIGKILL"); } catch { /* already dead */ }
    worker = null;
    rejectAll(`dict worker terminated: ${reason}`);
}

function touchIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (queue.length === 0) killWorker("idle");
    }, IDLE_SHUTDOWN_MS);
    // Don't hold the process open just for this
    idleTimer.unref?.();
}

/**
 * Pull whole responses out of the byte stream.
 *
 * Reads are chunked arbitrarily, so a response can arrive split across several
 * data events or several responses can arrive in one. This drains as many
 * complete frames as the buffer holds and leaves the remainder.
 */
function drain(): void {
    for (;;) {
        const headerEnd = buffer.indexOf(0x0a);         // '\n'
        if (headerEnd < 0) return;                       // header incomplete

        const header = buffer.subarray(0, headerEnd).toString("ascii");
        const space = header.indexOf(" ");
        if (space < 0) {
            console.error(`📖 Malformed header: ${JSON.stringify(header)}`);
            killWorker("malformed header");
            return;
        }

        const status = header.slice(0, space);
        const length = Number.parseInt(header.slice(space + 1), 10);

        if (!Number.isFinite(length) || length < 0) {
            console.error(`📖 Malformed length in header: ${JSON.stringify(header)}`);
            killWorker("malformed length");
            return;
        }

        const total = headerEnd + 1 + length + 1;        // header + body + trailing \n
        if (buffer.length < total) return;               // body incomplete

        const body = buffer.subarray(headerEnd + 1, headerEnd + 1 + length);
        buffer = buffer.subarray(total);

        const pending = queue.shift();
        if (!pending) {
            console.error(`📖 Orphan response (${status}, ${length} bytes) - discarding`);
            continue;
        }

        clearTimeout(pending.timer);
        pending.resolve(status === "OK" ? body.toString("utf8") : null);
    }
}

function ensureWorker(): ChildProcessWithoutNullStreams {
    if (worker && !worker.killed && worker.exitCode === null) return worker;

    const binary = dictBinary();
    if (!existsSync(binary)) {
        throw new Error(`Dictionary binary not found at ${binary}. Build it from dict_lookup.c.`);
    }

    console.log("📖 Starting dict_lookup worker...");
    const w = spawn(binary, ["--interactive"], {
        env: { ...process.env, DICT_DIR },
        // Don't keep the bot alive just because the worker is running
        detached: false,
    });

    w.stdout.on("data", (chunk: Buffer) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        drain();
    });

    w.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(`📖 ${chunk.toString("utf8")}`);
    });

    w.on("close", (code, signal) => {
        console.log(`📖 dict_lookup exited (code=${code}, signal=${signal})`);
        if (w === worker) {
            worker = null;
            rejectAll("dict worker exited unexpectedly");
        }
    });

    w.on("error", (err) => {
        console.error("📖 dict spawn error:", err);
        if (w === worker) {
            worker = null;
            rejectAll(`dict worker failed to start: ${err.message}`);
        }
    });

    worker = w;
    return w;
}

function ask(word: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        let w: ChildProcessWithoutNullStreams;
        try {
            w = ensureWorker();
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        const timer = setTimeout(() => {
            // A hung worker would stall every later query behind it in the FIFO
            killWorker(`query timed out after ${QUERY_TIMEOUT_MS / 1000}s`);
        }, QUERY_TIMEOUT_MS);

        queue.push({ resolve, reject, timer });
        touchIdleTimer();

        // Newlines would desynchronise the protocol
        w.stdin.write(Buffer.from(word.replace(/[\r\n]+/g, " ").trim() + "\n", "utf8"));
    });
}

/**
 * Look a word up. Returns null when it isn't in the dictionary.
 *
 * Retries once if the worker died between requests - that is the normal way a
 * crashed or idled-out worker surfaces, and a transparent restart is better
 * than telling the user "not found".
 */
export async function lookupWord(word: string): Promise<string | null> {
    try {
        return await ask(word);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("worker")) {
            console.log("📖 Retrying after worker restart...");
            return await ask(word);
        }
        throw err;
    }
}

/** Stop the worker. For shutdown and tests. */
export function stopDictWorker(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    killWorker("shutdown");
}
