/*
 * tts.ts — shared text-to-speech utilities.
 *
 * Wraps the gtts_engine.exe child process and exposes two helpers any command
 * can use to speak text aloud:
 *
 *   generateSpeech(text, lang)  => Promise<Buffer>   MP3 bytes
 *   getUserTtsLang(jid)         => Promise<string>   2-letter code, defaults to "en"
 *
 * The audio generator wraps gTTS via the compiled Python binary; the language
 * lookup reads from Firestore where !lang stores user preferences.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import db from "../firebase.js";

const GTTS_EXE = path.join(
    import.meta.dir, "../modules/gtts_engine.exe"
);

// Generation can hang if the engine waits forever on a network call (gTTS
// hits Google Translate's TTS endpoint). Cap it so commands don't wedge.
const GENERATE_TIMEOUT_MS = 30_000;

/** Render `text` to MP3 bytes via the gTTS engine. */
export function generateSpeech(text: string, lang: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (!existsSync(GTTS_EXE)) {
            return reject(new Error(`gTTS engine not found at ${GTTS_EXE}`));
        }

        const worker = spawn(GTTS_EXE, [lang, text]);

        const chunks: Buffer[] = [];
        let errText = "";
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { worker.kill("SIGKILL"); } catch { /* already dead */ }
            reject(new Error(`gTTS timed out after ${GENERATE_TIMEOUT_MS / 1000}s. Stderr:\n${errText.trim() || "(empty)"}`));
        }, GENERATE_TIMEOUT_MS);

        worker.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        worker.stderr.on("data", (chunk: Buffer) => {
            errText += chunk.toString("utf8");
        });

        worker.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error(`gTTS spawn failed: ${err.message}`));
        });

        worker.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code !== 0) {
                return reject(new Error(errText.trim() || `gTTS exited with code ${code}`));
            }
            const out = Buffer.concat(chunks);
            if (out.length === 0) {
                return reject(new Error("gTTS produced no output."));
            }
            resolve(out);
        });
    });
}

/** Get the user's preferred TTS language from Firestore. Defaults to "en". */
export async function getUserTtsLang(jid: string): Promise<string> {
    try {
        const docSnap = await db.collection("user_prefs").doc(jid).get();
        if (docSnap.exists && docSnap.data()?.ttsLang) {
            return docSnap.data()!.ttsLang;
        }
    } catch (err) {
        console.error("Failed to fetch TTS lang, using default 'en':", err);
    }
    return "en";
}