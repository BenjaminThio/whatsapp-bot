/*
 * tts.ts - shared text-to-speech utilities.  (lives in src/lib/)
 *
 * generateSpeech(text, lang) => Promise<Buffer>   MP3 bytes
 * getUserTtsLang(jid)        => Promise<string>   2-letter code, defaults "en"
 *
 * Cross-platform: on Windows it runs the compiled gtts_engine.exe; on
 * Termux/Linux it runs gtts_engine.py through the system Python. The runHelper
 * picks the right one automatically (see lib/subprocess.ts).
 */
import { engine } from "../assets/index.js";
import { getPrefs } from "./user-prefs-db.js";
import { runHelper } from "./subprocess.js";

// Engines live in shared/assets/engines; see shared/assets/index.ts.
const PROJECT_ROOT = process.cwd();
const GTTS = engine("gtts_engine");
const GENERATE_TIMEOUT_MS = 30_000;

// Render `text` to MP3 bytes via the gTTS engine (exe on Windows, py elsewhere).
export function generateSpeech(text: string, lang: string): Promise<Buffer> {
    // The engine takes [lang, text] as CLI args and emits MP3 bytes on stdout.
    return runHelper(PROJECT_ROOT, {
        winExe: GTTS.winExe,
        pyScript: GTTS.pyScript,
        args: [lang, text],
        label: "gtts",
        timeoutMs: GENERATE_TIMEOUT_MS,
    });
}

// Get the user's preferred TTS language from Postgres. Defaults to "en".
export async function getUserTtsLang(jid: string): Promise<string> {
    try {
        const prefs = await getPrefs(jid);
        if (prefs?.ttsLang) return prefs.ttsLang;
    } catch (err) {
        console.error("Failed to fetch TTS lang, using default 'en':", err);
    }
    return "en";
}