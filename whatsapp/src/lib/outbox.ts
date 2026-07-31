/**
 * outbox.ts - whatsapp-bot/src/lib/outbox.ts
 *
 * The WhatsApp-flavoured face of the shared outbox.
 *
 * The durable queue, the retry policy and the drain service all live in
 * shared/messaging/outbox.ts now, because reminders and attendance reports have
 * to reach whichever bot the chat belongs to. This module keeps the ergonomic
 * Baileys-shaped API the commands were written against:
 *
 *     await queueText(chatId, "done", { quotedKey: msg.key });
 *     await queueMessage(chatId, { image: buf, caption }, { quotedKey: msg.key });
 *
 * Anything passed to queueMessage is Baileys content and is sent verbatim, so
 * link previews, polls and view-once media keep working exactly as before.
 */

import {
    send, react, alreadyProcessed as sharedAlreadyProcessed,
    purgeProcessed as sharedPurgeProcessed,
    flushOutbox as sharedFlush, outboxDepth as sharedDepth,
    startOutboxService as sharedStart, registerTransport,
} from "../../../shared/messaging/outbox.js";
import type { SentMessage } from "../../../shared/messaging/types.js";
import { whatsappTransport, type NativePayload } from "../transport.js";
import { isSockOpen } from "./current-sock.js";

const TRANSPORT = "whatsapp" as const;

/*
Registered at module load, not when the service starts.

The transport exists whether or not the socket is currently up - isSockOpen()
answers liveness. Registering eagerly means a send issued during startup, before
the connection opens, is correctly recognised as "ours" and queued, rather than
being dropped because no transport was known yet.
*/
registerTransport(whatsappTransport);

export interface QueueOpts {
    /** Message to quote. Only the key is stored - the full message isn't needed. */
    quotedKey?: any;
    /**
     * The FULL message being quoted, when the caller has it.
     *
     * Baileys builds the little grey preview above a reply from the quoted
     * message's content. A key on its own is enough to link the reply, but the
     * preview comes out blank - so the inline send uses this when present, and
     * only a replay from the queue (where the body is long gone) falls back to
     * the key alone.
     */
    quoted?: any;
    /** Lower numbers send first. Reminders 1, delay notices 4, reports 5, chatter 6. */
    priority?: number;
    /** Send immediately if the socket is up, only queueing on failure. Default true. */
    immediate?: boolean;
    /** Never persist: drop the message if it can't go out right now. */
    ephemeral?: boolean;
}

/** Build the Baileys send options for a quote, preferring the full message. */
function quoteOptions(opts: QueueOpts): any {
    if (opts.quoted?.message) return { quoted: opts.quoted };
    if (opts.quotedKey) return { quoted: { key: opts.quotedKey, message: {} } };
    return undefined;
}

/**
 * Queue any Baileys message content.
 *
 * Returns the send result when it went out inline, or undefined when it was
 * persisted for later. Callers that need the sent message (polls) can check for
 * undefined; everyone else can ignore it.
 */
export async function queueMessage(
    chatId: string,
    content: any,
    opts: QueueOpts = {}
): Promise<any | undefined> {
    const payload: NativePayload = { content, options: quoteOptions(opts) };

    const sent: SentMessage | undefined = await send(
        TRANSPORT,
        chatId,
        { kind: "native", transport: TRANSPORT, payload },
        { priority: opts.priority, immediate: opts.immediate, ephemeral: opts.ephemeral }
    );

    return sent?.raw;
}

/** Queue a message that quotes the one the user sent. */
export function queueReply(chatId: string, content: any, msg: any, opts: QueueOpts = {}) {
    return queueMessage(chatId, content, { ...opts, quotedKey: msg?.key, quoted: msg });
}

export const queueText = (chatId: string, text: string, opts: QueueOpts = {}) =>
    queueMessage(chatId, { text }, opts);

/** Image with optional caption. */
export const queueImage = (
    chatId: string,
    image: Buffer,
    caption?: string,
    opts: QueueOpts = {}
) => queueMessage(chatId, { image, caption, mimetype: "image/png" }, opts);

/** Reactions are cosmetic - never queued, and never retried. */
export async function reactNow(chatId: string, emoji: string, key: any): Promise<void> {
    await react(TRANSPORT, chatId, emoji, { key });
}

/** Start draining. Call once on startup; safe to call again on reconnect. */
export const startOutboxService = sharedStart;

export const flushOutbox = () => sharedFlush(TRANSPORT);
export const outboxDepth = () => sharedDepth(TRANSPORT);
export const alreadyProcessed = (msgId: string | null | undefined) =>
    sharedAlreadyProcessed(TRANSPORT, msgId);
export const purgeProcessed = sharedPurgeProcessed;

/** Re-exported so callers don't have to reach into current-sock directly. */
export { isSockOpen };
