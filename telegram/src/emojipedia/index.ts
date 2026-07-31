/**
 * index.ts - relasma/src/emojipedia/index.ts
 *
 * /emojipedia <emoji | name | :shortcode:>
 *
 * Lookup runs on the shared indexed emoji database. This module used to stream
 * the whole 60 MB JSONL and substring-match every line on every command - 11 ms
 * for an entry near the top of the file, 107 ms for one near the bottom, every
 * single time. It is now a positioned read: ~0.2 ms.
 */

import { InputFile } from "grammy";
import { cmd, feature, escapeHtml, type Ctx } from "../lib/command.js";
import {
    lookupEmoji, pickImage, pickAnimated, type EmojiEntry,
} from "../../../shared/lib/emoji-db.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";
import { truncate } from "../../../shared/lib/text.js";

const MAX_CAPTION = 1000;

function buildCaption(entry: EmojiEntry, platform: string | null, fuzzy: boolean): string {
    const lines: string[] = [
        `<b>${escapeHtml(entry.name)}</b>  ${entry.character}`,
        "",
    ];

    if (entry.category.main || entry.category.sub) {
        const parts = [entry.category.main, entry.category.sub].filter(Boolean).join(" › ");
        lines.push(`📂 ${escapeHtml(parts)}`);
    }

    lines.push(`🏷 <code>${escapeHtml(entry.code)}</code>`);

    if (entry.alias && entry.alias.length > 0) {
        lines.push(`🔖 ${entry.alias.map(a => `<code>${escapeHtml(a)}</code>`).join(", ")}`);
    }

    lines.push(`📦 Emoji ${entry.version}`);
    if (platform) lines.push(`🎨 ${escapeHtml(platform)}`);

    if (entry.alert) lines.push("", `⚠️ ${escapeHtml(entry.alert)}`);

    if (entry.description.length > 0) {
        lines.push("", escapeHtml(entry.description[0]!));
    }

    if (fuzzy) lines.push("", "<i>(closest match)</i>");

    return truncate(lines.join("\n"), MAX_CAPTION, "\n…");
}

const emojipedia = cmd("emojipedia", {
    aliases: ["emoji", "ep"],
    description: "Look up emoji artwork and metadata",
    args: "<emoji | name | :shortcode:>",
    usageHint:
        "Usage:\n" +
        "• /emojipedia 🥇 - by character\n" +
        "• /emojipedia 1st place medal - by name\n" +
        "• /emojipedia :pizza: - by shortcode\n\n" +
        "Add --animated for the 3D animated artwork where it exists.",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    // --animated is a flag, not part of the search term
    const wantsAnimated = /(^|\s)--animated(\s|$)/.test(ctx.match);
    const query = ctx.match.replace(/(^|\s)--animated(\s|$)/, " ").trim();

    if (!query) {
        await ctx.reply("Usage: /emojipedia <emoji | name | :shortcode:>");
        return;
    }

    const result = await lookupEmoji(query);

    if (result.kind === "none") {
        await ctx.reply(`❌ No emoji found matching: ${query}\n\nTry a different word, or paste the emoji itself.`);
        return;
    }

    if (result.kind === "suggestions") {
        const lines = result.suggestions.map(s => `${s.character}  <b>${escapeHtml(s.name)}</b> - <code>${escapeHtml(s.code)}</code>`);
        await ctx.html(`🤔 <b>Did you mean one of these?</b>\n\n${lines.join("\n")}`);
        return;
    }

    const { entry, method } = result.match;

    const animated = wantsAnimated ? pickAnimated(entry) : null;
    const picked = animated ?? pickImage(entry);
    const caption = buildCaption(entry, picked?.platformTitle ?? null, method === "fuzzy");

    if (picked) {
        /*
        Downloaded here rather than handed to Telegram as a URL. Telegram
        fetches URLs server-side, and a transient failure there loses the whole
        message instead of just the picture.
        */
        const image = await fetchImageBuffer(picked.url);

        if (image) {
            const isGif = picked.url.toLowerCase().endsWith(".gif");
            const file = new InputFile(image, isGif ? "emoji.gif" : "emoji.png");

            if (isGif) await ctx.tg.replyWithAnimation(file, { caption, parse_mode: "HTML" });
            else await ctx.tg.replyWithPhoto(file, { caption, parse_mode: "HTML" });
            return;
        }

        console.warn(`📖 Could not download artwork for ${entry.name}: ${picked.url}`);
    }

    await ctx.html(caption);
});

/**
 * What the shop's skin-definition page needs: a caption and something Telegram
 * can send as a photo.
 *
 * Kept as its own export because the shop renders it inside an inline-keyboard
 * flow rather than as a reply, so it cannot go through the command path.
 */
export interface EmojiDefinition {
    imageSource: string | InputFile;
    caption: string;
}

/**
 * Look up one emoji character for the shop.
 *
 * Falls back to a plain caption when the emoji is unknown or its artwork can't
 * be fetched - the shop must still render its page. The old version indexed
 * straight into `emoji.designs[0]` and threw on any emoji missing artwork,
 * which took the whole shop callback down with it.
 */
export async function getEmojiDefinition(emojiChar: string): Promise<EmojiDefinition> {
    const result = await lookupEmoji(emojiChar);

    if (result.kind !== "match") {
        return { imageSource: "", caption: `<b>${escapeHtml(emojiChar)}</b>\n\n<i>No description available.</i>` };
    }

    const { entry } = result.match;
    const picked = pickImage(entry);
    const caption = buildCaption(entry, picked?.platformTitle ?? null, false);

    if (!picked) return { imageSource: "", caption };

    const image = await fetchImageBuffer(picked.url);
    return {
        imageSource: image ? new InputFile(image, "emoji.png") : picked.url,
        caption,
    };
}

export default feature("emojipedia", [emojipedia]);
