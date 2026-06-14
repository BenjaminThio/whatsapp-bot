import { WAMessage } from "@whiskeysockets/baileys";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Command } from "./_types.js";

// ─── Data shape (updated for the new JSONL format with designs) ───
interface Timeline {
    date: string;
    image_url: string;
    version: string;
}
interface Design {
    title: string;
    description: string;
    timelines: Timeline[];
}
interface EmojiEntry {
    character: string;
    name: string;
    description: string[];
    code: string;
    render_quality: number;
    version: number;
    category: { main: string | null; sub: string | null };
    alias?: string[];
    variant?: boolean;
    alert?: string;
    designs?: Design[];          // NEW: per-platform design history
}

// ─── Lazy-loaded indexes ───
let entries: EmojiEntry[] | null = null;
let byChar: Map<string, EmojiEntry> | null = null;
let byCode: Map<string, EmojiEntry> | null = null;
let byNameLower: Map<string, EmojiEntry> | null = null;

// NOTE: file is now JSONL (.jsonl), one JSON object per line.
const DATA_PATH = path.join(import.meta.dir, "../../data/emoji.jsonl");

// Which design platform to prefer for the image. Microsoft Teams first (as
// requested), then sensible fallbacks for emojis that lack a Teams design.
const PREFERRED_DESIGNS = [
    "Microsoft Teams",
    "WhatsApp",
    "Apple",
    "Google Noto Color Emoji",
    "Twitter",
];

function loadIndexes(): void {
    if (entries) return;

    if (!existsSync(DATA_PATH)) {
        throw new Error(`Emoji data file not found at ${DATA_PATH}`);
    }

    console.log("📖 Loading emojipedia data (JSONL)...");
    const raw = readFileSync(DATA_PATH, "utf-8");

    entries = [];
    byChar = new Map();
    byCode = new Map();
    byNameLower = new Map();

    let lineNo = 0;
    let skipped = 0;
    for (const line of raw.split("\n")) {
        lineNo++;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let e: EmojiEntry;
        try {
            e = JSON.parse(trimmed) as EmojiEntry;
        } catch {
            skipped++;
            continue;   // tolerate a bad line rather than crashing the whole load
        }
        entries.push(e);
        if (e.character) byChar.set(e.character, e);
        if (e.code) byCode.set(e.code.toLowerCase(), e);
        if (e.alias) for (const a of e.alias) byCode.set(a.toLowerCase(), e);
        if (e.name) byNameLower.set(e.name.toLowerCase(), e);
    }

    console.log(`📖 Indexed ${entries.length} emoji entries${skipped ? ` (${skipped} malformed lines skipped)` : ""}.`);
}

// ─── Lookup (unchanged logic) ───
function findEntry(query: string): { entry: EmojiEntry; method: string } | { suggestions: EmojiEntry[] } | null {
    if (!entries || !byChar || !byCode || !byNameLower) return null;

    const q = query.trim();
    if (!q) return null;

    if (byChar.has(q)) return { entry: byChar.get(q)!, method: "character" };

    const qLower = q.toLowerCase();
    const codeForm = qLower.startsWith(":") && qLower.endsWith(":") ? qLower : `:${qLower}:`;
    if (byCode.has(codeForm)) return { entry: byCode.get(codeForm)!, method: "shortcode" };
    if (byCode.has(qLower)) return { entry: byCode.get(qLower)!, method: "shortcode" };

    if (byNameLower.has(qLower)) return { entry: byNameLower.get(qLower)!, method: "name" };

    const qTokens = qLower.split(/\s+/).filter(Boolean);
    const scored: Array<{ entry: EmojiEntry; score: number }> = [];

    for (const e of entries) {
        const nameLower = e.name.toLowerCase();
        let score = 0;
        if (nameLower.includes(qLower)) {
            score += 100;
            if (nameLower.startsWith(qLower)) score += 50;
        }
        for (const t of qTokens) {
            if (t.length >= 2 && nameLower.includes(t)) score += 10;
        }
        if (e.code.toLowerCase().includes(qLower)) score += 30;
        if (e.alias) for (const a of e.alias) if (a.toLowerCase().includes(qLower)) score += 20;
        if (score > 0) scored.push({ entry: e, score });
    }

    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);

    const top = scored[0];
    const runnerUp = scored[1];
    if (top.score >= 100 && (!runnerUp || top.score >= runnerUp.score * 2)) {
        return { entry: top.entry, method: "fuzzy" };
    }
    return { suggestions: scored.slice(0, 6).map(s => s.entry) };
}

// ─── Design / image selection ───
interface PickedImage {
    url: string;
    platformTitle: string;
    version: string;
    date: string;
}

/**
 * Pick the best image for an emoji. Walks PREFERRED_DESIGNS in order; for the
 * first design whose title matches, returns its newest timeline image (the last
 * entry, which is chronologically latest). Returns null if no design/image.
 */
function pickImage(entry: EmojiEntry): PickedImage | null {
    if (!entry.designs || entry.designs.length === 0) return null;

    for (const pref of PREFERRED_DESIGNS) {
        const design = entry.designs.find(d => d.title.includes(pref));
        if (design && design.timelines.length > 0) {
            // Last timeline = newest design version
            const latest = design.timelines[design.timelines.length - 1];
            if (latest.image_url) {
                return {
                    url: latest.image_url,
                    platformTitle: design.title,
                    version: latest.version,
                    date: latest.date,
                };
            }
        }
    }

    // Nothing in the preferred list matched — fall back to the very first design
    const first = entry.designs[0];
    if (first && first.timelines.length > 0) {
        const latest = first.timelines[first.timelines.length - 1];
        if (latest.image_url) {
            return { url: latest.image_url, platformTitle: first.title, version: latest.version, date: latest.date };
        }
    }
    return null;
}

/** Download an image URL into a Buffer, or null on failure. */
async function fetchImage(url: string): Promise<Buffer | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36" },
        });
        clearTimeout(timer);
        if (!res.ok) return null;
        const ct = res.headers.get("content-type") || "";
        if (!ct.startsWith("image/")) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 16 * 1024 * 1024) return null;
        return buf;
    } catch {
        return null;
    }
}

// ─── Formatting ───
const MAX_CAPTION = 1024;   // WhatsApp image caption limit

function formatEntry(entry: EmojiEntry, method: string, picked: PickedImage | null): string {
    const lines: string[] = [];
    lines.push(`📖 *${entry.name}*  ${entry.character}`);
    lines.push("");

    if (entry.category.main || entry.category.sub) {
        const parts = [entry.category.main, entry.category.sub].filter(Boolean);
        lines.push(`📂 ${parts.join(" › ")}`);
    }

    lines.push(`🔖 Shortcode: \`${entry.code}\``);
    if (entry.alias && entry.alias.length > 0) {
        lines.push(`🪶 Aliases: ${entry.alias.map(a => `\`${a}\``).join(", ")}`);
    }
    lines.push(`📦 Emoji ${entry.version}`);

    // Note which platform's artwork is shown
    if (picked) {
        lines.push(`🎨 _Showing:_ ${picked.platformTitle}`);
    }

    if (entry.alert) {
        lines.push("");
        lines.push(`⚠️ ${entry.alert}`);
    }

    if (entry.description.length > 0) {
        lines.push("");
        lines.push("📝 _Description_");
        lines.push(entry.description[0]);
    }

    if (method === "fuzzy") {
        lines.push("");
        lines.push("_(closest fuzzy match)_");
    }

    let out = lines.join("\n");
    if (out.length > MAX_CAPTION) {
        out = out.slice(0, MAX_CAPTION - 20) + "\n\n... _(more)_";
    }
    return out;
}

function formatSuggestions(suggestions: EmojiEntry[]): string {
    const lines = ["🤔 *Did you mean one of these?*\n"];
    for (const e of suggestions) {
        lines.push(`${e.character}  *${e.name}*  - \`${e.code}\``);
    }
    lines.push("\n_Try again with the exact name, shortcode, or emoji._");
    return lines.join("\n");
}

// ─── Handler ───
async function handleEmojipedia(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    const args = text.slice("!emojipedia ".length).trim();
    if (!args) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage:\n• `!emojipedia 🥇` - by emoji character\n• `!emojipedia 1st place medal` - by name\n• `!emojipedia :pizza:` - by shortcode"
        }, { quoted: msg });
        return;
    }

    try {
        loadIndexes();
        const result = findEntry(args);

        if (!result) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ No emoji found matching: *${args}*\n\nTry a different word or paste the emoji directly.`
            }, { quoted: msg });
            return;
        }

        if ("suggestions" in result) {
            await sock.sendMessage(msg.key.remoteJid, { text: formatSuggestions(result.suggestions) }, { quoted: msg });
            return;
        }

        const entry = result.entry;
        const picked = pickImage(entry);
        const caption = formatEntry(entry, result.method, picked);

        // Try to send the image (Microsoft Teams design preferred) with the info
        // as the caption. Image captions render reliably, unlike audio captions.
        if (picked) {
            const imgBuf = await fetchImage(picked.url);
            if (imgBuf) {
                await sock.sendMessage(msg.key.remoteJid, {
                    image: imgBuf,
                    caption,
                }, { quoted: msg });
                return;
            }
            // Image download failed — fall through to text-only
            console.warn(`📖 Failed to download image for ${entry.name}: ${picked.url}`);
        }

        // No design/image, or download failed → text only
        await sock.sendMessage(msg.key.remoteJid, { text: caption }, { quoted: msg });

    } catch (error: any) {
        console.error("Emojipedia error:", error?.message || error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Emojipedia lookup failed. Check server logs."
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "emojipedia",
    aliases: ["emoji", "ep"],
    description: "Look up emoji info with its Microsoft Teams artwork",
    usage: "!emojipedia <emoji | name | :shortcode:>",
    requiresArgs: true,
    handler: handleEmojipedia,
};

export default command;