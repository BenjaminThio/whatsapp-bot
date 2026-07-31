/**
 * transport.ts - relasma/src/transport.ts
 *
 * Teaches the shared outbox how to speak grammY.
 *
 * Shared code (birthday wishes, reminders, attendance reports, webhook
 * notifications) describes a message in platform-neutral terms; this translates
 * it into Telegram Bot API calls. The WhatsApp side does the same for Baileys.
 */

import { InputFile } from "grammy";
import { bot } from "./bot.js";
import type {
    MediaMessage, OutboundMessage, SentMessage, TextFormat, Transport,
} from "../../shared/messaging/types.js";

/** Telegram caps captions at 1024 characters and message text at 4096. */
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

let running = false;

/**
 * Told by local.ts once bot.start() has been reached.
 *
 * Without this the outbox would try to deliver during startup, before grammY
 * has its bot info, and every send would throw.
 */
export function setBotRunning(value: boolean): void {
    running = value;
}

function parseMode(format: TextFormat | undefined): "HTML" | "Markdown" | undefined {
    if (format === "html") return "HTML";
    if (format === "markdown") return "Markdown";
    return undefined;
}

/** Telegram wants a number for a chat id; ours travel as strings. */
function toChatId(chatId: string): number | string {
    const n = Number(chatId);
    return Number.isSafeInteger(n) ? n : chatId;
}

/** Buffers become InputFile; a URL is passed through as a plain string. */
function toInput(media: Buffer | { url: string }, fileName?: string): InputFile | string {
    return Buffer.isBuffer(media) ? new InputFile(media, fileName) : media.url;
}

function replyParams(replyTo: string | number | undefined): Record<string, unknown> {
    if (replyTo === undefined || replyTo === "") return {};
    const id = Number(replyTo);
    if (!Number.isSafeInteger(id)) return {};
    /*
    allow_sending_without_reply matters here: a reminder may quote a message
    that has since been deleted, and without it Telegram rejects the whole send
    rather than posting it unquoted.
    */
    return { reply_parameters: { message_id: id, allow_sending_without_reply: true } };
}

function truncate(s: string | undefined, max: number): string | undefined {
    if (s === undefined) return undefined;
    return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function sendMedia(chatId: number | string, m: MediaMessage): Promise<SentMessage> {
    const common = {
        caption: truncate(m.caption, MAX_CAPTION),
        parse_mode: parseMode(m.format),
        disable_notification: m.silent,
        ...replyParams(m.replyTo),
    };
    const file = toInput(m.media, m.fileName);

    switch (m.kind) {
        case "image": {
            const r = await bot.api.sendPhoto(chatId, file, common);
            return { id: String(r.message_id), raw: r };
        }
        case "video": {
            const r = await bot.api.sendVideo(chatId, file, common);
            return { id: String(r.message_id), raw: r };
        }
        case "audio": {
            // A voice note renders as a waveform bubble; sendAudio is a music file.
            const r = m.voiceNote
                ? await bot.api.sendVoice(chatId, file, common)
                : await bot.api.sendAudio(chatId, file, common);
            return { id: String(r.message_id), raw: r };
        }
        case "sticker": {
            // Stickers take no caption or parse_mode.
            const r = await bot.api.sendSticker(chatId, file, {
                disable_notification: m.silent,
                ...replyParams(m.replyTo),
            });
            return { id: String(r.message_id), raw: r };
        }
        case "document": {
            const r = await bot.api.sendDocument(chatId, file, common);
            return { id: String(r.message_id), raw: r };
        }
    }
}

export const telegramTransport: Transport = {
    name: "telegram",

    isReady: () => running,

    async send(chatIdRaw: string, message: OutboundMessage): Promise<SentMessage> {
        const chatId = toChatId(chatIdRaw);

        switch (message.kind) {
            case "text": {
                const r = await bot.api.sendMessage(chatId, truncate(message.text, MAX_TEXT)!, {
                    parse_mode: parseMode(message.format),
                    disable_notification: message.silent,
                    ...(message.noPreview ? { link_preview_options: { is_disabled: true } } : {}),
                    ...replyParams(message.replyTo),
                });
                return { id: String(r.message_id), raw: r };
            }

            case "image":
            case "video":
            case "audio":
            case "document":
            case "sticker":
                return await sendMedia(chatId, message);

            case "poll": {
                const r = await bot.api.sendPoll(
                    chatId,
                    truncate(message.question, 300)!,
                    // grammY 1.39 expects InputPollOption objects, not bare strings.
                    message.options.map(text => ({ text: truncate(text, 100)! })),
                    {
                        allows_multiple_answers: (message.selectableCount ?? 1) > 1,
                        disable_notification: message.silent,
                        ...replyParams(message.replyTo),
                    }
                );
                return { id: String(r.message_id), raw: r };
            }

            case "reaction": {
                const id = Number(message.targetId);
                if (!Number.isSafeInteger(id)) return {};
                await bot.api.setMessageReaction(chatId, id, [
                    { type: "emoji", emoji: message.emoji as never },
                ]);
                return {};
            }

            case "native": {
                if (message.transport !== "telegram") {
                    throw new Error(`native payload for ${message.transport} cannot be sent over Telegram`);
                }
                // Telegram has no native passthrough yet - every call site here
                // builds neutral messages. Fail loudly rather than silently drop.
                throw new Error("native Telegram payloads are not supported");
            }
        }
    },
};
