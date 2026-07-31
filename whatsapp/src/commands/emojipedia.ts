import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";
import { truncate } from "../lib/wa-text.js";
import {
    lookupEmoji, pickImage, type EmojiEntry,
} from "../../../shared/lib/emoji-db.js";

/*
Lookup runs on the shared indexed emoji database.

This module used to parse all 5,225 entries of a 60 MB JSONL into Maps at first
use: a 383 ms stall on the first !emojipedia and 66 MB of JS heap held for the
life of the process, on a phone. The index keeps only the searchable fields in
memory and reads the one entry it needs by byte offset - 7 MB and ~0.2 ms.
*/

const MAX_CAPTION = 1024;   // WhatsApp's image caption limit

function formatEntry(entry: EmojiEntry, platform: string | null, fuzzy: boolean): string {
    const lines: string[] = [`📖 *${entry.name}*  ${entry.character}`, ""];

    if (entry.category.main || entry.category.sub) {
        const parts = [entry.category.main, entry.category.sub].filter(Boolean);
        lines.push(`📂 ${parts.join(" › ")}`);
    }

    lines.push(`🔖 Shortcode: \`${entry.code}\``);

    if (entry.alias && entry.alias.length > 0) {
        lines.push(`🪶 Aliases: ${entry.alias.map(a => `\`${a}\``).join(", ")}`);
    }

    lines.push(`📦 Emoji ${entry.version}`);
    if (platform) lines.push(`🎨 _Showing:_ ${platform}`);

    if (entry.alert) lines.push("", `⚠️ ${entry.alert}`);

    if (entry.description.length > 0) {
        lines.push("", "📝 _Description_", entry.description[0]!);
    }

    if (fuzzy) lines.push("", "_(closest fuzzy match)_");

    return truncate(lines.join("\n"), MAX_CAPTION, "\n\n... _(more)_");
}

async function handleEmojipedia(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    try {
        const result = await lookupEmoji(ctx.match);

        if (result.kind === "none") {
            await ctx.replyText(
                `❌ No emoji found matching: *${ctx.match}*\n\nTry a different word or paste the emoji directly.`
            );
            return;
        }

        if (result.kind === "suggestions") {
            const lines = ["🤔 *Did you mean one of these?*\n"];
            for (const s of result.suggestions) {
                lines.push(`${s.character}  *${s.name}*  - \`${s.code}\``);
            }
            lines.push("\n_Try again with the exact name, shortcode, or emoji._");
            await ctx.replyText(lines.join("\n"));
            return;
        }

        const { entry, method } = result.match;
        const picked = pickImage(entry);
        const caption = formatEntry(entry, picked?.platformTitle ?? null, method === "fuzzy");

        if (picked) {
            const imgBuf = await fetchImageBuffer(picked.url);
            if (imgBuf) {
                await ctx.reply({ image: imgBuf, caption });
                return;
            }
            console.warn(`📖 Failed to download image for ${entry.name}: ${picked.url}`);
        }

        // No artwork, or the download failed - text only
        await ctx.replyText(caption);

    } catch (error: any) {
        console.error("Emojipedia error:", error?.message || error);
        await ctx.replyText("❌ Emojipedia lookup failed. Check server logs.");
    }
}

const command: Command = {
    name: "emojipedia",
    aliases: ["emoji", "ep"],
    description: "Look up emoji info with its Microsoft Teams artwork",
    usage: `${cmd("emojipedia")} <emoji | name | :shortcode:>`,
    usageHint:
        "⚠️ *Usage:*\n" +
        `• \`${cmd("emojipedia")} 🥇\` - by emoji character\n` +
        `• \`${cmd("emojipedia")} 1st place medal\` - by name\n` +
        `• \`${cmd("emojipedia")} :pizza:\` - by shortcode`,
    requiresArgs: true,
    handler: handleEmojipedia,
};

export default command;
