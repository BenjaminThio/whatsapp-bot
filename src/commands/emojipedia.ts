import { WAMessage } from "@whiskeysockets/baileys";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Command } from "./_types.js";

// Data shape
interface EmojiEntry {
    character: string;
    name: string;
    description: string[];          // index 0 = blurb, last = approval history
    code: string;                   // ":shortcode:"
    render_quality: number;         // 1=poor, 4=excellent (Emojipedia's metric)
    version: number;                // Emoji version it was approved in
    category: {
        main: string | null;
        sub: string | null;
    };
    alias?: string[];               // additional shortcodes
    variant?: boolean;              // has a Variation Selector form
    alert?: string;                 // platform warning / new-emoji notice
}

// Lazy-loaded indexes - built once on first query, reused forever
let entries: EmojiEntry[] | null = null;
let byChar: Map<string, EmojiEntry> | null = null;
let byCode: Map<string, EmojiEntry> | null = null;       // shortcodes + aliases
let byNameLower: Map<string, EmojiEntry> | null = null;  // exact lowercased name

const DATA_PATH = path.join(import.meta.dir, "../../data/emoji.json");

function loadIndexes(): void {
    if (entries) return;  // already loaded

    if (!existsSync(DATA_PATH)) {
        throw new Error(`Emoji data file not found at ${DATA_PATH}`);
    }

    console.log("📖 Loading emojipedia data...");
    const raw = readFileSync(DATA_PATH, "utf-8");
    entries = JSON.parse(raw) as EmojiEntry[];

    byChar = new Map();
    byCode = new Map();
    byNameLower = new Map();

    for (const e of entries) {
        if (e.character) byChar.set(e.character, e);
        if (e.code) byCode.set(e.code.toLowerCase(), e);
        if (e.alias) {
            for (const a of e.alias) byCode.set(a.toLowerCase(), e);
        }
        if (e.name) byNameLower.set(e.name.toLowerCase(), e);
    }

    console.log(`📖 Indexed ${entries.length} emoji entries.`);
}

/*
Lookup strategy:
1. Try exact character match (handles emoji input directly)
2. Try shortcode/alias match (handles :pizza: input)
3. Try exact name match (case-insensitive)
4. Fuzzy substring scan, ranked by closeness
*/
function findEntry(query: string): { entry: EmojiEntry; method: string } | { suggestions: EmojiEntry[] } | null {
    if (!entries || !byChar || !byCode || !byNameLower) return null;

    const q = query.trim();
    if (!q) return null;

    // 1. Direct character match (also handles short emoji sequences)
    if (byChar.has(q)) {
        return { entry: byChar.get(q)!, method: "character" };
    }

    // 2. Shortcode - try both "pizza" and ":pizza:" forms
    const qLower = q.toLowerCase();
    const codeForm = qLower.startsWith(":") && qLower.endsWith(":") ? qLower : `:${qLower}:`;
    if (byCode.has(codeForm)) {
        return { entry: byCode.get(codeForm)!, method: "shortcode" };
    }
    if (byCode.has(qLower)) {
        return { entry: byCode.get(qLower)!, method: "shortcode" };
    }

    // 3. Exact name match
    if (byNameLower.has(qLower)) {
        return { entry: byNameLower.get(qLower)!, method: "name" };
    }

    // 4. Fuzzy: substring + token-overlap scoring. Cheap enough at 5k entries.
    const qTokens = qLower.split(/\s+/).filter(Boolean);
    const scored: Array<{ entry: EmojiEntry; score: number }> = [];

    for (const e of entries) {
        const nameLower = e.name.toLowerCase();
        let score = 0;

        // Full substring match: strong signal
        if (nameLower.includes(qLower)) {
            score += 100;
            // Prefix match is even better
            if (nameLower.startsWith(qLower)) score += 50;
        }

        // Token-overlap: every query word that appears in the name = bonus
        for (const t of qTokens) {
            if (t.length >= 2 && nameLower.includes(t)) score += 10;
        }

        // Shortcode partial match
        if (e.code.toLowerCase().includes(qLower)) score += 30;
        if (e.alias) {
            for (const a of e.alias) {
                if (a.toLowerCase().includes(qLower)) score += 20;
            }
        }

        if (score > 0) scored.push({ entry: e, score });
    }

    if (scored.length === 0) return null;

    scored.sort((a, b) => b.score - a.score);

    // If the top hit is overwhelmingly better than #2, treat it as the answer.
    // Otherwise, return suggestions for the user to pick from.
    const top = scored[0];
    const runnerUp = scored[1];
    if (top.score >= 100 && (!runnerUp || top.score >= runnerUp.score * 2)) {
        return { entry: top.entry, method: "fuzzy" };
    }

    return { suggestions: scored.slice(0, 6).map(s => s.entry) };
}


// Formatting
const MAX_MSG = 3800;  // WhatsApp soft limit is ~4096; leave headroom

function formatEntry(entry: EmojiEntry, method: string): string {
    const lines: string[] = [];

    // Header: name + emoji
    lines.push(`📖 *${entry.name}*  ${entry.character}`);
    lines.push("");

    // Category
    if (entry.category.main || entry.category.sub) {
        const parts = [entry.category.main, entry.category.sub].filter(Boolean);
        lines.push(`📂 ${parts.join(" › ")}`);
    }

    // Shortcode + aliases
    lines.push(`🔖 Shortcode: \`${entry.code}\``);
    if (entry.alias && entry.alias.length > 0) {
        const formatted = entry.alias.map(a => `\`${a}\``).join(", ");
        lines.push(`🪶 Aliases: ${formatted}`);
    }

    // Version
    lines.push(`📦 Emoji ${entry.version}`);

    // Alert (warnings, new-emoji notices)
    if (entry.alert) {
        lines.push("");
        lines.push(`⚠️ ${entry.alert}`);
    }

    // Description (main blurb)
    if (entry.description.length > 0) {
        lines.push("");
        lines.push("📝 _Description_");
        lines.push(entry.description[0]);
    }

    // History (typically the last description item, mentions Unicode approval)
    if (entry.description.length > 1) {
        const history = entry.description[entry.description.length - 1];
        // Only include if it's clearly metadata (mentions "approved" or "Unicode")
        if (/approved|unicode/i.test(history)) {
            lines.push("");
            lines.push("ℹ️ _History_");
            lines.push(history);
        }
    }

    // Match method footer - only show for fuzzy so users know it wasn't exact
    if (method === "fuzzy") {
        lines.push("");
        lines.push("_(closest fuzzy match)_");
    }

    let out = lines.join("\n");

    // Truncate if too long, prioritizing keeping the header + metadata visible
    if (out.length > MAX_MSG) {
        out = out.slice(0, MAX_MSG - 50) + "\n\n... _(truncated)_";
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

// Handler
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
            await sock.sendMessage(msg.key.remoteJid, {
                text: formatSuggestions(result.suggestions)
            }, { quoted: msg });
            return;
        }

        await sock.sendMessage(msg.key.remoteJid, {
            text: formatEntry(result.entry, result.method)
        }, { quoted: msg });

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
    description: "Look up emoji info (description, category, shortcode, history)",
    usage: "!emojipedia <emoji | name | :shortcode:>",
    requiresArgs: true,
    handler: handleEmojipedia,
};

export default command;