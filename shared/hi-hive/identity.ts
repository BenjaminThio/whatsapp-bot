/**
 * identity.ts - learn who an account belongs to, passively.
 *
 * Both platforms hand you a display name and an id on every message that
 * arrives. Nothing here queries a server, sends a message, or pings anyone -
 * it only records what already came through the door.
 *
 * WHERE AN ID COMES FROM, WITHOUT CONTACTING ANYONE
 *
 *   WhatsApp (Baileys)
 *     msg.key.remoteJid          the chat. In a DM this IS the person.
 *     msg.key.participant        in a group, the individual who sent it.
 *     msg.pushName               the name they chose, on every message.
 *     contextInfo.participant    the author of a message being quoted -
 *                                so quoting someone identifies them.
 *     contextInfo.mentionedJid   everyone @-mentioned in a message.
 *     sock.groupMetadata(jid)    EVERY member of a group at once, ids and all,
 *                                with no message sent. The broadest source.
 *     group-participants.update  joins and leaves, as they happen.
 *     sock.onWhatsApp(number)    asks the server whether a number is
 *                                registered. It is a lookup, not a message,
 *                                but it does talk to WhatsApp - so it is the
 *                                one to use sparingly.
 *
 *   Telegram (grammY)
 *     ctx.from.id                the sender, on every update.
 *     ctx.from.username / first_name
 *     reply_to_message.from      the person being replied to.
 *     new_chat_members           joins.
 *     getChatMember(chat, user)  a lookup for someone already known.
 *
 * Telegram cannot enumerate a group's members through the Bot API at all, so
 * there the only practical route is "seen speaking" - which is exactly what
 * this module accumulates.
 *
 * The @lid caveat: WhatsApp increasingly addresses people by a privacy id
 * (`...@lid`) rather than their phone number (`...@s.whatsapp.net`). The two
 * are different strings for the same human, so an id learned in one context
 * may not equal one learned in another. Store what you saw; do not assume two
 * different-looking ids are different people.
 */

import sql from "../db/index.js";
import { invalidateCredsCache } from "./creds.js";

/** Names shorter than this are noise ("A", "-") and not worth storing. */
const MIN_NAME = 2;
const MAX_NAME = 120;

function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < MIN_NAME) return null;
  return name.slice(0, MAX_NAME);
}

/**
 * Record the display name and account for whoever just spoke.
 *
 * Matches on jid first, then on doc_id, so it works whether the row is keyed by
 * the account (personal) or by a student id (anonymous, later bound). Does
 * nothing when there is no matching row - seeing a stranger speak should not
 * create credentials.
 *
 * Cheap enough to call on every message: one UPDATE that usually matches
 * nothing, and it skips the write entirely when the name has not changed.
 */
export async function rememberIdentity(
  platformId: string, displayName: string | null | undefined
): Promise<void> {
  const id = platformId?.trim();
  if (!id) return;

  const name = cleanName(displayName);

  const updated = await sql`
    UPDATE hi_hive
       SET jid          = COALESCE(jid, ${id}),
           display_name = COALESCE(${name}, display_name),
           name_seen_at = CASE WHEN ${name}::text IS NULL THEN name_seen_at ELSE now() END
     WHERE (jid = ${id} OR doc_id = ${id})
       AND (jid IS NULL
            OR display_name IS DISTINCT FROM COALESCE(${name}, display_name))
    RETURNING doc_id
  `;

  if (updated.length > 0) invalidateCredsCache();
}

/**
 * Attach an account to a doc explicitly. Used by `bind`, where the jid is known
 * for certain rather than inferred from who happened to speak.
 */
export async function setDocIdentity(
  docId: string, jid: string, displayName?: string | null
): Promise<void> {
  const name = cleanName(displayName);
  await sql`
    UPDATE hi_hive
       SET jid          = ${jid},
           display_name = COALESCE(${name}, display_name),
           name_seen_at = CASE WHEN ${name}::text IS NULL THEN name_seen_at ELSE now() END
     WHERE doc_id = ${docId}
  `;
  invalidateCredsCache();
}

/** What to call this person on a leaderboard, in order of preference. */
export function labelFor(row: {
  displayName?: string | null; studentId: string; hidden: boolean;
}): string {
  if (row.hidden) return "Hidden User";
  return row.displayName ?? row.studentId;
}
