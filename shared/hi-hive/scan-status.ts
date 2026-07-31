// Rich, human-readable statuses for the auto-scan report.

export type ReportStatus =
  // Success
  | "marked"              // server recorded attendance just now
  | "already_marked"      // attendance for this class was already recorded earlier
  // Bot-side skips (we chose not to submit)
  | "not_enrolled"        // student isn't enrolled in this course
  | "not_in_schedule"     // QR doesn't match the student's known timetable (smart-skip)
  | "account_unverified"  // account couldn't be verified (likely fake / wrong creds)
  // Server-side rejections / problems
  | "rejected"            // server refused (wrong datetime, not enrolled server-side, etc.)
  | "window_closed"       // QR window had not opened yet or had already passed
  | "session_expired"     // login/session expired on the server
  | "unclear"             // server replied but the outcome couldn't be parsed
  | "scan_failed"         // the scan call itself failed (corrupt creds / no result)
  | "network_error"       // network problem reaching the server
  | "auth_error";         // could not establish a server session

interface StatusMeta {
  emoji: string;
  label: string;       // short label shown after "Status:"
  sentence: string;    // full polished explanation
}

export const STATUS_META: Record<ReportStatus, StatusMeta> = {
  marked: {
    emoji: "✅",
    label: "Marked",
    sentence: "Attendance was successfully recorded.",
  },
  already_marked: {
    emoji: "☑️",
    label: "Already Marked",
    sentence: "Attendance for this class had already been recorded earlier, so it was skipped.",
  },
  not_enrolled: {
    emoji: "🚫",
    label: "Not Enrolled",
    sentence: "This student is not enrolled in this course, so the scan was skipped.",
  },
  not_in_schedule: {
    emoji: "📭",
    label: "Not In Schedule",
    sentence: "This class does not appear in the student's timetable, so the scan was skipped.",
  },
  account_unverified: {
    emoji: "🛑",
    label: "Unverified Account",
    sentence: "The account could not be verified and may not exist, so it was skipped.",
  },
  rejected: {
    emoji: "❌",
    label: "Rejected",
    sentence: "The server rejected the scan, usually because of a wrong date/time or an enrollment mismatch.",
  },
  window_closed: {
    emoji: "⏱️",
    label: "Window Closed",
    sentence: "The scanning window for this class is not currently open.",
  },
  session_expired: {
    emoji: "🔐",
    label: "Session Expired",
    sentence: "The login session expired. Please refresh the account's credentials.",
  },
  unclear: {
    emoji: "❓",
    label: "Unclear",
    sentence: "The server responded, but the result could not be clearly determined.",
  },
  scan_failed: {
    emoji: "⚠️",
    label: "Scan Failed",
    sentence: "The scan could not be completed, possibly due to corrupted credentials.",
  },
  network_error: {
    emoji: "🌐",
    label: "Network Error",
    sentence: "A network problem prevented the scan from reaching the server.",
  },
  auth_error: {
    emoji: "🔑",
    label: "Authentication Error",
    sentence: "A server session could not be established for this account.",
  },
};

// Map a raw scanQr() ScanStatus into our richer ReportStatus.
export function fromScanStatus(status: string | null | undefined): ReportStatus {
  switch (status) {
    case "marked":         return "marked";
    case "rejected":       return "rejected";
    case "scanner_page":   return "window_closed";
    case "token_expired":  return "session_expired";
    case "auth_error":     return "auth_error";
    case "network_error":  return "network_error";
    case "unknown_flag":   return "unclear";
    case "unreadable":     return "unclear";
    case "invalid_qr":     return "rejected";
    default:               return "scan_failed";
  }
}

// Build one report line for a student + status.
export function formatStatusLine(studentId: string, status: ReportStatus, time: string): string {
  const m = STATUS_META[status];
  return `${m.emoji} *[${time}]* \`${studentId}\` ➔ *${m.label}*\n     _${m.sentence}_`;
}