/*
 * tts.ts — shared text-to-speech utilities.  (lives in src/lib/)
 *
 * generateSpeech(text, lang) → Promise<Buffer>   MP3 bytes
 * getUserTtsLang(jid)        → Promise<string>   2-letter code, defaults "en"
 *
 * Cross-platform: on Windows it runs the compiled gtts_engine.exe; on
 * Termux/Linux it runs gtts_engine.py through the system Python. The runHelper
 * picks the right one automatically (see lib/subprocess.ts).
 */
import path from "node:path";
import db from "../firebase.js";
import { runHelper } from "./subprocess.js";

// From src/lib/ : project root is ../.. ; the engine sources live in src/modules/
const PROJECT_ROOT = path.join(import.meta.dir, "../..");
const GTTS_EXE = path.join(import.meta.dir, "../modules/gtts_engine.exe");
const GTTS_PY = path.join(import.meta.dir, "../modules/gtts_engine.py");
const GENERATE_TIMEOUT_MS = 30_000;

/** Render `text` to MP3 bytes via the gTTS engine (exe on Windows, py elsewhere). */
export function generateSpeech(text: string, lang: string): Promise<Buffer> {
    // The engine takes [lang, text] as CLI args and emits MP3 bytes on stdout.
    return runHelper(PROJECT_ROOT, {
        winExe: GTTS_EXE,
        pyScript: GTTS_PY,
        args: [lang, text],
        label: "gtts",
        timeoutMs: GENERATE_TIMEOUT_MS,
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