/**
 * visualise.ts — src/lib/hi-hive/visualise.ts
 *
 * Renders a weekly timetable as a PNG. We build an SVG string and let sharp
 * (libvips, native C) rasterise it — fast, no browser/canvas dependency.
 *
 *   bun add sharp
 */

import sharp from "sharp";
import { DAY_NAMES, hhmm, type Slot } from "./timetable.js";

// Palette cycled per course so each subject gets a consistent colour.
const PALETTE = [
  "#2a78d6", "#1baf7a", "#eda100", "#e34948",
  "#7b4fc9", "#eb6834", "#0f9bb0", "#b03070",
];

const PAD_L = 66;    // left gutter for time labels
const PAD_T = 62;    // top area for title + day headers
const COL_W = 150;
const ROW_H = 58;    // pixels per hour
const PAD_R = 16;
const PAD_B = 34;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Build the SVG for a set of slots.
 * Days shown are only those that actually contain classes.
 */
function buildSvg(slots: Slot[], title: string, subtitle: string): string {
  if (slots.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="140">
      <rect width="520" height="140" fill="#ffffff"/>
      <text x="24" y="60" font-family="sans-serif" font-size="20" fill="#0E0941">${esc(title)}</text>
      <text x="24" y="92" font-family="sans-serif" font-size="14" fill="#666">No sessions to display.</text>
    </svg>`;
  }

  const days = [...new Set(slots.map(s => s.dayOfWeek))].sort((a, b) => a - b);
  const startMin = Math.min(...slots.map(s => s.startMin));
  const endMin   = Math.max(...slots.map(s => s.startMin + s.durationMin));
  const hourFrom = Math.floor(startMin / 60);
  const hourTo   = Math.ceil(endMin / 60);
  const hours    = hourTo - hourFrom;

  const W = PAD_L + days.length * COL_W + PAD_R;
  const H = PAD_T + hours * ROW_H + PAD_B;

  // Consistent colour per course code
  const codes = [...new Set(slots.map(s => s.courseCode))].sort();
  const colourOf = (code: string) => PALETTE[codes.indexOf(code) % PALETTE.length];

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Title
  parts.push(`<text x="${PAD_L}" y="26" font-family="sans-serif" font-size="19" font-weight="700" fill="#0E0941">${esc(title)}</text>`);
  parts.push(`<text x="${PAD_L}" y="44" font-family="sans-serif" font-size="12" fill="#777">${esc(subtitle)}</text>`);

  // Hour rows + time labels
  for (let i = 0; i <= hours; i++) {
    const y = PAD_T + i * ROW_H;
    parts.push(`<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#e6e6e6" stroke-width="1"/>`);
    if (i < hours) {
      parts.push(`<text x="${PAD_L - 10}" y="${y + 16}" text-anchor="end" font-family="sans-serif" font-size="11" fill="#999">${hhmm((hourFrom + i) * 60)}</text>`);
    }
  }

  // Day headers + column separators
  days.forEach((day, idx) => {
    const x = PAD_L + idx * COL_W;
    parts.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + hours * ROW_H}" stroke="#e6e6e6" stroke-width="1"/>`);
    parts.push(`<text x="${x + COL_W / 2}" y="${PAD_T - 12}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="600" fill="#0E0941">${DAY_NAMES[day]}</text>`);
  });
  parts.push(`<line x1="${W - PAD_R}" y1="${PAD_T}" x2="${W - PAD_R}" y2="${PAD_T + hours * ROW_H}" stroke="#e6e6e6" stroke-width="1"/>`);

  // Session blocks
  for (const s of slots) {
    const col = days.indexOf(s.dayOfWeek);
    if (col < 0) continue;
    const x = PAD_L + col * COL_W + 4;
    const y = PAD_T + ((s.startMin - hourFrom * 60) / 60) * ROW_H + 2;
    const h = Math.max(26, (s.durationMin / 60) * ROW_H - 4);
    const w = COL_W - 8;
    const fill = colourOf(s.courseCode);

    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" opacity="0.92"/>`);
    parts.push(`<text x="${x + 9}" y="${y + 19}" font-family="sans-serif" font-size="12.5" font-weight="700" fill="#ffffff">${esc(s.courseCode)}</text>`);
    if (h >= 40) {
      const meta = `${s.type}${s.group ? ` · G${s.group}` : ""}`;
      parts.push(`<text x="${x + 9}" y="${y + 35}" font-family="sans-serif" font-size="10.5" fill="#f2f2f2">${esc(meta)}</text>`);
    }
    if (h >= 56) {
      parts.push(`<text x="${x + 9}" y="${y + 50}" font-family="sans-serif" font-size="10" fill="#e8e8e8">${hhmm(s.startMin)}–${hhmm(s.startMin + s.durationMin)}</text>`);
    }
  }

  // Legend
  const legendY = PAD_T + hours * ROW_H + 20;
  codes.forEach((code, i) => {
    const lx = PAD_L + i * 118;
    if (lx + 110 > W) return;   // don't overflow
    parts.push(`<rect x="${lx}" y="${legendY - 9}" width="10" height="10" rx="2" fill="${colourOf(code)}"/>`);
    parts.push(`<text x="${lx + 15}" y="${legendY}" font-family="sans-serif" font-size="10.5" fill="#555">${esc(code)}</text>`);
  });

  parts.push(`</svg>`);
  return parts.join("");
}

/** Render slots to a PNG buffer via sharp (native libvips). */
export async function renderTimetablePng(
  slots: Slot[],
  title: string,
  subtitle = ""
): Promise<Buffer> {
  const svg = buildSvg(slots, title, subtitle);
  return await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
}