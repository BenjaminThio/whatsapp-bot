/**
 * report-settings.ts — src/config/report-settings.ts
 *
 * Hardcoded routing rules for auto-scan reports.
 *
 * Every QR is ALWAYS scanned, no matter where it was sent. These rules only
 * decide WHERE the delay message + scan report get delivered, and WHICH
 * students appear in each copy.
 *
 *   chatId    — the chat that receives this copy of the report.
 *               Listed chats are treated as whitelisted automatically.
 *   filterIds — only these student IDs appear in the delay message and report.
 *               `undefined` (or omitted) = include every student.
 *   status    — only send if at least one included student ended with this
 *               status. 'all' = send regardless of outcome.
 *               Accepts one status or an array of them.
 */

import type { ReportStatus } from "../hi-hive/scan-status.js";

export interface ReportSetting {
  chatId:     string;
  filterIds?: string[];
  status:     "all" | ReportStatus | ReportStatus[];
  /**
   * Send the "queued / please wait" message to this chat?
   *   true  (default) → send the delay message, then the report
   *   false           → stay quiet until the final report
   * Useful for chats that only want the outcome, not the countdown.
   */
  showDelay?: boolean;
}

export const reportSettings: ReportSetting[] = [
  // { chatId: '120363407753637765@g.us', status: 'all' },
  { chatId: '120363426873108530@g.us', status: 'all' },
  { chatId: '120363425521299083@g.us', filterIds: ['2504142', '2206851'], status: 'marked', showDelay: false }

  // ── Examples — replace with your real chat IDs ──────────────────────────
  // Only report 2504142 and 2000000, and only when someone was actually marked:
  // { chatId: "120363000000000000@g.us", filterIds: ["2504142", "2000000"], status: "marked" },
  //
  // Report only, no countdown message:
  // { chatId: "120363222222222222@g.us", status: "all", showDelay: false },
  //
  // Full report of everyone, whatever the outcome:
  // { chatId: "120363111111111111@g.us", status: "all" },
  //
  // Only tell this chat about problems:
  // { chatId: "60123456789@s.whatsapp.net", status: ["rejected", "not_enrolled", "account_unverified"] },
];