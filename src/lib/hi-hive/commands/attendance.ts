import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "../../../commands/_types.js";
import { getAttendance } from "../get-attendance.js";
import type { GetAttendanceResult } from "../types.js";

/*
  !attendance [course_code]

  Fetches the UTAR attendance report via the web portal.
  Mirrors show_attendance() from utar_attendance.py:
    1. Establishes a session with the UTAR token from creds.json
    2. POSTs to the report URL (tries real token then "null")
    3. Strips HTML and returns the plain-text report lines

  Usage:
    !attendance               — full report
    !attendance UECS2194      — filter lines containing this code
*/

function formatAttendance(result: GetAttendanceResult, courseFilter?: string): string {
  if (!result.ok) {
    return (
      `❌ *Attendance Error*\n${result.message}\n\n` +
      `💡 Make sure _utarStudentId_ or _utarEncryptedData_ is set in creds.json.\n` +
      `Set env vars _UTAR_SCAN_URL_ and _UTAR_REPORT_URL_ too.`
    );
  }

  if (result.no_record) {
    return (
      "⚠️ *No attendance data found.*\n" +
      (courseFilter
        ? `No lines matching _${courseFilter}_ in the report.`
        : "The report page returned no content.")
    );
  }

  // result.message carries the raw stripped lines joined by \n
  const lines = result.message.split("\n");
  const header = courseFilter
    ? `📋 *Attendance — ${courseFilter}*`
    : `📋 *Attendance Report*`;

  return [header, "─".repeat(36), ...lines].join("\n");
}

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

const command: Command = {
  name: "attendance",
  aliases: ["att", "a"],
  description: "Fetch your UTAR attendance report from the web portal.",
  usage: "!attendance [course_code]",
  requiresArgs: false,
  handler: handleAttendance,
};

export default command;