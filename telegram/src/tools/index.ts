/**
 * index.ts - relasma/src/tools/index.ts
 *
 * The media and lookup utilities ported from the WhatsApp bot:
 *
 *   /dict      - Wiktionary lookup with per-language pronunciation
 *   /search    - Bing image search
 *   /convert   - image/audio format conversion via ffmpeg
 *   /denoise   - clean up a voice note
 *   /removebg  - cut the background out of an image
 *   /lang      - set the voice language used by /say and /dict
 *
 * All the heavy lifting is shared code; this file is the Telegram front end.
 */

import { InputFile } from "grammy";
import path from "node:path";
import { spawn } from "node:child_process";
import { cmd, feature, type Ctx } from "../lib/command.js";
import { findImage, findMedia, downloadMedia, formatBytes } from "../lib/media.js";
import { searchImages } from "../../../shared/lib/bing-images.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";
import { runPythonScript } from "../../../shared/lib/subprocess.js";
import { engine } from "../../../shared/assets/index.js";
import { generateSpeech } from "../../../shared/lib/tts.js";
import { lookupWord, isDictAvailable } from "../../../shared/lib/dict.js";
import { extractLanguages, gttsCodeForLanguage } from "../../../shared/lib/langmap.js";
import { setPrefs, getPrefs } from "../../../shared/lib/user-prefs-db.js";
import { truncate } from "../../../shared/lib/text.js";
import { SUPPORTED_LANGS, canonicalLang } from "../lib/langs.js";

const PROJECT_ROOT = process.cwd();
const ENGINE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_TG_TEXT = 4000;

/*
Max per-language pronunciations for one word. "love" exists in 20+ languages;
sending 20 voice notes would be spam.
*/
const MAX_PRONUNCIATIONS = 4;

// ── /lang ─────────────────────────────────────────────────────────────────────

const lang = cmd("lang", {
    description: "View or set the text-to-speech language",
    args: "[code]",
}, async (ctx: Ctx) => {
    if (!ctx.hasArgs) {
        const current = (await getPrefs(String(ctx.chatId)))?.ttsLang ?? "en";
        const list = Object.entries(SUPPORTED_LANGS)
            .map(([code, name]) => `• ${code} : ${name}`)
            .join("\n");
        await ctx.reply(
            truncate(`🌐 Available voice languages\n(current: ${current})\n\n${list}\n\nUsage: /lang ja`, MAX_TG_TEXT)
        );
        return;
    }

    const code = canonicalLang(ctx.args[0]!);
    if (!code) {
        await ctx.reply(`❌ Invalid language code: ${ctx.args[0]}\nType /lang to see the list.`);
        return;
    }

    // Stored per chat, so a group and a DM can differ - same key the WhatsApp bot uses
    await setPrefs(String(ctx.chatId), { ttsLang: code });
    await ctx.reply(`✅ Voice language set to ${SUPPORTED_LANGS[code]}.`);
});

// ── /search ───────────────────────────────────────────────────────────────────

const MAX_IMAGES = 10;

const search = cmd("search", {
    aliases: ["imgsearch", "pic"],
    description: "Search for images via Bing",
    args: "<query> [count]",
    usageHint: "Usage: /search <query> [count]\nExample: /search cake 5  (count optional, max 10)",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    // A trailing number is a count, not part of the query
    const tokens = [...ctx.args];
    let count = 1;
    const last = tokens[tokens.length - 1]!;
    if (tokens.length > 1 && /^\d+$/.test(last)) {
        count = Math.max(1, Math.min(MAX_IMAGES, parseInt(last, 10)));
        tokens.pop();
    }

    const query = tokens.join(" ").trim();
    if (!query) {
        await ctx.reply("Usage: /search <query> [count]");
        return;
    }

    // Over-fetch so dead URLs don't leave us short
    const results = await searchImages(query, { limit: count * 3, safeSearch: "moderate" });
    if (results.length === 0) {
        await ctx.reply(`❌ No images found for: ${query}`);
        return;
    }

    let sent = 0;
    for (const item of results) {
        if (sent >= count) break;
        if (!item.image) continue;

        const buf = await fetchImageBuffer(item.image);
        if (!buf) continue;

        try {
            await ctx.tg.replyWithPhoto(new InputFile(buf, `result-${sent + 1}.jpg`), {
                caption: sent === 0 ? `🔍 ${query}` : undefined,
            });
            sent++;
        } catch (err) {
            // A single rejected image must not abort the batch
            console.error("Failed to send search result:", err);
        }
    }

    if (sent === 0) {
        await ctx.reply(`❌ Found results for ${query} but none could be downloaded. Try again.`);
    } else if (sent < count) {
        await ctx.reply(`ℹ️ Sent ${sent} of ${count} requested (some failed to download).`);
    }
});

// ── /removebg and /denoise ────────────────────────────────────────────────────

const removebg = cmd("removebg", {
    aliases: ["rbg", "nobg"],
    description: "Remove the background from an image using AI",
    args: "(attach or reply to an image)",
}, async (ctx: Ctx) => {
    const image = findImage(ctx.tg);
    if (!image) {
        await ctx.reply("Usage: reply to an image with /removebg, or send one captioned /removebg");
        return;
    }

    await ctx.status("✂️ Removing background...");

    const input = await downloadMedia(image);
    const output = await runPythonScript(PROJECT_ROOT, engine("rembg_engine").pyScript, {
        input,
        label: "removebg",
        timeoutMs: ENGINE_TIMEOUT_MS,
    });

    /*
    Sent as a document, not a photo. A cut-out is a transparent PNG and
    Telegram re-encodes photos to JPEG, which would replace the transparency
    with a black background - exactly what the user asked to remove.
    */
    await ctx.tg.replyWithDocument(new InputFile(output, "no-background.png"), {
        caption: "✨ Background removed",
    });
});

const denoise = cmd("denoise", {
    aliases: ["clean", "dn"],
    description: "Clean up audio by filtering out background noise",
    args: "(attach or reply to an audio message)",
}, async (ctx: Ctx) => {
    const audio = findMedia(ctx.tg, ["audio"]);
    if (!audio) {
        await ctx.reply("Usage: reply to a voice message with /denoise, or send audio captioned /denoise");
        return;
    }

    await ctx.status("🎧 Cleaning up the audio...");

    const input = await downloadMedia(audio);
    const output = await runPythonScript(PROJECT_ROOT, engine("denoise_engine").pyScript, {
        input,
        label: "denoise",
        timeoutMs: ENGINE_TIMEOUT_MS,
    });

    await ctx.tg.replyWithVoice(new InputFile(output, "denoised.ogg"));
});

// ── /convert ──────────────────────────────────────────────────────────────────

const IMAGE_FORMATS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif", "ico"]);
const AUDIO_FORMATS = new Set(["mp3", "ogg", "wav", "flac", "m4a", "aac", "opus"]);

const AUDIO_ENCODER: Record<string, string[]> = {
    mp3: ["-c:a", "libmp3lame", "-b:a", "192k"],
    ogg: ["-c:a", "libvorbis", "-q:a", "5"],
    opus: ["-c:a", "libopus", "-b:a", "96k"],
    m4a: ["-c:a", "aac", "-b:a", "192k"],
    aac: ["-c:a", "aac", "-b:a", "192k"],
    wav: ["-c:a", "pcm_s16le"],
    flac: ["-c:a", "flac"],
};

const FFMPEG_FORMAT: Record<string, string> = {
    mp3: "mp3", ogg: "ogg", opus: "opus", m4a: "ipod", aac: "adts", wav: "wav", flac: "flac",
    png: "image2", jpg: "image2", jpeg: "image2", webp: "webp", bmp: "image2",
    gif: "image2", tiff: "image2", tif: "image2", ico: "image2",
};

const CONVERT_TIMEOUT_MS = 60_000;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** Single in, single out, entirely through stdio - no temp files. */
function convertWithFfmpeg(input: Buffer, targetExt: string, isImage: boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"];

        if (isImage) {
            args.push("-frames:v", "1");
            if (targetExt === "jpg" || targetExt === "jpeg") args.push("-q:v", "2");
        } else {
            const enc = AUDIO_ENCODER[targetExt];
            if (enc) args.push(...enc);
        }

        const fmt = FFMPEG_FORMAT[targetExt];
        if (fmt) args.push("-f", fmt);
        args.push("pipe:1");

        const worker = spawn("ffmpeg", args);
        const chunks: Buffer[] = [];
        let errText = "";
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { worker.kill("SIGKILL"); } catch { /* already dead */ }
            reject(new Error(`ffmpeg timed out after ${CONVERT_TIMEOUT_MS / 1000}s.`));
        }, CONVERT_TIMEOUT_MS);

        worker.stdout.on("data", (c: Buffer) => chunks.push(c));
        worker.stderr.on("data", (c: Buffer) => { errText += c.toString("utf8"); });
        // EPIPE is normal when ffmpeg rejects the input before we finish writing
        worker.stdin.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code !== "EPIPE") console.error("ffmpeg stdin error:", e);
        });

        worker.on("error", (e) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            reject(new Error(`Could not start ffmpeg: ${e.message}. Is it installed and on PATH?`));
        });

        worker.on("close", (code) => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (code !== 0) return reject(new Error(`ffmpeg exited ${code}.\n${errText.trim() || "(no output)"}`));
            const out = Buffer.concat(chunks);
            if (out.length === 0) return reject(new Error("ffmpeg produced no output."));
            resolve(out);
        });

        worker.stdin.write(input, (e) => {
            if (e && (e as NodeJS.ErrnoException).code !== "EPIPE") console.error("ffmpeg write error:", e);
        });
        worker.stdin.end();
    });
}

const FORMAT_LIST =
    "Image: png, jpg, webp, bmp, gif, tiff, ico\n" +
    "Audio: mp3, ogg, wav, flac, m4a, aac, opus";

const convert = cmd("convert", {
    aliases: ["conv", "to"],
    description: "Convert images or audio between formats",
    args: "<format>",
    usageHint:
        "Usage: /convert <format>\n\n" +
        "Attach an image or audio file captioned /convert png, or reply to one.\n\n" +
        FORMAT_LIST,
    requiresArgs: true,
}, async (ctx: Ctx) => {
    const targetExt = ctx.args[0]!.toLowerCase().replace(/^\./, "");
    const isImageTarget = IMAGE_FORMATS.has(targetExt);
    const isAudioTarget = AUDIO_FORMATS.has(targetExt);

    if (!isImageTarget && !isAudioTarget) {
        await ctx.reply(`❌ Unsupported format: ${targetExt}\n\n${FORMAT_LIST}`);
        return;
    }

    const found = findMedia(ctx.tg, ["image", "audio", "document"]);
    if (!found) {
        await ctx.reply("⚠️ No media found. Attach an image or audio file, or reply to one.");
        return;
    }

    // A document carries its real type in the mimetype, so a photo sent "as a
    // file" still converts.
    const sourceIsImage = found.kind === "image" || found.mimetype.startsWith("image/");
    const sourceIsAudio = found.kind === "audio" || found.mimetype.startsWith("audio/");

    if (!sourceIsImage && !sourceIsAudio) {
        await ctx.reply(`❌ Can't convert a ${found.mimetype} file.`);
        return;
    }
    if (sourceIsImage && isAudioTarget) {
        await ctx.reply(`❌ Can't convert an image to an audio format (${targetExt}).`);
        return;
    }
    if (sourceIsAudio && isImageTarget) {
        await ctx.reply(`❌ Can't convert audio to an image format (${targetExt}).`);
        return;
    }

    const input = await downloadMedia(found);
    if (input.length > MAX_INPUT_BYTES) {
        await ctx.reply(`❌ File too large: ${formatBytes(input.length)} (limit ${formatBytes(MAX_INPUT_BYTES)}).`);
        return;
    }

    await ctx.status(`🔄 Converting to .${targetExt}...`);

    const output = await convertWithFfmpeg(input, targetExt, sourceIsImage);
    const base = found.fileName ? path.parse(found.fileName).name : found.kind;

    await ctx.tg.replyWithDocument(new InputFile(output, `${base}.${targetExt}`), {
        caption: `✅ Converted to .${targetExt}`,
    });
});

// ── /dict ─────────────────────────────────────────────────────────────────────

const dict = cmd("dict", {
    aliases: ["define", "dictionary"],
    description: "Look up a word in Wiktionary, with pronunciation",
    args: "<word>",
    usageHint: "Usage: /dict <word>\nExample: /dict serendipity",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    const word = ctx.args.join(" ");

    if (!isDictAvailable()) {
        await ctx.reply("❌ The dictionary index isn't installed on this host.");
        return;
    }

    await ctx.status("📖 Looking it up...");

    const definition = await lookupWord(word);
    if (!definition) {
        await ctx.reply(`❌ Not found in Wiktionary: ${word}`);
        return;
    }

    await ctx.reply(truncate(`📖 ${word}\n\n${definition}`, MAX_TG_TEXT, "\n\n…(truncated)"));

    /*
    Which languages to pronounce comes from the definition's own "=== Language
    ==="  headers, not the user's /lang setting - a French entry should be read
    in French even if the chat is set to English.
    */
    const seen = new Set<string>();
    const plans: { langName: string; code: string }[] = [];
    for (const langName of extractLanguages(definition)) {
        const code = gttsCodeForLanguage(langName);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        plans.push({ langName, code });
        if (plans.length >= MAX_PRONUNCIATIONS) break;
    }

    for (const plan of plans) {
        try {
            const audio = await generateSpeech(word, plan.code);
            await ctx.tg.replyWithVoice(new InputFile(audio, `${word}-${plan.code}.mp3`), {
                caption: `🔊 ${plan.langName}`,
            });
        } catch (err) {
            // One unavailable voice shouldn't cost the others
            console.error(`📖 TTS failed for ${plan.langName} (${plan.code}):`, err);
        }
    }
});

export default feature("tools", [lang, search, removebg, denoise, convert, dict]);
