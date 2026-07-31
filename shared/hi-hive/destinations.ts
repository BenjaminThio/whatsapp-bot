/**
 * destinations.ts - shared/hi-hive/destinations.ts
 *
 * Where an auto-scan's report goes, and which students each copy shows.
 *
 * The shape and the pure predicates live here because the scan-buffer service
 * (shared by both bots) has to filter reports without knowing anything about
 * Baileys or grammY. Working out the destinations for an incoming WhatsApp
 * message needs the socket and the message, so that half stays in
 * whatsapp/src/lib/hi-hive/report-targets.ts.
 */

import { reportSettings } from "../config/report-settings.js";
import { isWhitelisted } from "./scan-buffer-db.js";
import type { ReportStatus } from "./scan-status.js";
import type { TransportName } from "../messaging/types.js";

export interface Destination {
  chatId:     string;
  filterIds?: string[];               // undefined = every student
  status:     "all" | ReportStatus[]; // normalised to an array (or 'all')
  isOrigin:   boolean;                // is this the chat the QR came from?
  showDelay:  boolean;                // send the "queued" message to this chat?
  /** Which bot delivers it. Absent means WhatsApp, for rows written before the split. */
  transport?: TransportName;
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

/** Header line shown above the delay message and the report. */
export function scannedByHeader(label: string): string {
  return `📤 *Scanned by:* \`${label}\`
`;
}

/**
 * Is this chat one we must stay silent in?
 *
 * Computed live from the whitelist and reportSettings - deliberately NOT read
 * from the scan_buffer row. The stored `origin_silent` column is newer than
 * some rows and may be missing entirely, and a missing value read as `false` is
 * what let the ✅ overwrite the ❤️ on non-whitelisted groups.
 *
 * Private chats are never silent. Groups are silent unless whitelisted or named
 * in reportSettings.
 */
export async function isSilentChat(chatId: string): Promise<boolean> {
  if (!chatId.endsWith("@g.us")) return false;                      // PMs always talk
  if (reportSettings.some(s => s.chatId === chatId)) return false;  // configured = allowed
  return !(await isWhitelisted(chatId));
}
