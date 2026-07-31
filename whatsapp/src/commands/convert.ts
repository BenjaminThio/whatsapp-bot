import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { findMedia, downloadMedia, formatBytes, type FoundMedia } from "../lib/media.js";

// Format support
const IMAGE_FORMATS = new Set([
    "png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif", "ico",
]);
const AUDIO_FORMATS = new Set([
    "mp3", "ogg", "wav", "flac", "m4a", "aac", "opus",
]);

/*
Static image formats - animated GIF => these triggers the frames-to-ZIP flow.
(WebP and APNG/GIF themselves can be animated, so they're NOT in this set.)
*/
const STATIC_IMAGE_FORMATS = new Set([
    "png", "jpg", "jpeg", "bmp", "tiff", "tif", "ico",
]);

const AUDIO_ENCODER: Record<string, string[]> = {
    mp3:  ["-c:a", "libmp3lame", "-b:a", "192k"],
    ogg:  ["-c:a", "libvorbis", "-q:a", "5"],
    opus: ["-c:a", "libopus", "-b:a", "96k"],
    m4a:  ["-c:a", "aac", "-b:a", "192k"],
    aac:  ["-c:a", "aac", "-b:a", "192k"],
    wav:  ["-c:a", "pcm_s16le"],
    flac: ["-c:a", "flac"],
};

const FFMPEG_FORMAT: Record<string, string> = {
    mp3: "mp3", ogg: "ogg", opus: "opus", m4a: "ipod", aac: "adts",
    wav: "wav", flac: "flac",
    png: "image2", jpg: "image2", jpeg: "image2", webp: "webp",
    bmp: "image2", gif: "image2", tiff: "image2", tif: "image2", ico: "image2",
};

const OUTPUT_MIME: Record<string, string> = {
    mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg",
    m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", bmp: "image/bmp", gif: "image/gif",
    tiff: "image/tiff", tif: "image/tiff", ico: "image/x-icon",
};

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 60_000;
const MAX_FRAMES = 500;

// Generic ffmpeg pipeline (single in => single out via stdio)
function convertWithFfmpeg(
    inputBuf: Buffer,
    targetExt: string,
    isImage: boolean,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"];

        if (isImage) {
            args.push("-frames:v", "1");
            if (targetExt === "jpg" || targetExt === "jpeg") {
                args.push("-q:v", "2");
            }
        } else {
            const enc = AUDIO_ENCODER[targetExt];
            if (enc) args.push(...enc);
        }

        const fmt = FFMPEG_FORMAT[targetExt];
        if (fmt) args.push("-f", fmt);
        args.push("pipe:1");

        const worker = spawn("ffmpeg", args);
        const outChunks: Buffer[] = [];
        let errText = "";
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { worker.kill("SIGKILL"); } catch { /* already dead */ }
            reject(new Error(`ffmpeg timed out after ${CONVERT_TIMEOUT_MS / 1000}s. Stderr:\n${errText.trim() || "(empty)"}`));
        }, CONVERT_TIMEOUT_MS);

        worker.stdout.on("data", (chunk: Buffer) => outChunks.push(chunk));
        worker.stderr.on("data", (chunk: Buffer) => { errText += chunk.toString("utf8"); });
        worker.stdin.on("error", (err: any) => {
            if (err.code !== "EPIPE") console.error("ffmpeg stdin error:", err);
        });

        worker.on("error", (err) => {
            if (settled) return;
            settled = true; clearTimeout(timeout);
            reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Is ffmpeg installed and on PATH?`));
        });

        worker.on("close", (code) => {
            if (settled) return;
            settled = true; clearTimeout(timeout);
            if (code !== 0) {
                return reject(new Error(`ffmpeg exited with code ${code}.\n--- stderr ---\n${errText.trim() || "(empty)"}\n--- end ---`));
            }
            const out = Buffer.concat(outChunks);
            if (out.length === 0) return reject(new Error("ffmpeg produced no output."));
            resolve(out);
        });

        worker.stdin.write(inputBuf, (err) => {
            if (err && (err as any).code !== "EPIPE") console.error("ffmpeg stdin write error:", err);
        });
        worker.stdin.end();
    });
}

/*
GIF => frames => ZIP pipeline
ffmpeg can write a sequence of numbered files. We dump frames into a temp
dir, then read them back and pack into a ZIP. Temp dir gets cleaned up
in a finally block whether we succeed or fail.
*/
async function extractGifFramesToZip(
    inputBuf: Buffer,
    targetExt: string,
    baseName: string,
): Promise<Buffer> {
    const tempDir = mkdtempSync(path.join(tmpdir(), "gif-frames-"));
    try {
        // run ffmpeg, writing frames as frame_001.png, frame_002.png, ...
        await new Promise<void>((resolve, reject) => {
            const pattern = path.join(tempDir, `frame_%03d.${targetExt}`);
            const args = [
                "-hide_banner", "-loglevel", "error",
                "-i", "pipe:0",
                "-vframes", String(MAX_FRAMES),  // safety cap
            ];
            if (targetExt === "jpg" || targetExt === "jpeg") {
                args.push("-q:v", "2");
            }
            args.push(pattern);

            const worker = spawn("ffmpeg", args);
            let errText = "";
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { worker.kill("SIGKILL"); } catch { /* */ }
                reject(new Error(`ffmpeg frame-extraction timed out. Stderr:\n${errText.trim() || "(empty)"}`));
            }, CONVERT_TIMEOUT_MS);

            worker.stderr.on("data", (c: Buffer) => { errText += c.toString("utf8"); });
            worker.stdin.on("error", (err: any) => {
                if (err.code !== "EPIPE") console.error("ffmpeg stdin error:", err);
            });

            worker.on("error", (err) => {
                if (settled) return;
                settled = true; clearTimeout(timeout);
                reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
            });

            worker.on("close", (code) => {
                if (settled) return;
                settled = true; clearTimeout(timeout);
                if (code !== 0) return reject(new Error(`ffmpeg exited ${code}.\nStderr: ${errText.trim() || "(empty)"}`));
                resolve();
            });

            worker.stdin.write(inputBuf, (err) => {
                if (err && (err as any).code !== "EPIPE") console.error("ffmpeg stdin write error:", err);
            });
            worker.stdin.end();
        });

        // list extracted frames
        const files = readdirSync(tempDir)
            .filter(f => f.startsWith("frame_") && f.endsWith(`.${targetExt}`))
            .sort();  // numbered naming sorts naturally

        if (files.length === 0) {
            throw new Error("ffmpeg extracted zero frames. Is the input actually animated?");
        }

        console.log(`🔄 Extracted ${files.length} frames`);

        // pack into a ZIP in memory using JSZip
        const zip = new JSZip();
        const folder = `${baseName}_frames`;
        for (const f of files) {
            const data = readFileSync(path.join(tempDir, f));
            zip.file(`${folder}/${f}`, data);
        }
        const zipBuf = await zip.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE",
            compressionOptions: { level: 6 },
        });

        return zipBuf;

    } finally {
        // Always clean up the temp directory
        try { rmSync(tempDir, { recursive: true, force: true }); }
        catch (e) { console.warn("Failed to clean temp dir:", e); }
    }
}

// Input extraction

interface MediaSource {
    found: FoundMedia;
    /** What we treat it AS, which for documents comes from the mimetype. */
    kind: "image" | "audio";
    sourceMime: string;
    /** Original filename if WhatsApp preserved one (documents only) */
    originalName: string | null;
}

/*
Documents carry their real type in the mimetype, so an image sent "as a file"
still converts. Anything else is not something ffmpeg can help with here.
*/
function classify(found: FoundMedia): MediaSource | null {
    if (found.kind === "image") {
        return { found, kind: "image", sourceMime: found.mimetype, originalName: found.fileName };
    }
    if (found.kind === "audio") {
        return { found, kind: "audio", sourceMime: found.mimetype, originalName: found.fileName };
    }
    if (found.kind === "document") {
        if (found.mimetype.startsWith("image/")) {
            return { found, kind: "image", sourceMime: found.mimetype, originalName: found.fileName };
        }
        if (found.mimetype.startsWith("audio/")) {
            return { found, kind: "audio", sourceMime: found.mimetype, originalName: found.fileName };
        }
    }
    return null;
}

function findSource(msg: WAMessage): MediaSource | null {
    const found = findMedia(msg, ["image", "audio", "document"]);
    return found ? classify(found) : null;
}

/*
Compute output filename. If the source had a filename, swap its extension;
otherwise generate a friendly timestamped name like "image_20260524_142318.png".
*/
function computeOutputName(source: MediaSource, targetExt: string): string {
    return `${computeBaseName(source)}.${targetExt}`;
}

// Base name without extension, also used for folder names inside ZIPs.
function computeBaseName(source: MediaSource): string {
    if (source.originalName) return path.parse(source.originalName).name;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");
    return `${source.kind}_${stamp}`;
}

const FORMAT_LIST =
    "*Image formats:* png, jpg, webp, bmp, gif, tiff, ico\n" +
    "*Audio formats:* mp3, ogg, wav, flac, m4a, aac, opus";

// Handler
async function handleConvert(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    // Leading dot is tolerated: "!convert .png" == "!convert png"
    const targetExt = ctx.args[0].toLowerCase().replace(/^\./, "");
    const isImageTarget = IMAGE_FORMATS.has(targetExt);
    const isAudioTarget = AUDIO_FORMATS.has(targetExt);

    if (!isImageTarget && !isAudioTarget) {
        await ctx.replyText(`❌ Unsupported format: \`${targetExt}\`\n\n${FORMAT_LIST}`);
        return;
    }

    const source = findSource(ctx.msg);
    if (!source) {
        await ctx.replyText(
            `⚠️ No convertible media found. Attach an image/audio with \`${cmd("convert")} <format>\` ` +
            "as the caption, or reply to a media message."
        );
        return;
    }

    if (source.kind === "image" && isAudioTarget) {
        await ctx.replyText(`❌ Can't convert an image to an audio format (\`${targetExt}\`).`);
        return;
    }
    if (source.kind === "audio" && isImageTarget) {
        await ctx.replyText(`❌ Can't convert audio to an image format (\`${targetExt}\`).`);
        return;
    }

    try {
        await ctx.react("🔄");

        const inputBuf = await downloadMedia(source.found);

        if (inputBuf.length > MAX_INPUT_BYTES) {
            await ctx.replyText(
                `❌ File too large: ${formatBytes(inputBuf.length)} ` +
                `(limit is ${formatBytes(MAX_INPUT_BYTES)}).`
            );
            return;
        }

        // Branch: animated GIF => static image format => ZIP of frames
        const isAnimatedGif = source.sourceMime === "image/gif";
        const isStaticImageTarget = STATIC_IMAGE_FORMATS.has(targetExt);

        if (isAnimatedGif && isStaticImageTarget) {
            console.log(`🔄 GIF => frames as .${targetExt} (will ZIP)`);

            const baseName = computeBaseName(source);
            const zipBuf = await extractGifFramesToZip(inputBuf, targetExt, baseName);

            console.log(`🔄 Final ZIP: ${formatBytes(zipBuf.length)}`);

            await ctx.reply({
                document: zipBuf,
                mimetype: "application/zip",
                fileName: `${baseName}_frames.zip`,
                caption: `✅ Extracted frames from GIF as \`.${targetExt}\``,
            });
            return;
        }

        // Branch: regular single-file conversion
        console.log(`🔄 Converting ${source.kind} (${source.sourceMime}, ${formatBytes(inputBuf.length)}) => .${targetExt}`);

        const outputBuf = await convertWithFfmpeg(inputBuf, targetExt, source.kind === "image");
        const outputName = computeOutputName(source, targetExt);

        console.log(`🔄 Output: ${outputName} (${formatBytes(outputBuf.length)})`);

        await ctx.reply({
            document: outputBuf,
            mimetype: OUTPUT_MIME[targetExt] || "application/octet-stream",
            fileName: outputName,
            caption: `✅ Converted to \`.${targetExt}\``,
        });

    } catch (error: any) {
        console.error("Convert error:", error?.message || error);

        const errMsg = error?.message || "";
        let userMsg = "❌ Conversion failed. Check server logs.";
        if (errMsg.includes("ENOENT") || errMsg.includes("on PATH")) {
            userMsg = "❌ ffmpeg is not installed or not on PATH on the server.";
        } else if (errMsg.includes("Invalid data") || errMsg.includes("could not find codec")) {
            userMsg = "❌ Couldn't decode the input file. The source format may not be supported.";
        } else if (errMsg.includes("zero frames")) {
            userMsg = "❌ Input doesn't appear to contain animated frames.";
        }

        await ctx.replyText(userMsg);
    }
}

const command: Command = {
    name: "convert",
    aliases: ["conv", "to"],
    description: "Convert images or audio between formats (animated GIFs become ZIP of frames)",
    usage: `${cmd("convert")} <format> (attach or reply to media)`,
    usageHint:
        `⚠️ *Usage:* \`${cmd("convert")} <format>\`\n\n` +
        `Attach an image or audio file with \`${cmd("convert")} png\` as the caption, ` +
        "or reply to one with the command.\n\n" +
        FORMAT_LIST + "\n\n" +
        "_Animated GIFs convert to static formats as a ZIP of individual frames._",
    requiresArgs: true,
    handler: handleConvert,
};

export default command;