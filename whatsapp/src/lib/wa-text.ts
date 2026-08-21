/**
 * wa-text.ts - whatsapp/src/lib/wa-text.ts
 *
 * Pulling the user's words out of a Baileys message.
 *
 * WhatsApp puts the typed text in a different field depending on how the
 * message was composed - a plain message, a reply, or a caption on any kind of
 * media - and wraps the whole thing again when disappearing messages are on.
 * Every feature that needed the text was re-implementing that lookup chain.
 *
 * The platform-neutral helpers (splitArgs, parseQuotedArgs, truncate) are in
 * shared/lib/text.ts and re-exported here so callers need only one import.
 */

import type { WAMessage } from "@whiskeysockets/baileys";

/** Unwrap the ephemeral (disappearing-message) envelope if there is one. */
export function messageBody(msg: WAMessage): any | null {
    return (msg.message?.ephemeralMessage?.message ?? msg.message) ?? null;
}

/** The message this one is replying to, or null. */
/**
 * Jid of whoever wrote the quoted message.
 *
 * Baileys puts it in contextInfo.participant. Null when nothing is quoted, so
 * callers can fall back to an explicitly typed id.
 */
export function quotedSenderJid(msg: WAMessage): string | null {
    const body: any = msg.message?.extendedTextMessage
        ?? (msg.message as any)?.imageMessage
        ?? (msg.message as any)?.videoMessage;
    return body?.contextInfo?.participant ?? null;
}

export function quotedBody(msg: WAMessage): any | null {
    const body = messageBody(msg);
    return body?.extendedTextMessage?.contextInfo?.quotedMessage ?? null;
}

/** The key of the message this one is replying to, or null. */
export function quotedKey(msg: WAMessage): any | null {
    const body = messageBody(msg);
    const ctx = body?.extendedTextMessage?.contextInfo;
    if (!ctx?.stanzaId) return null;
    return {
        remoteJid: msg.key.remoteJid,
        id: ctx.stanzaId,
        fromMe: false,
        participant: ctx.participant,
    };
}

/**
 * The user-visible text of a message, wherever WhatsApp decided to put it:
 * plain text, reply text, or a caption on an image/video/document.
 */
export function extractMessageText(msg: WAMessage): string {
    const body = messageBody(msg);
    if (!body) return "";

    return (
        body.conversation ||
        body.extendedTextMessage?.text ||
        body.imageMessage?.caption ||
        body.videoMessage?.caption ||
        body.documentMessage?.caption ||
        ""
    );
}


export { splitArgs, parseQuotedArgs, truncate } from "../../../shared/lib/text.js";
