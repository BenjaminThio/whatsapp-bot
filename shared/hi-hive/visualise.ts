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

/**
 * Pick the largest font size (down to `minSize`) at which `text` fits inside
 * `maxPx`. Used instead of truncating labels — a block always shows its full
 * text, just smaller when the box is narrow, rather than "UECS2…".
 *
 * `charFactor` is an average glyph-width-to-font-size ratio for this
 * sans-serif font (empirically ~0.55–0.63 depending on the character mix).
 */
function fitFontSize(
  text: string,
  maxPx: number,
  maxSize: number,
  minSize: number,
  charFactor: number
): number {
  if (!text) return maxSize;
  let size = maxSize;
  while (size > minSize && text.length * size * charFactor > maxPx) {
    size -= 0.5;
  }
  return Math.max(size, minSize);
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

  // Smallest legible size we'll ever draw the course code at. Used to work
  // out how wide a block needs to be so the code never has to be truncated.
  const CODE_MAX_SIZE = 11.5;
  const CODE_MIN_SIZE = 7.5;
  const CODE_CHAR_FACTOR = 0.62;

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

    // Width follows the slot's duration as before, but is never allowed to
    // drop below whatever the course code needs at its smallest legible
    // size — that's what used to force "UECS2033" down to "UECS2…".
    const durationW = (s.durationMin / 60) * COL_W - 4;
    const codeMinW  = s.courseCode.length * CODE_MIN_SIZE * CODE_CHAR_FACTOR + 14;
    const w = Math.max(26, codeMinW, durationW);
    const h = ROW_H - 8;
    const fill = colourOf(s.courseCode);
    const inner = w - 14;   // usable text width after padding

    p.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${fill}" opacity="0.93"/>`);

    // Course code: always shown in full. Font shrinks to fit the box
    // instead of the text being cut off with an ellipsis.
    const codeSize = fitFontSize(s.courseCode, inner, CODE_MAX_SIZE, CODE_MIN_SIZE, CODE_CHAR_FACTOR);
    p.push(`<text x="${x + 7}" y="${y + 18}" font-family="sans-serif" font-size="${codeSize.toFixed(1)}" font-weight="600" fill="#ffffff">${esc(s.courseCode)}</text>`);

    // Type/group line — only drawn if there's reasonable room for it,
    // shrinking the same way rather than being clipped.
    if (inner >= 34) {
      const meta = `${s.type}${s.group ? ` · G${s.group}` : ""}`;
      const metaSize = fitFontSize(meta, inner, 10, 7, 0.56);
      p.push(`<text x="${x + 7}" y="${y + 34}" font-family="sans-serif" font-size="${metaSize.toFixed(1)}" fill="#f2f2f2">${esc(meta)}</text>`);
    }

    // Time range — only drawn once there's room below the meta line.
    if (inner >= 46) {
      const time = `${hhmm(s.startMin)}–${hhmm(s.startMin + s.durationMin)}`;
      const timeSize = fitFontSize(time, inner, 9.5, 6.5, 0.55);
      p.push(`<text x="${x + 7}" y="${y + 49}" font-family="sans-serif" font-size="${timeSize.toFixed(1)}" fill="#e8e8e8">${esc(time)}</text>`);
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

/**
 * Render slots to an image via sharp (native libvips).
 *
 * JPEG, not PNG, and for the same reason the chess renderer switched: both bots
 * send this as a photo, and both platforms re-encode photos to JPEG on receipt.
 * Producing a lossless PNG spent the extra time on pixels nobody ever sees.
 *
 * compressionLevel 9 was also the worst possible choice for this image - a
 * timetable is large flat blocks of colour, which is exactly where zlib's match
 * search does the most work for the least gain.
 *
 * Pass { format: "png" } when the exact pixels matter (sending as a document).
 */
export async function renderTimetablePng(
  slots: Slot[],
  title: string,
  subtitle = "",
  opts: { format?: "png" | "jpeg"; quality?: number } = {}
): Promise<Buffer> {
  const svg = buildSvg(slots, title, subtitle);
  const image = sharp(Buffer.from(svg));

  if (opts.format === "png") {
    // Level 6 is libvips' default and roughly half the time of 9 for ~2% size
    return await image.png({ compressionLevel: 6 }).toBuffer();
  }

  return await image
    .flatten({ background: "#ffffff" })   // JPEG has no alpha; avoid black fringing
    .jpeg({ quality: opts.quality ?? 92, mozjpeg: true })
    .toBuffer();
}