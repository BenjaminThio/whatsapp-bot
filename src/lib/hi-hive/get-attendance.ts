import { loadCreds } from "./creds.js";
import { generateEncryptedData } from "./scan-qr.js";
import type {
  GetAttendanceResult,
  AttendanceCourse,
  AttendanceRecord,
  AttendanceProfile,
} from "./types.js";

const UA_BROWSER = {
  "User-Agent":   "Mozilla/5.0 (Linux; Android 16; CPH2637) AppleWebKit/537.36 " +
                  "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Content-Type": "application/x-www-form-urlencoded",
  "Origin":       "https://www.hi-hive.com",
  "Referer":      "https://portal.utar.edu.my/stuIntranet/default.jsp",
};

const STATUS_LABELS: Record<string, string> = {
  A: "Attended",
  N: "Not Counted",
  D: "Absence",
  L: "On Leave",
};

// Public API
export interface GetAttendanceOptions {
  scanUrl?:   string;
  reportUrl?: string;
  courseCode?: string;
  credsPath?: string;
  /**
   * Override: use these raw credentials directly instead of loading from the DB.
   * Lets us validate id+email that haven't been saved yet (e.g. before !test add).
   */
  creds?: { id: string; email: string };
}

export async function getAttendance(
  userId: string,
  options: GetAttendanceOptions = {}
): Promise<GetAttendanceResult | undefined> {
  const scanUrl   = options.scanUrl   ?? process.env["UTAR_SCAN_URL"]   ?? "";
  const reportUrl = options.reportUrl ?? process.env["UTAR_REPORT_URL"] ?? "";

  if (!scanUrl || !reportUrl) {
    return errResult("UTAR_SCAN_URL and UTAR_REPORT_URL must be set.");
  }

  // Resolve token
  // Always generate fresh from id + email + current datetime - never use stored token.
  // Formula: AES-128-CBC( studentId + "FFF" + email + "FFF" + datetime + "FFF" )
  // If options.creds is given, use it directly (validates unsaved credentials);
  // otherwise load from the database by userId.
  const creds = options.creds ?? await loadCreds(userId);

  if (creds === undefined) return undefined;

  if (!creds.id || !creds.email) {
    return errResult(
      "Missing id or email - both are required to generate a token."
    );
  }

  const utarToken = generateEncryptedData(creds.id, creds.email);
  console.log(`[getAttendance] Generated fresh token for ${creds.id} / ${creds.email}`);

  // Establish session
  let cookies = "";
  try {
    const r = await fetch(scanUrl, {
      method:   "POST",
      headers:  UA_BROWSER,
      body:     new URLSearchParams({ encryptedData: utarToken }),
      redirect: "follow",
    });
    cookies = r.headers.get("set-cookie") ?? "";
  } catch (e) {
    return errResult(`Session establishment failed: ${e}`);
  }

  // Fetch report - try real token, then "null"
  const attempts = [
    { encVal: utarToken, label: "real token" },
    { encVal: "null",    label: "null"        },
  ];

  for (const { encVal, label } of attempts) {
    const headers: Record<string, string> = {
      ...UA_BROWSER,
      "Referer": `${scanUrl}?encryptedData=null`,
    };
    if (cookies) headers["Cookie"] = cookies;

    let html: string;
    let httpStatus: number;
    try {
      const r = await fetch(reportUrl, {
        method:   "POST",
        headers,
        body:     new URLSearchParams({ encryptedData: encVal }),
        redirect: "follow",
      });
      httpStatus = r.status;
      html = await r.text();
      console.log(`[getAttendance] attempt=${label} http=${httpStatus} bodyLen=${html.length}`);
      console.log(`[getAttendance] body first 800:\n${html.slice(0, 800)}`);
    } catch (e) {
      console.log(`[getAttendance] attempt=${label} fetch threw: ${e}`);
      continue;
    }

    const joined = html.toLowerCase();
    const hasError = joined.includes("something went wrong") || joined.includes("unexpected error");
    console.log(`[getAttendance] hasError=${hasError}`);
    if (hasError) {
      console.log(`[getAttendance] skipping attempt=${label} - error page detected`);
      continue;
    }

    // Always dump to file and log stripped text so we can see the real structure
    try {
      const fs = await import("fs");
      fs.writeFileSync("/tmp/utar_attendance_debug.html", html, "utf-8");
      console.log(`[getAttendance] HTML written to /tmp/utar_attendance_debug.html`);
    } catch (_) {}
    const stripped = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    console.log(`[getAttendance] stripped (first 2000):\n${stripped.slice(0, 2000)}`);

    return parseHtml(html, options.courseCode);
  }

  return errResult(
    "Both token attempts returned errors. " +
    "Refresh utarEncryptedData in creds.json or open the report URL in a browser."
  );
}

// Parser for the real UTAR attendance HTML structure
function innerText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")   // <br/> → newline
    .replace(/<[^>]+>/g, "")         // strip remaining tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n/g, "\n")          // normalise CRLF => LF
    .replace(/\r/g, "\n")
    .split("\n")
    .map(l => l.trim())              // trim each line individually
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")     // collapse 3+ blank lines to 2
    .trim();
}

/** Pick a named field from a block of key:value lines, e.g. "Status: Attended" */
function field(text: string, key: string): string | null {
  const re = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im");
  return text.match(re)?.[1]?.trim() ?? null;
}

function safeFloat(s: string | null | undefined): number | null {
  if (!s || s.trim() === "" || s.trim() === "-") return null;
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
}

function overallPercent(courses: AttendanceCourse[]): number | null {
  const valid = courses.filter(c => c.attended !== null && c.total);
  if (!valid.length) return null;
  const a = valid.reduce((s, c) => s + (c.attended ?? 0), 0);
  const t = valid.reduce((s, c) => s + (c.total    ?? 0), 0);
  return t ? Math.round((a / t) * 1000) / 10 : null;
}

function extractProfile(html: string): AttendanceProfile | null {
  const text      = innerText(html);
  const idMatch   = text.match(/Student ID\s*:\s*([A-Z0-9]+)/i);
  const nameMatch = text.match(/Name\s*:\s*([^\n]+)/i);
  const sessMatch = text.match(/Session\s*:\s*([0-9]+)/i);
  if (!idMatch && !nameMatch) return null;
  return {
    studentId: idMatch?.[1]?.trim()   ?? null,
    name:      nameMatch?.[1]?.trim() ?? null,
    session:   sessMatch?.[1]?.trim() ?? null,
  };
}

/**
 * Parse the <div class="content"> inner HTML into AttendanceRecord[].
 * Each session starts with "Class Datetime:" - we split on that keyword.
 */
function parseContentBlock(contentHtml: string): AttendanceRecord[] {
  const text = innerText(contentHtml);

  // Split into individual session blocks on "Class Datetime:"
  // Keep the delimiter by using a lookahead split
  const blocks = text
    .split(/(?=^Class Datetime:)/im)
    .map(b => b.trim())
    .filter(b => b.toLowerCase().startsWith("class datetime:"));

  const records: AttendanceRecord[] = [];
  for (const block of blocks) {
    const classDatetime    = field(block, "Class Datetime");
    if (!classDatetime) continue;

    const recordedDatetime = field(block, "Recorded Datetime");
    const recordedBy       = field(block, "Recorded By");
    const type             = field(block, "Type");
    const group            = field(block, "Group");
    const classHours       = field(block, "Class Hours");
    const statusLabel      = field(block, "Status") ?? "";
    const statusCode = Object.entries(STATUS_LABELS)
      .find(([, v]) => v.toLowerCase() === statusLabel.toLowerCase())?.[0] ?? null;

    records.push({
      recordedDatetime,
      recordedByEmail:  null,
      classDatetime,
      type,
      classHours,
      group,
      recordedByName:   recordedBy,
      status:           statusCode,
      statusLabel:      statusLabel || (statusCode ? (STATUS_LABELS[statusCode] ?? statusCode) : ""),
    });
  }
  return records;
}

function parseHtml(html: string, courseFilter?: string): GetAttendanceResult {
  const profile = extractProfile(html);
  const courses: AttendanceCourse[] = [];

  // Match each collapsible button + immediately following content div
  // Button contains multiline <b>...</b>; content div contains the session records
  const sectionRe = /<button[^>]*class="[^"]*collapsible[^"]*"[^>]*>([\s\S]*?)<\/button>\s*<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;

  while ((m = sectionRe.exec(html)) !== null) {
    const btnText     = innerText(m[1]);
    const contentHtml = m[2];

    // Parse button lines:
    //   Course: UECS2033 - SOFTWARE PROJECT MANAGEMENT
    //   Total Class Hours attended: 4.0
    //   Total Class Hours: 4.0
    //   Percent: 100
    const courseRaw  = field(btnText, "Course");
    if (!courseRaw) continue;

    // Split into code + name
    const codeSplit  = courseRaw.match(/^([A-Z0-9]+)\s*-\s*(.+)$/);
    const code       = codeSplit?.[1]?.trim() ?? courseRaw.trim();
    const name       = codeSplit?.[2]?.trim() ?? courseRaw.trim();

    const attended   = safeFloat(field(btnText, "Total Class Hours attended"));
    const total      = safeFloat(field(btnText, "Total Class Hours"));
    const pctRaw     = safeFloat(field(btnText, "Percent"));
    const percent    =
      pctRaw !== null ? pctRaw :
      attended !== null && total ? Math.round((attended / total) * 100) : null;

    const records = parseContentBlock(contentHtml);

    courses.push({ code, name, attended, total, percent, records });
  }

  console.log(`[getAttendance] parseHtml found ${courses.length} courses`);
  courses.forEach(c =>
    console.log(`  → ${c.code} | ${c.name} | ${c.attended}/${c.total}h | ${c.percent}%`)
  );

  // Fallback: no collapsible sections found - return raw stripped text
  if (courses.length === 0) {
    const stripped = innerText(html).replace(/\n{3,}/g, "\n\n").trim().slice(0, 3000);
    console.log(`[getAttendance] no courses parsed. Stripped (500):\n${stripped.slice(0, 500)}`);
    return {
      ok: true, no_record: false, profile, courses: [],
      overallPercent: null,
      message: stripped || "No content returned.",
    };
  }

  // Apply optional course filter
  const filtered = courseFilter
    ? courses.filter(c =>
        (c.code ?? "").toUpperCase().includes(courseFilter.toUpperCase()) ||
        (c.name ?? "").toUpperCase().includes(courseFilter.toUpperCase()))
    : courses;

  return {
    ok:             true,
    no_record:      filtered.length === 0,
    profile,
    courses:        filtered,
    overallPercent: overallPercent(courses),
    message:        "OK",
  };
}

// Helpers
function errResult(message: string): GetAttendanceResult {
  return {
    ok:             false,
    no_record:      false,
    profile:        null,
    courses:        [],
    overallPercent: null,
    message,
  };
}