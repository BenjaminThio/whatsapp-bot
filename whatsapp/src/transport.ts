/**
 * transport.ts - whatsapp-bot/src/transport.ts
 *
 * Teaches the shared outbox how to speak Baileys.
 *
 * Two kinds of payload arrive here:
 *
 *   neutral  - built by shared code (reminders, attendance reports, webhook
 *              notifications) that must work on both bots. Translated below.
 *   native   - built by a WhatsApp-only command. Baileys content and options
 *              are passed straight through, so link previews, view-once media
 *              and anything else Baileys supports keep working untouched.
 */

import type {
    MediaMessage, OutboundMessage, SentMessage, Transport,
} from "../../shared/messaging/types.js";
import { getSock, isSockOpen } from "./lib/current-sock.js";

/** What a `native` WhatsApp message carries. */
export interface NativePayload {
    content: any;
    options?: any;
}

/** Bytes, or a URL Baileys will fetch itself. */
function mediaValue(media: Buffer | { url: string }): any {
    return Buffer.isBuffer(media) ? media : { url: media.url };
}

/*
Baileys links a reply from the quoted message's key. Shared code only knows the
message id, so we rebuild the minimum Baileys needs. The little grey preview
above the reply will be blank - a native send carries the full message and keeps
it. That is the trade for being platform-neutral.
*/
function quotedFromId(chatId: string, replyTo: string | number | undefined): any {
    if (replyTo === undefined || replyTo === "") return undefined;
    return {
        quoted: {
            key: { remoteJid: chatId, id: String(replyTo), fromMe: false },
            message: {},
        },
    };
}

function toBaileys(chatId: string, message: OutboundMessage): { content: any; options?: any } {
    switch (message.kind) {
        case "text":
            return {
                content: {
                    text: message.text,
                    ...(message.noPreview ? { linkPreview: null } : {}),
                },
                options: quotedFromId(chatId, message.replyTo),
            };

        case "image":
        case "video":
        case "audio":
        case "document":
        case "sticker": {
            const m = message as MediaMessage;
            const value = mediaValue(m.media);
            const base: any = {};

            if (m.kind === "image") { base.image = value; base.caption = m.caption; }
            else if (m.kind === "video") { base.video = value; base.caption = m.caption; }
            else if (m.kind === "audio") { base.audio = value; if (m.voiceNote) base.ptt = true; }
            else if (m.kind === "sticker") { base.sticker = value; }
            else {
                base.document = value;
                base.fileName = m.fileName ?? "file";
                base.caption = m.caption;
            }

            if (m.mimetype) base.mimetype = m.mimetype;
            return { content: base, options: quotedFromId(chatId, m.replyTo) };
        }

        case "poll":
            return {
                content: {
                    poll: {
                        name: message.question,
                        values: message.options,
                        selectableCount: message.selectableCount ?? 1,
                    },
                },
                options: quotedFromId(chatId, message.replyTo),
            };

        case "reaction":
            return {
                content: {
                    react: {
                        text: message.emoji,
                        // A reaction needs the real key; an id alone cannot address it.
                        key: message.targetKey ?? { remoteJid: chatId, id: String(message.targetId), fromMe: false },
                    },
                },
            };

        case "native": {
            if (message.transport !== "whatsapp") {
                throw new Error(`native payload for ${message.transport} cannot be sent over WhatsApp`);
            }
            const payload = message.payload as NativePayload;
            return { content: payload.content, options: payload.options };
        }
    }
}

export const whatsappTransport: Transport = {
    name: "whatsapp",

    isReady: () => isSockOpen(),

    async send(chatId: string, message: OutboundMessage): Promise<SentMessage> {
        const sock = getSock();
        if (!sock) throw new Error("no socket");

        const { content, options } = toBaileys(chatId, message);
        const result = await sock.sendMessage(chatId, content, options);

        return { id: result?.key?.id ?? undefined, raw: result };
    },
};
