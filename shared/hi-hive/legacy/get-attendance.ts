/**
 * getAttendance - mirrors the `a` command from scanner.py (show_attendance_for_course).
 *
 * What it does (exactly like scanner.py):
 *   1. Reads sessionId + userId from creds.json
 *   2. Calls the attendance endpoint directly (the one confirmed endpoint)
 *   3. Parses the custom ":*:" / ":**:" / ":***:" delimited response (parse_attendance)
 *   4. Optionally filters to a single course (course_filter)
 *   5. Computes overall attendance %
 *   6. Returns structured data
 */
import { loadCreds, DEFAULT_CREDS_PATH } from "./creds.js";
import type {
  GetAttendanceResult,
  AttendanceCourse,
  AttendanceRecord,
  AttendanceProfile,
} from "./types.js";

const UA = { "User-Agent": "okhttp/4.9.1" };

const STATUS_LABELS: Record<string, string> = {
  A: "Attended",
  N: "Not Counted",
  D: "Absence",
  L: "On Leave",
};

// Public API

/**
 * Fetch and return attendance data.
 *
 * @param attendanceEndpoint - The attendance API endpoint URL (ATTENDANCE_ENDPOINT env var equivalent)
 * @param courseCode         - Optional: filter results to this course code (case-insensitive substring match)
 * @param credsPath          - Path to creds.json (default: "creds.json")
 */
export async function getAttendance(
  courseCode?: string,
): Promise<GetAttendanceResult> {
    const attendanceEndpoint = process.env["ATTENDANCE_ENDPOINT"] ?? "";
    const credsPath = DEFAULT_CREDS_PATH;
    
    if (!attendanceEndpoint) {
        return {
            ok: false,
            no_record: false,
            profile: null,
            courses: [],
            overallPercent: null,
            message: "Attendance endpoint not found!"
        };
    }

    const creds = loadCreds(credsPath);

    if (!creds.sessionId) {
        return {
            ok: false,
            no_record: false,
            profile: null,
            courses: [],
            overallPercent: null,
            message: "No sessionId in creds.json - run refreshToken() first."
        };
    }

    // Build URL exactly like attendance.py fetch_attendance
    const sid   = encodeURIComponent(creds.sessionId);
    const email = encodeURIComponent(creds.userId);
    const url   = `${attendanceEndpoint}?sid=${sid}&type=201&email=${email}`;

    let text: string;
    try {
        const res = await fetch(url, { headers: UA });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        text = await res.text();
    } catch (e) {
        return {
            ok: false,
            no_record: false,
            profile: null,
            courses: [],
            overallPercent: null,
            message: `Attendance fetch failed: ${e}`
        };
    }

    // Parse the raw response (mirrors parse_attendance from attendance.py)
    const parsed = parseAttendance(text);

    if (!parsed.ok || parsed.no_record) {
        return {
        ...parsed,
        overallPercent: null,
        message: parsed.no_record
            ? "No record found. sessionId may be stale - run refreshToken()."
            : "Parse error.",
        };
    }

    // Apply course filter if requested (mirrors course_filter in print_attendance)
    let courses = parsed.courses;
    if (courseCode) {
        courses = courses.filter((c) =>
        (c.name ?? "").toUpperCase().includes(courseCode.toUpperCase())
        );
    }

  const overall = overallPercent(parsed.courses); // always computed on unfiltered list

    return {
        ok: true,
        no_record: false,
        profile: parsed.profile,
        courses,
        overallPercent: overall,
        message: "OK",
    };
}

// Internal parser (mirrors parse_attendance from attendance.py)
function parseAttendance(text: string): Omit<GetAttendanceResult, "overallPercent" | "message"> {
    text = text.trim();
    const top = text.split(":*:");

    if (!top.length || top[0] === "0") {
        return { ok: true, no_record: true, profile: null, courses: [] };
    }

    const courses: AttendanceCourse[] = [];
    let profile: AttendanceProfile | null = null;

    for (const entry of top.slice(1)) {
        if (!entry) continue;

        const cs = entry.split(":**:");
        const pf = (cs[0] ?? "").split(":-:");

        const studentId  = pf[0] ?? null;
        const name       = pf[1] ?? null;
        const courseName = pf[2] ?? null;
        const attendedS  = pf[3] ?? null;
        const totalS     = pf[4] ?? null;
        const session    = pf[5] ?? null;

        if (!profile && (studentId || name)) {
        profile = { studentId, name, session };
        }

        const attended = safeFloat(attendedS);
        const total    = safeFloat(totalS);
        const percent  =
        attended !== null && total
            ? Math.round((attended / total) * 100)
            : attended === 0
            ? 0
            : null;

        const records: AttendanceRecord[] = [];
        if (cs.length > 1) {
            for (const rec of (cs[1] ?? "").split(":***:")) {
                if (!rec || rec === "0") continue;
                const f      = rec.split(":-:");
                const status = f[7] ?? null;
                records.push({
                recordedDatetime: f[0] && f[0] !== "N/A" ? f[0] : null,
                recordedByEmail:  f[1] ?? null,
                classDatetime:    f[2] ?? null,
                type:             f[3] ?? null,
                classHours:       f[4] ?? null,
                group:            f[5] ?? null,
                recordedByName:   f[6] ?? null,
                status,
                statusLabel: STATUS_LABELS[status ?? ""] ?? (status ?? ""),
                });
            }
        }

        courses.push({ code: courseName, name: courseName, attended, total, percent, records });
    }

    return { ok: true, no_record: false, profile, courses };
}

// mirrors overall_percent from attendance.py
function overallPercent(courses: AttendanceCourse[]): number | null {
    const valid = courses.filter((c) => c.attended !== null && c.total);
    if (!valid.length) return null;
    const a = valid.reduce((s, c) => s + (c.attended ?? 0), 0);
    const t = valid.reduce((s, c) => s + (c.total    ?? 0), 0);
    return t ? Math.round((a / t) * 1000) / 10 : null;
}

function safeFloat(s: string | null | undefined): number | null {
    if (s == null || s === "") return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}