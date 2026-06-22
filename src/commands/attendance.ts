import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { getAttendance } from "../lib/hi-hive/get-attendance.js";
import type { GetAttendanceResult, AttendanceCourse } from "../lib/hi-hive/types.js";

/*
  !attendance [course_code]

  Fetches attendance data from the API using the sessionId in creds.json.
  Mirrors exactly what scanner.py's `a` command does via show_attendance_for_course.

  Usage:
    !attendance               — full table, all courses + overall %
    !attendance UECS2194      — filter to one course (case-insensitive substring)
*/

const PCT_BAR_LEN = 10; // character width of the visual bar

function pctBar(pct: number | null): string {
  if (pct === null) return "▒".repeat(PCT_BAR_LEN) + " —";
  const filled = Math.round((pct / 100) * PCT_BAR_LEN);
  const bar = "█".repeat(filled) + "░".repeat(PCT_BAR_LEN - filled);
  const icon = pct >= 80 ? "✅" : pct >= 60 ? "⚠️" : "❌";
  return `${bar} ${pct}% ${icon}`;
}

function formatAttendance(result: GetAttendanceResult, courseFilter?: string): string {
  // ── Error states ──────────────────────────────────────────────────────────
  if (!result.ok) {
    return `❌ *Attendance Error*\n${result.message}`;
  }

  if (result.no_record) {
    return (
      "⚠️ *No attendance record found.*\n" +
      "Your sessionId may be stale — try _!refresh_ to get a new one."
    );
  }

  const lines: string[] = [];

  // ── Profile header ────────────────────────────────────────────────────────
  const prof = result.profile;
  if (prof) {
    lines.push(`👤 *${prof.name ?? "?"}* (${prof.studentId ?? "?"})`);
    if (prof.session) lines.push(`📅 Session: ${prof.session}`);
  }
  lines.push("─".repeat(36));

  // ── Course rows ───────────────────────────────────────────────────────────
  const courses = result.courses;

  if (courses.length === 0) {
    lines.push(courseFilter
      ? `No course matching _${courseFilter}_ found.`
      : "No course data available.");
    return lines.join("\n");
  }

  for (const c of courses) {
    const att = c.attended === null ? "—" : c.attended.toFixed(1);
    const tot = c.total    === null ? "—" : c.total.toFixed(1);
    lines.push(`\n📚 *${c.name ?? "?"}*`);
    lines.push(`   ${pctBar(c.percent)}  (${att}/${tot}h)`);

    // Show individual session records
    if (c.records.length > 0) {
      for (const rec of c.records) {
        const who = rec.recordedByName ?? rec.recordedByEmail ?? "?";
        const when = rec.classDatetime ?? "?";
        const statusIcon = statusEmoji(rec.status);
        lines.push(`   ${statusIcon} ${when}  _by ${who}_`);
      }
    }
  }

  // ── Overall ───────────────────────────────────────────────────────────────
  if (!courseFilter && result.overallPercent !== null) {
    lines.push("\n" + "─".repeat(36));
    lines.push(`📊 *Overall: ${result.overallPercent}%*`);
  }

  return lines.join("\n");
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

async function handleAttendance(sock: any, msg: WAMessage, text: string) {
  if (!msg.key.remoteJid) return;

  // Optional course filter after "!attendance"
  const courseFilter = text.slice("!attendance".length).trim() || undefined;

  await sock.sendMessage(msg.key.remoteJid, {
    react: { text: "⏳", key: msg.key }
  });

  try {
    const result = await getAttendance(courseFilter);
    const reply = formatAttendance(result, courseFilter);

    await sock.sendMessage(msg.key.remoteJid, { text: reply }, { quoted: msg });

    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: result.ok && !result.no_record ? "✅" : "❌", key: msg.key }
    });

  } catch (err: any) {
    console.error("!attendance error:", err);
    await sock.sendMessage(msg.key.remoteJid, {
      text: `❌ Unexpected error: ${err?.message ?? err}`
    }, { quoted: msg });
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: "❌", key: msg.key }
    });
  }
}

const command: Command = {
  name: "attendance",
  aliases: ["att", "a"],
  description: "Fetch your attendance record. Optionally filter by course code.",
  usage: "!attendance [course_code]",
  requiresArgs: false,
  handler: handleAttendance,
};

export default command;