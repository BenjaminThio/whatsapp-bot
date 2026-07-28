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
import { loadCreds, getAllDocs } from "./creds.js";
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
  // Escape hatch: set PM_FILTER_PARTICIPANTS=0 to disable the two-person
  // scoping entirely and always show every student in private chats.
  if (process.env["PM_FILTER_PARTICIPANTS"] === "0") {
    console.log(`[reportTargets] PM scoping disabled by env → showing all`);
    return undefined;
  }

  const ownId  = sock.user?.id  ? jidNormalizedUser(sock.user.id) : null;
  const ownLid = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : null;

  // Who sent it, who received it
  const sender   = msg.key.fromMe ? (ownId ?? ownLid) : chatId;
  const receiver = msg.key.fromMe ? chatId : (ownId ?? ownLid);

  const ids = new Set<string>();
  for (const jid of [sender, receiver, ownLid, ownId, chatId]) {
    const sid = await studentIdForJid(jid ?? undefined);
    if (sid) ids.add(sid);
  }
  console.log(`[reportTargets] PM participants resolved to: ${[...ids].join(",") || "(none)"}`);

  if (ids.size === 0) {
    console.log(`[reportTargets] no participant mapped to a student → showing all`);
    return undefined;
  }

  /*
  CRITICAL: a filter listing students that aren't actually registered would
  match zero queued jobs and silently drop the whole PM report. Verify the
  derived ids against the real account list and only keep the ones that exist.
  If none survive, show everyone instead of going silent.
  */
  const registered = new Set(
    Object.values(await getAllDocs()).map((c: any) => String(c.id))
  );
  const usable = [...ids].filter(id => registered.has(id));

  if (usable.length === 0) {
    console.log(`[reportTargets] none of [${[...ids].join(",")}] are registered accounts → showing all`);
    return undefined;
  }

  console.log(`[reportTargets] PM filter = ${usable.join(",")}`);
  return usable;
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
      console.log(`[reportTargets] group ${chatId} not whitelisted → silent (❤️ only), ` +
        `${destinations.length} configured destination(s) still notified`);
      return { destinations, originSilent: true };
    }
  }

  /*
  Hard guarantee: unless this chat is a deliberately-silent non-whitelisted
  group, the ORIGIN must always be among the destinations. If any branch above
  failed to add it, add it now with no filter — the person who sent the QR
  always deserves to see what happened.
  */
  if (!destinations.some(d => d.chatId === chatId)) {
    console.log(`[reportTargets] origin ${chatId} was missing — adding it unfiltered.`);
    destinations.push({ chatId, filterIds: undefined, status: "all", isOrigin: true, showDelay: true });
  }

  // Dedupe by chatId — if a configured entry and the origin are the same chat,
  // the configured rule wins and we must not send twice.
  const seen = new Set<string>();
  const deduped = destinations.filter(d => {
    if (seen.has(d.chatId)) return false;
    seen.add(d.chatId);
    return true;
  });

  console.log(`[reportTargets] resolved ${deduped.length} destination(s):`);
  for (const d of deduped) {
    console.log(`   → ${d.chatId} origin=${d.isOrigin} ` +
      `filter=${d.filterIds ? d.filterIds.join(",") : "ALL"} ` +
      `status=${d.status === "all" ? "all" : d.status.join("/")} showDelay=${d.showDelay}`);
  }

  return { destinations: deduped, originSilent: false };
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
/**
 * Find stored creds for a jid, tolerating the different forms WhatsApp uses.
 *
 * The same person can appear as:
 *   210977484189809@lid            ← how creds are usually keyed
 *   601118985323@s.whatsapp.net    ← phone form
 *   601118985323:18@s.whatsapp.net ← with a device suffix
 *
 * An exact-string lookup misses all but one of those, so we also compare the
 * user part (before "@", minus any ":device") against every stored doc id.
 */
async function findCredsForJid(jid: string): Promise<{ docId: string; creds: any } | null> {
  // 1. Exact match — the common case
  try {
    const creds = await loadCreds(jid);
    if (creds) return { docId: jid, creds };
  } catch { /* fall through */ }

  // 2. Match on the user part, ignoring server and device suffix
  const userPart = jid.split("@")[0].split(":")[0];
  if (!userPart) return null;

  try {
    const all = await getAllDocs();
    for (const [docId, creds] of Object.entries(all)) {
      const docUser = docId.split("@")[0].split(":")[0];
      if (docUser === userPart) return { docId, creds };
    }
  } catch { /* ignore */ }

  return null;
}

export async function resolveScannedBy(
  sock: WASocket,
  msg: WAMessage,
  chatId: string
): Promise<{ label: string; docId: string | null }> {
  const isGroup = chatId.endsWith("@g.us");
  const ownId   = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
  const ownLid  = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : null;
  const rawOwn  = sock.user?.id ?? null;
  const rawLid  = (sock.user as any)?.lid ?? null;

  // Who sent it: the group participant, otherwise whichever side of the PM
  const senderJid = isGroup
    ? (msg.key.participant ?? null)
    : (msg.key.fromMe ? (ownId ?? ownLid) : chatId);

  /*
  Candidates in priority order. When the message is fromMe the sender IS the bot
  owner, so their own lid/phone forms are legitimate fallbacks — a previous
  version broke out of this loop after the first entry, which is why everything
  came back as "Unknown User".
  */
  const candidates: (string | null)[] = [senderJid];
  if (msg.key.fromMe || !isGroup) {
    candidates.push(ownLid, ownId, rawLid, rawOwn);
  }

  for (const jid of candidates) {
    if (!jid) continue;
    const hit = await findCredsForJid(jid);
    if (hit) {
      console.log(`[reportTargets] scanned by ${hit.creds.id} (matched ${jid} → doc ${hit.docId})`);
      return {
        label: hit.creds.hidden ? "Hidden User" : hit.creds.id,
        docId: hit.docId,
      };
    }
  }

  console.log(`[reportTargets] scanned by UNKNOWN — tried: ${candidates.filter(Boolean).join(", ")}`);
  return { label: "Unknown User", docId: null };
}

/** Header line shown above the delay message and the report. */
export function scannedByHeader(label: string): string {
  return `📤 *Scanned by:* \`${label}\`\n`;
}


/**
 * Is this chat one we must stay silent in?
 *
 * Computed live from the whitelist and reportSettings — deliberately NOT read
 * from the scan_buffer row. The stored `origin_silent` column is newer than
 * some rows and may be missing entirely if the migration hasn't run, and a
 * missing value read as `false` is what let the ✅ overwrite the ❤️ on
 * non-whitelisted groups.
 *
 * Private chats are never silent. Groups are silent unless whitelisted or named
 * in reportSettings.
 */
export async function isSilentChat(chatId: string): Promise<boolean> {
  if (!chatId.endsWith("@g.us")) return false;                     // PMs always talk
  if (reportSettings.some(s => s.chatId === chatId)) return false;  // configured = allowed
  return !(await isWhitelisted(chatId));
}