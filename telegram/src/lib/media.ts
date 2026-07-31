/**
 * media.ts - relasma/src/lib/media.ts
 *
 * Finding and downloading attachments on Telegram.
 *
 * Mirrors whatsapp-bot/src/lib/media.ts so the ported commands read the same on
 * both bots: "is there an image/audio here, attached or in the message being
 * replied to?" and "give me the bytes".
 */

import type { Context } from "grammy";
import { bot } from "../bot.js";

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

export interface FoundMedia {
    fileId: string;
    kind: MediaKind;
    mimetype: string;
    fileName: string | null;
    /** Size in bytes, when Telegram reported one. */
    size: number | null;
    /** True when it came from the message the user replied to. */
    fromQuoted: boolean;
}

const DEFAULT_MIME: Record<MediaKind, string> = {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/ogg",
    document: "application/octet-stream",
    sticker: "image/webp",
};

/** Telegram's own hard cap for bot downloads. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

function pick(msg: any, kinds: MediaKind[], fromQuoted: boolean): FoundMedia | null {
    if (!msg) return null;

    for (const kind of kinds) {
        if (kind === "image" && msg.photo?.length) {
            /*
            Telegram sends an array of progressively larger renditions. The last
            is the biggest, which is what a QR scan or a background removal
            wants - a thumbnail would decode badly or come back blurry.
            */
            const best = msg.photo[msg.photo.length - 1];
            return {
                fileId: best.file_id, kind: "image", mimetype: "image/jpeg",
                fileName: null, size: best.file_size ?? null, fromQuoted,
            };
        }
        if (kind === "video" && msg.video) {
            return {
                fileId: msg.video.file_id, kind: "video",
                mimetype: msg.video.mime_type ?? DEFAULT_MIME.video,
                fileName: msg.video.file_name ?? null, size: msg.video.file_size ?? null, fromQuoted,
            };
        }
        if (kind === "audio" && (msg.voice || msg.audio)) {
            const a = msg.voice ?? msg.audio;
            return {
                fileId: a.file_id, kind: "audio",
                mimetype: a.mime_type ?? DEFAULT_MIME.audio,
                fileName: a.file_name ?? null, size: a.file_size ?? null, fromQuoted,
            };
        }
        if (kind === "document" && msg.document) {
            return {
                fileId: msg.document.file_id, kind: "document",
                mimetype: msg.document.mime_type ?? DEFAULT_MIME.document,
                fileName: msg.document.file_name ?? null, size: msg.document.file_size ?? null, fromQuoted,
            };
        }
        if (kind === "sticker" && msg.sticker) {
            return {
                fileId: msg.sticker.file_id, kind: "sticker", mimetype: DEFAULT_MIME.sticker,
                fileName: null, size: msg.sticker.file_size ?? null, fromQuoted,
            };
        }
    }
    return null;
}

const ALL_KINDS: MediaKind[] = ["image", "video", "audio", "document", "sticker"];

/**
 * Find media on the message, or on the message it replies to.
 *
 * Attached wins over quoted, matching what people expect when they send a photo
 * captioned with a command while also replying to something.
 */
export function findMedia(ctx: Context, kinds: MediaKind[] = ALL_KINDS): FoundMedia | null {
    const msg: any = ctx.message ?? ctx.channelPost;
    return pick(msg, kinds, false) ?? pick(msg?.reply_to_message, kinds, true);
}

export const findImage = (ctx: Context): FoundMedia | null => findMedia(ctx, ["image"]);

/**
 * Download the bytes.
 *
 * A document whose mimetype says image/* is treated as an image elsewhere, so
 * this deliberately doesn't care what kind it is - it just fetches the file.
 */
export async function downloadMedia(found: FoundMedia): Promise<Buffer> {
    if (found.size !== null && found.size > MAX_DOWNLOAD_BYTES) {
        throw new Error(
            `File is ${formatBytes(found.size)}; Telegram only lets bots download up to ${formatBytes(MAX_DOWNLOAD_BYTES)}.`
        );
    }

    const file = await bot.api.getFile(found.fileId);
    if (!file.file_path) throw new Error("Telegram did not return a file path for that attachment.");

    const token = process.env["BOT_TOKEN"];
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`Could not download the file (HTTP ${res.status}).`);

    return Buffer.from(await res.arrayBuffer());
}

/** Human-readable size for log lines and error messages. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
