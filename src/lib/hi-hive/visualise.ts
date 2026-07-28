/**
 * visualise.ts — src/lib/hi-hive/visualise.ts
 *
 * Renders a weekly timetable as a PNG.
 *
 * Layout: DAYS are rows (y axis), TIME runs across columns (x axis) — the same
 * orientation as a printed university timetable. Built as an SVG string and
 * rasterised by sharp (libvips, native C).
 *
 *   bun add sharp
 */

import sharp from "sharp";
import { DAY_NAMES, hhmm, type Slot } from "./timetable.js";

const PALETTE = [
  "#2a78d6", "#1baf7a", "#eda100", "#e34948",
  "#7b4fc9", "#eb6834", "#0f9bb0", "#b03070",
];

// ── Geometry ─────────────────────────────────────────────────────────────────
const PAD_L   = 76;   // gutter for day names
const TITLE_Y = 30;   // title baseline
const SUB_Y   = 50;   // subtitle baseline
const HOUR_Y  = 80;   // hour label baseline — well clear of the subtitle
const PAD_T   = 94;   // grid top edge
const ROW_H   = 74;   // one day
const COL_W   = 64;   // one hour
const PAD_R   = 20;
const LEGEND_GAP = 30;
const PAD_B   = 52;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Trim a label to fit `maxPx`, adding an ellipsis when cut. */
function fit(text: string, maxPx: number, charPx: number): string {
  const max = Math.floor(maxPx / charPx);
  if (max <= 0) return "";
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + "…";
}

function buildSvg(slots: Slot[], title: string, subtitle: string): string {
  if (slots.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="140">
      <rect width="560" height="140" fill="#ffffff"/>
      <text x="24" y="58" font-family="sans-serif" font-size="20" font-weight="600" fill="#0E0941">${esc(title)}</text>
      <text x="24" y="88" font-family="sans-serif" font-size="13" fill="#666">No sessions to display.</text>
    </svg>`;
  }

  const days     = [...new Set(slots.map(s => s.dayOfWeek))].sort((a, b) => a - b);
  const startMin = Math.min(...slots.map(s => s.startMin));
  const endMin   = Math.max(...slots.map(s => s.startMin + s.durationMin));
  const hourFrom = Math.floor(startMin / 60);
  const hourTo   = Math.ceil(endMin / 60);
  const hours    = Math.max(1, hourTo - hourFrom);

  const gridW = hours * COL_W;
  const gridH = days.length * ROW_H;
  const W = PAD_L + gridW + PAD_R;
  const H = PAD_T + gridH + LEGEND_GAP + PAD_B;

  const codes = [...new Set(slots.map(s => s.courseCode))].sort();
  const colourOf = (c: string) => PALETTE[codes.indexOf(c) % PALETTE.length];

  const p: string[] = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  p.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Title block — sits above the hour labels, never beside them
  p.push(`<text x="20" y="${TITLE_Y}" font-family="sans-serif" font-size="19" font-weight="600" fill="#0E0941">${esc(title)}</text>`);
  if (subtitle) {
    p.push(`<text x="20" y="${SUB_Y}" font-family="sans-serif" font-size="12" fill="#777">${esc(subtitle)}</text>`);
  }

  // Hour columns: label above, vertical rule below
  for (let i = 0; i <= hours; i++) {
    const x = PAD_L + i * COL_W;
    p.push(`<line x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + gridH}" stroke="#e6e6e6" stroke-width="1"/>`);
    if (i < hours) {
      p.push(`<text x="${x + COL_W / 2}" y="${HOUR_Y}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#999">${hhmm((hourFrom + i) * 60)}</text>`);
    }
  }

  // Day rows: label at left, horizontal rule
  days.forEach((day, r) => {
    const y = PAD_T + r * ROW_H;
    p.push(`<line x1="${PAD_L}" y1="${y}" x2="${PAD_L + gridW}" y2="${y}" stroke="#e6e6e6" stroke-width="1"/>`);
    p.push(`<text x="${PAD_L - 14}" y="${y + ROW_H / 2 + 5}" text-anchor="end" font-family="sans-serif" font-size="14" font-weight="600" fill="#0E0941">${DAY_NAMES[day]}</text>`);
  });
  p.push(`<line x1="${PAD_L}" y1="${PAD_T + gridH}" x2="${PAD_L + gridW}" y2="${PAD_T + gridH}" stroke="#e6e6e6" stroke-width="1"/>`);

  // Session blocks — width follows duration along the x axis
  for (const s of slots) {
    const r = days.indexOf(s.dayOfWeek);
    if (r < 0) continue;

    const x = PAD_L + ((s.startMin - hourFrom * 60) / 60) * COL_W + 2;
    const y = PAD_T + r * ROW_H + 4;
    const w = Math.max(26, (s.durationMin / 60) * COL_W - 4);
    const h = ROW_H - 8;
    const fill = colourOf(s.courseCode);
    const inner = w - 14;   // usable text width after padding

    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" opacity="0.93"/>`);

    // Only draw what actually fits — prevents the overlapping text
    p.push(`<text x="${x + 7}" y="${y + 18}" font-family="sans-serif" font-size="11.5" font-weight="600" fill="#ffffff">${esc(fit(s.courseCode, inner, 7.2))}</text>`);

    if (inner >= 64) {
      const meta = `${s.type}${s.group ? ` · G${s.group}` : ""}`;
      p.push(`<text x="${x + 7}" y="${y + 34}" font-family="sans-serif" font-size="10" fill="#f2f2f2">${esc(fit(meta, inner, 5.6))}</text>`);
    }
    if (inner >= 78) {
      const time = `${hhmm(s.startMin)}–${hhmm(s.startMin + s.durationMin)}`;
      p.push(`<text x="${x + 7}" y="${y + 49}" font-family="sans-serif" font-size="9.5" fill="#e8e8e8">${esc(time)}</text>`);
    }
  }

  // Legend — wraps across rows so entries never run off the edge
  const legendTop = PAD_T + gridH + LEGEND_GAP;
  const itemW = 104;
  const perRow = Math.max(1, Math.floor((W - 40) / itemW));
  codes.forEach((code, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const lx = 20 + col * itemW;
    const ly = legendTop + row * 20;
    p.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${colourOf(code)}"/>`);
    p.push(`<text x="${lx + 16}" y="${ly}" font-family="sans-serif" font-size="10.5" fill="#555">${esc(code)}</text>`);
  });

  p.push(`</svg>`);
  return p.join("");
}

/** Render slots to a PNG buffer via sharp (native libvips). */
export async function renderTimetablePng(
  slots: Slot[],
  title: string,
  subtitle = ""
): Promise<Buffer> {
  const svg = buildSvg(slots, title, subtitle);
  return await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}