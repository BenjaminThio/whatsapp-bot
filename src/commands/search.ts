import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { searchImages } from "../lib/bing-images.js";

const MAX_IMAGES = 10;
const DEFAULT_IMAGES = 1;
const FETCH_TIMEOUT_MS = 10_000;

// Download one image URL into a Buffer, or null on any failure.
async function fetchImage(url: string): Promise<Buffer | null> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*",
            },
        });
        clearTimeout(timer);

        if (!res.ok) return null;
        const contentType = res.headers.get("content-type") || "";
        if (!contentType.startsWith("image/")) return null;

        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 16 * 1024 * 1024) return null;
        return buf;
    } catch {
        return null;
    }
}

async function handleSearch(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    const raw = text.slice("!search ".length).trim();
    if (!raw) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage: `!search <query> [count]`\nExample: `!search cake 5`\n(count optional, max 10)"
        }, { quoted: msg });
        return;
    }

    const tokens = raw.split(/\s+/);
    let count = DEFAULT_IMAGES;
    const lastTok = tokens[tokens.length - 1];
    if (tokens.length > 1 && /^\d+$/.test(lastTok)) {
        count = parseInt(lastTok, 10);
        tokens.pop();
    }
    count = Math.max(1, Math.min(MAX_IMAGES, count));
    const query = tokens.join(" ").trim();

    if (!query) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Please provide something to search for. Example: `!search cake 5`"
        }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: "🔍", key: msg.key } });

        // Over-fetch so dead URLs don't leave us short
        const results = await searchImages(query, {
            limit: count * 3,
            safeSearch: "moderate",
        });

        if (results.length === 0) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ No images found for: *${query}*`
            }, { quoted: msg });
            return;
        }

        let sent = 0;
        let attempted = 0;

        for (const item of results) {
            if (sent >= count) break;
            if (attempted >= count * 3) break;
            attempted++;

            if (!item.image) continue;
            const imgBuf = await fetchImage(item.image);
            if (!imgBuf) continue;

            try {
                await sock.sendMessage(msg.key.remoteJid, {
                    image: imgBuf,
                    caption: sent === 0 ? `🔍 *${query}* - result ${sent + 1}` : `${sent + 1}`,
                }, { quoted: sent === 0 ? msg : undefined });
                sent++;
            } catch (sendErr) {
                console.error("Failed to send image:", sendErr);
            }
        }

        if (sent === 0) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `❌ Found results for *${query}* but couldn't download any usable images. Try again.`
            }, { quoted: msg });
        } else if (sent < count) {
            await sock.sendMessage(msg.key.remoteJid, {
                text: `ℹ️ Sent ${sent} of ${count} requested (some images failed to download).`
            });
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
        await sock.sendMessage(msg.key.remoteJid, { text: userMsg }, { quoted: msg });
    }
}

const command: Command = {
    name: "search",
    aliases: ["img", "image"],
    description: "Search for images via Bing",
    usage: "!search <query> [count]",
    requiresArgs: true,
    handler: handleSearch,
};

export default command;