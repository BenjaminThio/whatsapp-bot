import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { getAttendance } from "../lib/hi-hive/get-attendance.js";
import type { GetAttendanceResult, AttendanceCourse } from "../lib/hi-hive/types.js";

/*
  !attendance [course_code]

  Fetches UTAR attendance via the web portal, parses the HTML report into
  structured data, and formats it exactly like the old hi-hive formatter:
    - Student profile header
    - Per-course progress bar with attended/total hours
    - Per-session records with status emoji
    - Overall % at the bottom

  Usage:
    !attendance               — full report, all courses
    !attendance UECS2194      — filter to one course (case-insensitive substring)
*/

// ─── Formatter (restored from old hi-hive formatter) ─────────────────────────

const PCT_BAR_LEN = 10;

function pctBar(pct: number | null): string {
  if (pct === null) return "▒".repeat(PCT_BAR_LEN) + " —";
  const filled = Math.round((pct / 100) * PCT_BAR_LEN);
  const bar = "█".repeat(filled) + "░".repeat(PCT_BAR_LEN - filled);
  const icon = pct >= 80 ? "✅" : pct >= 60 ? "⚠️" : "❌";
  return `${bar} ${pct}% ${icon}`;
}

function statusEmoji(status: string | null): string {
  switch (status) {
    case "A": return "✅";
    case "D": return "❌";
    case "L": return "🏖️";
    case "N": return "➖";
    default:  return "❓";
  }
}

function formatCourse(c: AttendanceCourse): string {
  const lines: string[] = [];
  const att = c.attended === null ? "—" : c.attended.toFixed(1);
  const tot = c.total    === null ? "—" : c.total.toFixed(1);

  lines.push(`\n📚 *${c.name ?? c.code ?? "?"}*`);
  lines.push(`   ${pctBar(c.percent)}  (${att}/${tot}h)`);

  for (const rec of c.records) {
    const who  = rec.recordedByName ?? rec.recordedByEmail ?? "?";
    const when = rec.classDatetime  ?? "?";
    lines.push(`   ${statusEmoji(rec.status)} ${when}  _by ${who}_`);
  }

  return lines.join("\n");
}

function formatAttendance(result: GetAttendanceResult, courseFilter?: string): string {
  // ── Error states ──────────────────────────────────────────────────────────
  if (!result.ok) {
    return (
      `❌ *Attendance Error*\n${result.message}\n\n` +
      `💡 Make sure _utarStudentId_ or _utarEncryptedData_ is in creds.json,\n` +
      `and _UTAR_SCAN_URL_ / _UTAR_REPORT_URL_ env vars are set.`
    );
  }

  if (result.no_record) {
    return (
      "⚠️ *No attendance record found.*\n" +
      (courseFilter
        ? `No courses matching _${courseFilter}_.`
        : "The report page returned no course data.")
    );
  }

  // courses[] is empty but message has raw text — parser couldn't read the
  // HTML table structure. Show the raw text so you can diagnose + send it to
  // the dev to fix the parser. Set DEBUG_ATTENDANCE=1 to also dump the HTML.
  if (result.courses.length === 0 && result.message !== "OK") {
    return (
      `📋 *Attendance (raw — table parse failed)*\n` +
      `_Set DEBUG_ATTENDANCE=1 and check /tmp/utar_attendance_debug.html_\n\n` +
      `${"─".repeat(36)}\n` +
      result.message
    );
  }

  const lines: string[] = [];

  // ── Profile header ────────────────────────────────────────────────────────
  const prof = result.profile;
  if (prof?.name || prof?.studentId) {
    lines.push(`👤 *${prof.name ?? "?"}* (${prof.studentId ?? "?"})`);
    if (prof.session) lines.push(`📅 Session: ${prof.session}`);
  }
  lines.push("─".repeat(36));

  // ── Course rows ───────────────────────────────────────────────────────────
  if (result.courses.length === 0) {
    lines.push(courseFilter
      ? `No course matching _${courseFilter}_ found.`
      : "No course data available.");
    return lines.join("\n");
  }

  for (const c of result.courses) {
    lines.push(formatCourse(c));
  }

  // ── Overall ───────────────────────────────────────────────────────────────
  if (!courseFilter && result.overallPercent !== null) {
    lines.push("\n" + "─".repeat(36));
    lines.push(`📊 *Overall: ${result.overallPercent}%*`);
  }

  return lines.join("\n");
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleAttendance(sock: any, msg: WAMessage, text: string) {
  if (!msg.key.remoteJid) return;
  const jid = msg.key.remoteJid;

  const courseFilter = text.slice("!attendance".length).trim() || undefined;

  await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } });

  try {
    const result = await getAttendance({ courseCode: courseFilter });
    const reply  = formatAttendance(result, courseFilter);

    await sock.sendMessage(jid, { text: reply }, { quoted: msg });
    await sock.sendMessage(jid, {
      react: { text: result.ok && !result.no_record ? "✅" : "❌", key: msg.key },
    });
  } catch (err: any) {
    console.error("!attendance error:", err);
    await sock.sendMessage(jid, {
      text: `❌ Unexpected error: ${err?.message ?? err}`,
    }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } });
  }
}

// ─── Command definition ───────────────────────────────────────────────────────

const command: Command = {
  name: "attendance",
  aliases: ["att", "a"],
  description: "Fetch your UTAR attendance report with course breakdown and progress bars",
  usage: "!attendance [course_code]",
  requiresArgs: false,
  handler: handleAttendance,
};

export default command;