/**
 * report-targets.ts — src/lib/hi-hive/report-targets.ts
 *
 * Decides WHERE an auto-scan's delay message and report get sent, and which
 * students each copy shows.
 *
 * Precedence (highest first) for the ORIGIN chat — the chat the QR arrived in:
 *   1. An explicit `reportSettings` entry for that chat  → its rules apply.
 *   2. Private chat with no explicit entry → auto-derive a rule limited to the
 *      two people in the conversation (sender + receiver), where their jid maps
 *      to a student in the database. status = 'all'.
 *   3. Whitelisted group with no explicit entry → full report, all students.
 *   4. Non-whitelisted group → NO messages at all. Scanning still happens; the
 *      sender just gets a ❤️ reaction as a thank-you.
 *
 * Every `reportSettings` entry is ALWAYS a destination, on top of the origin.
 * Listed chats therefore behave as if whitelisted.
 */

import { jidNormalizedUser, type WAMessage, type WASocket } from "@whiskeysockets/baileys";
import { reportSettings, type ReportSetting } from "../../config/report-settings.js";
import { isWhitelisted } from "./scan-buffer-db.js";
import { loadCreds } from "./creds.js";
import type { ReportStatus } from "./scan-status.js";

export interface Destination {
  chatId:     string;
  filterIds?: string[];              // undefined = every student
  status:     "all" | ReportStatus[]; // normalised to an array (or 'all')
  isOrigin:   boolean;               // is this the chat the QR came from?
  showDelay:  boolean;               // send the "queued" message to this chat?
}

/** Normalise a setting's `status` field into 'all' | ReportStatus[]. */
function normaliseStatus(s: ReportSetting["status"]): "all" | ReportStatus[] {
  if (s === "all") return "all";
  return Array.isArray(s) ? s : [s];
}

/** Map a WhatsApp jid to a student id, if that jid has personal creds stored. */
async function studentIdForJid(jid: string | null | undefined): Promise<string | null> {
  if (!jid) return null;
  try {
    const creds = await loadCreds(jid);
    return creds?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Work out the two participants of a private chat and return whichever of them
 * are registered students. Used to scope a PM report to just those two people.
 */
async function privateChatFilterIds(
  sock: WASocket,
  msg: WAMessage,
  chatId: string
): Promise<string[] | undefined> {
  const ownId  = sock.user?.id  ? jidNormalizedUser(sock.user.id) : null;
  const ownLid = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : null;

  // Who sent it, who received it
  const sender   = msg.key.fromMe ? (ownId ?? ownLid) : chatId;
  const receiver = msg.key.fromMe ? chatId : (ownId ?? ownLid);

  const ids = new Set<string>();
  for (const jid of [sender, receiver, ownLid, chatId]) {
    const sid = await studentIdForJid(jid ?? undefined);
    if (sid) ids.add(sid);
  }

  // No registered student on either side → don't over-filter into an empty
  // report; fall back to showing everyone.
  return ids.size > 0 ? [...ids] : undefined;
}

/**
 * Build the full destination list for one scanned QR.
 *
 * @returns destinations plus a flag telling the caller whether the origin chat
 *          should stay silent (non-whitelisted group → ❤️ reaction only).
 */
export async function resolveDestinations(
  sock: WASocket,
  msg: WAMessage,
  chatId: string
): Promise<{ destinations: Destination[]; originSilent: boolean }> {
  const isGroup = chatId.endsWith("@g.us");
  const destinations: Destination[] = [];

  // ── 1. Every configured reportSettings entry is always a destination ──────
  for (const setting of reportSettings) {
    destinations.push({
      chatId:    setting.chatId,
      filterIds: setting.filterIds,
      status:    normaliseStatus(setting.status),
      isOrigin:  setting.chatId === chatId,
      showDelay: setting.showDelay ?? true,   // default: show the countdown
    });
  }

  const originHasExplicitRule = reportSettings.some(s => s.chatId === chatId);

  // ── 2. Origin chat, when it isn't already covered by an explicit rule ─────
  if (!originHasExplicitRule) {
    if (!isGroup) {
      // Private chat — scope the report to the two people in the conversation
      const filterIds = await privateChatFilterIds(sock, msg, chatId);
      destinations.push({ chatId, filterIds, status: "all", isOrigin: true, showDelay: true });
      console.log(`[reportTargets] PM ${chatId} → filterIds=${filterIds ? filterIds.join(",") : "ALL"}`);
    } else if (await isWhitelisted(chatId)) {
      // Whitelisted group — full report
      destinations.push({ chatId, filterIds: undefined, status: "all", isOrigin: true, showDelay: true });
      console.log(`[reportTargets] whitelisted group ${chatId} → full report`);
    } else {
      // Non-whitelisted group — scan silently, thank the sender with ❤️
      console.log(`[reportTargets] group ${chatId} not whitelisted → silent (❤️ only)`);
      return { destinations, originSilent: true };
    }
  }

  return { destinations, originSilent: false };
}

/** Does this destination want a student included? */
export function includesStudent(dest: Destination, studentId: string): boolean {
  if (!dest.filterIds) return true;
  return dest.filterIds.includes(studentId);
}

/** Does this destination want to hear about this outcome? */
export function includesStatus(dest: Destination, status: ReportStatus): boolean {
  if (dest.status === "all") return true;
  return dest.status.includes(status);
}


/**
 * Work out who supplied this QR, for the "Scanned by" header and the
 * contribution ranking.
 *
 * Returns the display label (masked to "Hidden User" when their creds are
 * hidden) and the doc id to credit, when the sender's jid maps to a stored
 * account.
 */
export async function resolveScannedBy(
  sock: WASocket,
  msg: WAMessage,
  chatId: string
): Promise<{ label: string; docId: string | null }> {
  const isGroup = chatId.endsWith("@g.us");
  const ownId   = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
  const ownLid  = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : null;

  // Sender jid: the participant in a group, otherwise whichever side sent it
  const senderJid = isGroup
    ? (msg.key.participant ?? null)
    : (msg.key.fromMe ? (ownId ?? ownLid) : chatId);

  for (const jid of [senderJid, ownLid, ownId]) {
    if (!jid) continue;
    try {
      const creds = await loadCreds(jid);
      if (creds) {
        return {
          label: creds.hidden ? "Hidden User" : creds.id,
          docId: jid,
        };
      }
    } catch { /* keep trying */ }
    if (jid === senderJid) break;   // only fall back for the bot's own ids
  }

  return { label: "Unknown User", docId: null };
}

/** Header line shown above the delay message and the report. */
export function scannedByHeader(label: string): string {
  return `📤 *Scanned by:* \`${label}\`\n`;
}