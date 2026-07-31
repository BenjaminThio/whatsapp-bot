/**
 * jid.ts - src/lib/jid.ts
 *
 * One answer to "which chat is this, and who sent it".
 *
 * Eight different files were each carrying their own copy of the same
 * if/else-if ladder over remoteJid/participant, and they had drifted: some
 * handled plain DMs (@s.whatsapp.net), some only handled @lid, and some bailed
 * out with "Unexpected result..." on a chat shape they simply hadn't met yet.
 * That is why a command could work in one chat and silently do nothing in
 * another.
 *
 *   chatId - where replies go
 *   userId - the individual, used as the credentials key
 */

import type { WAMessage } from "@whiskeysockets/baileys";

export interface ChatIds {
    chatId: string;
    userId: string;
    isGroup: boolean;
}

const GROUP_SUFFIX = "@g.us";

export function isGroupJid(jid: string | null | undefined): boolean {
    return !!jid && jid.endsWith(GROUP_SUFFIX);
}

/**
 * Resolve the chat and sender for a message, or null when the message has no
 * remoteJid at all (nothing can be done with it).
 *
 * Groups take the participant as the user. Every non-group chat - @lid,
 * @s.whatsapp.net, or anything WhatsApp invents next - treats the chat itself
 * as the user, which is the behaviour every caller actually wanted.
 */
export function resolveIds(msg: WAMessage): ChatIds | null {
    const jid = msg.key.remoteJid;
    if (!jid) return null;

    if (isGroupJid(jid)) {
        // A group message without a participant is a system/meta event
        if (!msg.key.participant) return null;
        return { chatId: jid, userId: msg.key.participant, isGroup: true };
    }

    return { chatId: jid, userId: jid, isGroup: false };
}

/** Strip the server and any ":device" suffix: "6011...:18@s.whatsapp.net" -> "6011...". */
export function jidUserPart(jid: string): string {
    return jid.split("@")[0].split(":")[0];
}

/** Do two jids refer to the same person, ignoring server and device suffix? */
export function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    if (a === b) return true;
    return jidUserPart(a) === jidUserPart(b);
}
