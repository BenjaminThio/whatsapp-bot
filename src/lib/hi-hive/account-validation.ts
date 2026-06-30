import { getAttendance } from "./get-attendance.js";
import type { GetAttendanceResult, AttendanceCourse, AttendanceRecord } from "./types.js";
import { canonicalCode } from "./course-aliases.js";

export interface AccountValidation {
  exists:        boolean;             // identity confirmed?
  reason:        string;              // human-readable explanation
  attendance:    GetAttendanceResult | undefined;  // cached so callers can reuse it
  enrolledCodes: Set<string>;         // course codes from attendance (may be empty in week 1)
}

/**
 * Validate that `userId`'s account is real by matching the attendance profile's
 * studentId against the expected studentId (creds.id).
 *
 * @param userId       - the doc id / jid to fetch attendance for
 * @param expectedId   - creds.id we're verifying against (strict identity match)
 */
export async function validateAccount(
  userId: string,
  expectedId: string
): Promise<AccountValidation> {
  let attendance: GetAttendanceResult | undefined;
  try {
    attendance = await getAttendance(userId);
  } catch (e) {
    return {
      exists: false,
      reason: `Attendance request threw: ${String(e).slice(0, 120)}`,
      attendance: undefined,
      enrolledCodes: new Set(),
    };
  }

  // No result at all => creds missing / undefined
  if (!attendance) {
    return {
      exists: false,
      reason: "No attendance result (creds missing or unreadable).",
      attendance,
      enrolledCodes: new Set(),
    };
  }

  // The report must carry a profile with a Student ID that MATCHES the claimed id.
  const profileId = attendance.profile?.studentId?.trim() ?? "";
  const expected  = expectedId.trim();

  if (!profileId) {
    // Real accounts always render their Student ID. None => almost certainly fake,
    // OR the page didn't render (loading shell). Either way we can't confirm it.
    return {
      exists: false,
      reason: "No Student ID in attendance report - account unverifiable (likely fake or page not rendered).",
      attendance,
      enrolledCodes: enrolledCodesOf(attendance.courses),
    };
  }

  if (profileId !== expected) {
    // The server returned SOMEONE ELSE's profile, or a mismatch - reject.
    return {
      exists: false,
      reason: `Profile Student ID (${profileId}) does not match credentials (${expected}).`,
      attendance,
      enrolledCodes: enrolledCodesOf(attendance.courses),
    };
  }

  // Identity confirmed.
  return {
    exists: true,
    reason: `Verified: profile Student ID ${profileId} matches credentials.`,
    attendance,
    enrolledCodes: enrolledCodesOf(attendance.courses),
  };
}

/**
 * Validate RAW credentials that aren't saved to the DB yet (used by !test add/set
 * to reject fake accounts at the point of entry).
 *
 * Fetches the attendance report using the given id+email directly, and confirms
 * the returned profile's Student ID matches `id`. A fake account can't produce a
 * matching profile, so it's rejected before it ever touches the database.
 */
export async function validateRawCreds(
  id: string,
  email: string
): Promise<{ valid: boolean; reason: string }> {
  let attendance: GetAttendanceResult | undefined;
  try {
    // userId is unused here because we pass creds directly via options.
    attendance = await getAttendance("__validate__", { creds: { id, email } });
  } catch (e) {
    return { valid: false, reason: `Verification request failed: ${String(e).slice(0, 120)}` };
  }

  if (!attendance) {
    return { valid: false, reason: "No response from attendance server." };
  }

  const profileId = attendance.profile?.studentId?.trim() ?? "";
  if (!profileId) {
    return {
      valid: false,
      reason: "Account not found on hi-hive (no profile returned). Check the Student ID and email.",
    };
  }
  if (profileId !== id.trim()) {
    return {
      valid: false,
      reason: `Server profile (${profileId}) doesn't match the Student ID entered (${id}).`,
    };
  }
  return { valid: true, reason: `Verified - account ${profileId} exists on hi-hive.` };
}

/**
 * Check whether a scanned QR's class is ALREADY recorded as attended in the
 * attendance report - so we can skip re-scanning a class we already have, and
 * still allow re-scanning one that was never recorded or previously failed.
 *
 * Matching is tolerant on datetime: the QR carries "2026-06-24 11:00" (no
 * seconds) while records carry "2026-06-24 11:00:00". We compare by
 * course code + same calendar date + same hour:minute.
 *
 * Returns:
 *   recorded  - true if an "Attended" record matches this QR's class
 *   record    - the matching record (for messaging), if any
 */
export function isAlreadyRecorded(
  attendance: GetAttendanceResult,
  scanned: { courseCode: string; classDatetime: string; group?: string }
): { recorded: boolean; record: AttendanceRecord | null } {
  const wantCode = canonicalCode(scanned.courseCode);
  const wantKey  = normaliseDatetimeKey(scanned.classDatetime);
  if (!wantKey) return { recorded: false, record: null };

  for (const course of attendance.courses) {
    // Treat equivalent course codes (e.g. UECS2403 / UECS2103) as the same class
    if (canonicalCode(course.code) !== wantCode) continue;

    for (const rec of course.records) {
      if (!rec.classDatetime) continue;
      const recKey = normaliseDatetimeKey(rec.classDatetime);
      if (recKey !== wantKey) continue;

      // Same class. Is it actually counted as attended?
      //   status "A" = Attended  => already recorded, skip re-scan
      //   status D/N/L or null   => NOT attended => allow (re)scan
      const isAttended =
        rec.status === "A" ||
        rec.statusLabel.toLowerCase() === "attended";

      if (isAttended) return { recorded: true, record: rec };
      // Found the class but not attended (e.g. Absence) - allow rescan
      return { recorded: false, record: rec };
    }
  }
  return { recorded: false, record: null };
}

/** Normalise "YYYY-MM-DD HH:MM[:SS]" => "YYYY-MM-DD HH:MM" for tolerant matching. */
function normaliseDatetimeKey(dt: string): string | null {
  const m = dt.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]} ${m[2]}:${m[3]}`;
}

// Helpers for the smart-schedule feature
// Course codes present in the attendance data (uppercased, deduped).
export function enrolledCodesOf(courses: AttendanceCourse[]): Set<string> {
  const set = new Set<string>();
  for (const c of courses) {
    if (c.code) set.add(canonicalCode(c.code));
  }
  return set;
}

/**
 * A predicted timetable slot derived from historical attendance.
 * We treat (courseCode, dayOfWeek, HH:MM, group) as the identity of a recurring
 * class. If a scanned QR matches one of these, it fits the known schedule.
 */
export interface ScheduleSlot {
  courseCode: string;
  dayOfWeek:  number;   // 0=Sun..6=Sat
  hhmm:       string;   // "11:00"
  group:      string;   // "5"
}

// Build the set of historical schedule slots from attendance records.
export function buildScheduleSlots(attendance: GetAttendanceResult): ScheduleSlot[] {
  const slots: ScheduleSlot[] = [];
  const seen = new Set<string>();

  for (const course of attendance.courses) {
    const code = canonicalCode(course.code);
    if (!code) continue;

    for (const rec of course.records) {
      if (!rec.classDatetime) continue;
      // classDatetime like "2026-06-22 13:00:00"
      const d = new Date(rec.classDatetime.replace(" ", "T"));
      if (isNaN(d.getTime())) continue;

      const dow  = d.getDay();
      const hh   = String(d.getHours()).padStart(2, "0");
      const mm    = String(d.getMinutes()).padStart(2, "0");
      const hhmm = `${hh}:${mm}`;
      const group = (rec.group ?? "").trim();

      const key = `${code}|${dow}|${hhmm}|${group}`;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ courseCode: code, dayOfWeek: dow, hhmm, group });
    }
  }
  return slots;
}

/**
 * Does a scanned QR (its decoded course/day/time/group) match any known slot?
 * Used by the optional smart-skip. `tolerance` lets the time wiggle a bit.
 */
export function matchesSchedule(
  slots: ScheduleSlot[],
  scanned: { courseCode: string; classDatetime: string; group: string }
): boolean {
  if (slots.length === 0) return true;   // no history (week 1) => can't judge, allow

  const d = new Date(scanned.classDatetime.replace(" ", "T"));
  if (isNaN(d.getTime())) return true;   // unparseable => don't block

  const code  = canonicalCode(scanned.courseCode);
  const dow   = d.getDay();
  const hhmm  = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const group = (scanned.group ?? "").trim();

  return slots.some(s =>
    s.courseCode === code &&
    s.dayOfWeek === dow &&
    s.hhmm === hhmm &&
    (s.group === group || s.group === "" || group === "")
  );
}