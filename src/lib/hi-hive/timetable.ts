/**
 * timetable.ts — src/lib/hi-hive/timetable.ts
 *
 * Builds a student's recurring weekly timetable from their attendance history,
 * and finds "isolated" sessions — slots that belong to this student and to NO
 * other registered student.
 *
 * Why isolated sessions matter: if a QR is for a session only one student
 * attends, nobody else should be scanning it.
 */

import { getAttendance } from "./get-attendance.js";
import { getAllDocs } from "./creds.js";
import { canonicalCode } from "./course-aliases.js";
import type { GetAttendanceResult } from "./types.js";

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Slot {
  courseCode: string;   // canonical
  courseName: string;
  dayOfWeek:  number;   // 0=Sun … 6=Sat
  startMin:   number;   // minutes from midnight
  durationMin: number;
  group:      string;
  type:       string;   // Lecture / Tutorial / Practical
}

/** Stable identity of a recurring session. */
export const slotKey = (s: Slot) =>
  `${s.courseCode}|${s.dayOfWeek}|${s.startMin}|${s.group}|${s.type.toUpperCase()}`;

export const hhmm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** Build the deduped weekly slot list from an attendance report. */
export function buildSlots(att: GetAttendanceResult): Slot[] {
  const out: Slot[] = [];
  const seen = new Set<string>();

  for (const course of att.courses) {
    const code = canonicalCode(course.code);
    if (!code) continue;

    for (const rec of course.records) {
      if (!rec.classDatetime) continue;
      const d = new Date(rec.classDatetime.replace(" ", "T"));
      if (isNaN(d.getTime())) continue;

      const hours = parseFloat((rec.classHours ?? "1").replace(/[^0-9.]/g, ""));
      const slot: Slot = {
        courseCode:  code,
        courseName:  course.name ?? code,
        dayOfWeek:   d.getDay(),
        startMin:    d.getHours() * 60 + d.getMinutes(),
        durationMin: Math.round((isNaN(hours) ? 1 : hours) * 60),
        group:       (rec.group ?? "").trim(),
        type:        (rec.type ?? "").trim() || "Class",
      };

      const k = slotKey(slot);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(slot);
    }
  }

  return out.sort((a, b) =>
    a.dayOfWeek - b.dayOfWeek || a.startMin - b.startMin);
}

/** Fetch + build slots for one account. Returns null if attendance failed. */
export async function slotsForDoc(docId: string): Promise<Slot[] | null> {
  try {
    const att = await getAttendance(docId);
    if (!att || !att.ok) return null;
    return buildSlots(att);
  } catch {
    return null;
  }
}

export interface IsolatedResult {
  targetLabel: string;
  totalSlots:  number;
  comparedWith: number;          // how many other students we compared against
  isolated:    Slot[];
  shared:      number;
}

/**
 * Find sessions unique to `targetDocId` — present in their timetable but in no
 * other registered student's timetable.
 *
 * NOTE: this fetches the attendance report for EVERY registered account, so it
 * costs one HTTP request per student. Fine on demand, not for a hot path.
 */
export async function findIsolatedSessions(
  targetDocId: string,
  targetLabel: string
): Promise<IsolatedResult | { error: string }> {
  const mine = await slotsForDoc(targetDocId);
  if (!mine) return { error: "Could not load this student's attendance." };
  if (mine.length === 0) {
    return { error: "No attendance history yet — a timetable can't be derived." };
  }

  // Every OTHER registered account
  const all = Object.entries(await getAllDocs());
  const others = all.filter(([docId]) => docId !== targetDocId);

  const otherKeys = new Set<string>();
  let compared = 0;

  for (const [docId] of others) {
    const slots = await slotsForDoc(docId);
    if (!slots) continue;            // unreachable/failed account — skip
    compared++;
    for (const s of slots) otherKeys.add(slotKey(s));
  }

  const isolated = mine.filter(s => !otherKeys.has(slotKey(s)));

  return {
    targetLabel,
    totalSlots:   mine.length,
    comparedWith: compared,
    isolated,
    shared:       mine.length - isolated.length,
  };
}

/** Human-readable summary for WhatsApp. */
export function formatIsolated(r: IsolatedResult): string {
  if (r.isolated.length === 0) {
    return (
      `🧍 *Isolated Sessions — \`${r.targetLabel}\`*\n\n` +
      `Every one of this student's ${r.totalSlots} sessions is shared with at ` +
      `least one other registered student.\n` +
      `_Compared against ${r.comparedWith} other student(s)._`
    );
  }

  // Group by day for readability
  const byDay = new Map<number, Slot[]>();
  for (const s of r.isolated) {
    const arr = byDay.get(s.dayOfWeek) ?? [];
    arr.push(s);
    byDay.set(s.dayOfWeek, arr);
  }

  const blocks = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, slots]) => {
      const lines = slots
        .sort((a, b) => a.startMin - b.startMin)
        .map(s =>
          `   • \`${hhmm(s.startMin)}–${hhmm(s.startMin + s.durationMin)}\` ` +
          `*${s.courseCode}* ${s.type}${s.group ? ` G${s.group}` : ""}`);
      return `*${DAY_NAMES[day]}*\n${lines.join("\n")}`;
    });

  return (
    `🧍 *Isolated Sessions — \`${r.targetLabel}\`*\n` +
    `_Sessions no other registered student attends._\n\n` +
    `${blocks.join("\n\n")}\n\n` +
    `📊 ${r.isolated.length} isolated · ${r.shared} shared · ${r.totalSlots} total\n` +
    `_Compared against ${r.comparedWith} other student(s)._`
  );
}