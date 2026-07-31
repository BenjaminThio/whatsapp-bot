import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { searchImages } from "../../../shared/lib/bing-images.js";
import { cmd } from "../config/prefixes.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";

const MAX_IMAGES = 10;
const DEFAULT_IMAGES = 1;

async function handleSearch(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    /*
    A trailing number is a count, not part of the query: "cake 5" means five
    pictures of cake. Anything else is all query.
    */
    const tokens = [...ctx.args];
    let count = DEFAULT_IMAGES;
    const last = tokens[tokens.length - 1];
    if (tokens.length > 1 && /^\d+$/.test(last)) {
        count = Math.max(1, Math.min(MAX_IMAGES, parseInt(last, 10)));
        tokens.pop();
    }

    const query = tokens.join(" ").trim();
    if (!query) {
        await ctx.sendUsage();
        return;
    }

    try {
        await ctx.react("🔍");

        // Over-fetch so dead URLs don't leave us short
        const results = await searchImages(query, { limit: count * 3, safeSearch: "moderate" });

        if (results.length === 0) {
            await ctx.replyText(`❌ No images found for: *${query}*`);
            return;
        }

        let sent = 0;
        let attempted = 0;

        for (const item of results) {
            if (sent >= count) break;
            if (attempted >= count * 3) break;
            attempted++;

            if (!item.image) continue;
            const imgBuf = await fetchImageBuffer(item.image);
            if (!imgBuf) continue;

            const caption = sent === 0 ? `🔍 *${query}* - result 1` : `${sent + 1}`;
            const isFirst = sent === 0;

            try {
                // Only the first result quotes the request; the rest just follow it
                if (isFirst) await ctx.reply({ image: imgBuf, caption });
                else await ctx.send({ image: imgBuf, caption });
                sent++;
            } catch (sendErr) {
                console.error("Failed to send image:", sendErr);
            }
        }

        if (sent === 0) {
            await ctx.replyText(
                `❌ Found results for *${query}* but couldn't download any usable images. Try again.`
            );
        } else if (sent < count) {
            await ctx.sendText(`ℹ️ Sent ${sent} of ${count} requested (some images failed to download).`);
        }

    } catch (error: any) {
        console.error("Image search error:", error?.message || error);
        const m = error?.message || "";
        let userMsg = "❌ Image search failed. Check server logs.";
        if (m.includes("changed their HTML")) {
            userMsg = "❌ Image search broke - Bing changed their page format. Needs a code patch in bing-images.ts.";
        } else if (m.includes("429") || m.includes("rate-limit")) {
            userMsg = "❌ Bing is rate-limiting us. Wait a minute and try again.";
        }
        await ctx.replyText(userMsg);
    }
}

const command: Command = {
    name: "search",
    // "img"/"image" belong to !imagine - using them here made routing depend on
    // which file the loader happened to read first.
    aliases: ["imgsearch", "pic"],
    description: "Search for images via Bing",
    usage: `${cmd("search")} <query> [count]`,
    usageHint:
        `⚠️ *Usage:* \`${cmd("search")} <query> [count]\`\n` +
        `Example: \`${cmd("search")} cake 5\`\n(count optional, max ${MAX_IMAGES})`,
    requiresArgs: true,
    handler: handleSearch,
};

export default command;
