/**
 * media.ts - src/lib/media.ts
 *
 * Finding and downloading attachments.
 *
 * Every media command needs the same two things: "is there an image/audio here,
 * either attached or in the message being replied to?" and "give me the bytes".
 * Six commands each had their own version, differing only in which media types
 * they looked for - so they also each had their own bugs about documents,
 * ephemeral messages, and the "WhatsApp hasn't finished uploading yet" case.
 */

import { downloadMediaMessage, type WAMessage } from "@whiskeysockets/baileys";
import { messageBody, quotedBody } from "./wa-text.js";

export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

export interface FoundMedia {
    /** Message-shaped object accepted by Baileys' downloader. */
    mediaMsg: any;
    /** The raw imageMessage / audioMessage / ... node. */
    node: any;
    kind: MediaKind;
    mimetype: string;
    /** Filename WhatsApp preserved (documents only), else null. */
    fileName: string | null;
    /** True when the media came from the message the user replied to. */
    fromQuoted: boolean;
}

const NODE_FIELD: Record<MediaKind, string> = {
    image:    "imageMessage",
    video:    "videoMessage",
    audio:    "audioMessage",
    document: "documentMessage",
    sticker:  "stickerMessage",
};

const DEFAULT_MIME: Record<MediaKind, string> = {
    image:    "image/jpeg",
    video:    "video/mp4",
    audio:    "audio/ogg",
    document: "application/octet-stream",
    sticker:  "image/webp",
};

const ALL_KINDS: MediaKind[] = ["image", "video", "audio", "document", "sticker"];

function pick(body: any, kinds: MediaKind[]): { node: any; kind: MediaKind } | null {
    for (const kind of kinds) {
        const node = body?.[NODE_FIELD[kind]];
        if (node) return { node, kind };
    }
    return null;
}

/**
 * Find media on the message, or on the message it replies to.
 *
 * Attached media wins over quoted media, matching what people expect when they
 * send a photo captioned with a command while also replying to something.
 */
export function findMedia(msg: WAMessage, kinds: MediaKind[] = ALL_KINDS): FoundMedia | null {
    const body = messageBody(msg);
    if (!body) return null;

    const direct = pick(body, kinds);
    if (direct) {
        return {
            // Rebuild rather than passing `msg` straight through: an ephemeral
            // message keeps the media one level deeper than the downloader looks.
            mediaMsg: { key: msg.key, message: body },
            node: direct.node,
            kind: direct.kind,
            mimetype: direct.node.mimetype || DEFAULT_MIME[direct.kind],
            fileName: direct.node.fileName ?? null,
            fromQuoted: false,
        };
    }

    const quoted = quotedBody(msg);
    if (!quoted) return null;

    const found = pick(quoted, kinds);
    if (!found) return null;

    return {
        mediaMsg: { key: msg.key, message: quoted },
        node: found.node,
        kind: found.kind,
        mimetype: found.node.mimetype || DEFAULT_MIME[found.kind],
        fileName: found.node.fileName ?? null,
        fromQuoted: true,
    };
}

/** Convenience wrapper for the very common "I only care about images" case. */
export function findImage(msg: WAMessage): FoundMedia | null {
    return findMedia(msg, ["image"]);
}

/**
 * Has WhatsApp finished making this media downloadable?
 *
 * A photo sent a fraction of a second ago arrives with neither url nor
 * directPath, and downloading it fails. Callers should tell the user to retry
 * rather than reporting a decode failure.
 */
export function isMediaReady(found: FoundMedia): boolean {
    return !!(found.node.url || found.node.directPath);
}

/** Download the media as a Buffer. */
export async function downloadMedia(found: FoundMedia): Promise<Buffer> {
    return await downloadMediaMessage(found.mediaMsg, "buffer", {}) as Buffer;
}

/** Find + download in one step. Returns null when there is nothing to download. */
export async function downloadIfPresent(
    msg: WAMessage,
    kinds: MediaKind[] = ALL_KINDS
): Promise<{ found: FoundMedia; buffer: Buffer } | null> {
    const found = findMedia(msg, kinds);
    if (!found || !isMediaReady(found)) return null;
    return { found, buffer: await downloadMedia(found) };
}

/** Human-readable size for log lines and error messages. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
