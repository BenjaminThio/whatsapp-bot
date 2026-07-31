/**
 * types.ts - shared/messaging/types.ts
 *
 * A platform-neutral outbound message.
 *
 * Shared code (reminders, birthday wishes, attendance reports, GitHub webhook
 * notifications) has to reach whichever bot the chat belongs to, so it cannot
 * speak Baileys or grammY. It describes what to send; the transport decides how.
 *
 * Commands that only exist on one platform can still pass that platform's
 * native payload through untouched - see `NativeMessage`.
 */

export type TransportName = "whatsapp" | "telegram";

/** Telegram wants HTML or MarkdownV2; WhatsApp has its own *bold* convention. */
export type TextFormat = "plain" | "markdown" | "html";

export interface BaseOutbound {
    /** Message to reply to, as that platform's id. Best-effort. */
    replyTo?: string | number;
    /** Suppress the notification sound where the platform supports it. */
    silent?: boolean;
}

export interface TextMessage extends BaseOutbound {
    kind: "text";
    text: string;
    format?: TextFormat;
    /** Don't unfurl links. */
    noPreview?: boolean;
}

export interface MediaMessage extends BaseOutbound {
    kind: "image" | "video" | "audio" | "document" | "sticker";
    /** Raw bytes, or a URL the platform can fetch. Bytes are always safer. */
    media: Buffer | { url: string };
    caption?: string;
    format?: TextFormat;
    mimetype?: string;
    fileName?: string;
    /** Audio only: render as a voice note rather than a music file. */
    voiceNote?: boolean;
}

export interface PollMessage extends BaseOutbound {
    kind: "poll";
    question: string;
    options: string[];
    selectableCount?: number;
}

export interface ReactionMessage {
    kind: "reaction";
    emoji: string;
    /** The message being reacted to. */
    targetId: string | number;
    /** WhatsApp needs the whole message key, not just an id. */
    targetKey?: unknown;
}

/**
 * An untranslated, platform-specific payload.
 *
 * WhatsApp commands build rich Baileys content (link previews, view-once media,
 * contact cards) that has no Telegram equivalent and no reason to be modelled
 * neutrally. The transport that owns the payload sends it verbatim; any other
 * transport refuses it loudly rather than sending something wrong.
 */
export interface NativeMessage extends BaseOutbound {
    kind: "native";
    transport: TransportName;
    payload: unknown;
}

export type OutboundMessage =
    | TextMessage
    | MediaMessage
    | PollMessage
    | ReactionMessage
    | NativeMessage;

/** What a transport reports back after a successful send. */
export interface SentMessage {
    /** Platform message id, when the platform returns one. */
    id?: string;
    /** The raw send result, for callers that need more (poll tracking). */
    raw?: unknown;
}

/**
 * A bot's outbound side, as the outbox sees it.
 *
 * Implementations live next to their bot (whatsapp/src/transport.ts and
 * telegram/src/transport.ts) because each needs its own client library.
 */
export interface Transport {
    readonly name: TransportName;
    /** Can it send right now? A closed socket or an unstarted bot means no. */
    isReady(): boolean;
    send(chatId: string, message: OutboundMessage): Promise<SentMessage>;
}

// ── Convenience builders ──────────────────────────────────────────────────────

export const text = (body: string, opts: Partial<TextMessage> = {}): TextMessage =>
    ({ kind: "text", text: body, ...opts });

export const image = (
    media: Buffer | { url: string },
    caption?: string,
    opts: Partial<MediaMessage> = {}
): MediaMessage =>
    ({ kind: "image", media, caption, mimetype: "image/png", ...opts });

export const document = (
    media: Buffer | { url: string },
    fileName: string,
    opts: Partial<MediaMessage> = {}
): MediaMessage =>
    ({ kind: "document", media, fileName, ...opts });

export const audio = (
    media: Buffer | { url: string },
    opts: Partial<MediaMessage> = {}
): MediaMessage =>
    ({ kind: "audio", media, mimetype: "audio/mpeg", ...opts });

export const video = (
    media: Buffer | { url: string },
    caption?: string,
    opts: Partial<MediaMessage> = {}
): MediaMessage =>
    ({ kind: "video", media, caption, ...opts });
