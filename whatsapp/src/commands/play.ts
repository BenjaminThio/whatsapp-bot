import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { engine } from "../../../shared/assets/index.js";
import yts from "yt-search";
import { activeSearches, savedPollMessages } from "../memory.js";
import { Command, CommandContext } from "./_types.js";
import { runHelper } from "../../../shared/lib/subprocess.js";
import { cmd } from "../config/prefixes.js";
import { queueReply } from "../lib/outbox.js";
import { formatBytes } from "../lib/media.js";
import { fetchWithTimeout } from "../../../shared/lib/http.js";

interface MusicInfo {
    status: "success" | "error";
    title: string | null;
    duration: number | null;
    url: string;
    ext: string | null;
    abr: string | null;
    mimeType: string | null;
    message?: string;
}

const PROJECT_ROOT = process.cwd();
const MUSIC = engine("music_engine");
const MUSIC_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_RESULTS = 5;
const TITLE_MAX = 70;

/**
 * Run the music engine for a single URL and parse its JSON output.
 * The engine takes the URL as a CLI arg and prints a MusicInfo JSON to stdout.
 * Cross-platform: music.exe on Windows, music_engine.py on Termux/Linux.
 */
async function getMusicInfo(url: string): Promise<MusicInfo> {
    const out = await runHelper(PROJECT_ROOT, {
        winExe: MUSIC.winExe,
        pyScript: MUSIC.pyScript,
        args: [url],
        label: "music",
        timeoutMs: MUSIC_TIMEOUT_MS,
    });

    const text = out.toString("utf8").trim();
    try {
        return JSON.parse(text) as MusicInfo;
    } catch {
        throw new Error("Failed to parse music engine JSON output:\n" + text.slice(0, 500));
    }
}

// Exported because the poll handler in index.ts calls this after a vote
export async function processMediaDownload(
    _sock: any,
    targetUrl: string,
    jid: string,
    originalMsg: any
) {
    const reply = (content: any) => queueReply(jid, content, originalMsg);

    try {
        await reply({ text: "⏳ Fetching media link..." });

        const musicInfo = await getMusicInfo(targetUrl);
        if (musicInfo.status === "error" || !musicInfo.url) {
            await reply({ text: `❌ Failed: ${musicInfo.message ?? "unknown error"}` });
            return;
        }

        const videoResponse = await fetchWithTimeout(musicInfo.url, {
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            headers: { Referer: "https://www.youtube.com/" },
        });

        if (!videoResponse.ok) throw new Error(`YouTube rejected download (${videoResponse.status}).`);

        const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
        console.log(`🎵 Downloaded ${formatBytes(videoBuffer.length)}: ${musicInfo.title ?? targetUrl}`);

        await reply({
            video: videoBuffer,
            caption: musicInfo.title || "🎵 Here is your media!",
        });

    } catch (error: any) {
        console.error("Play command error:", error?.message || error);
        await reply({ text: "❌ An internal error occurred during download." });
    }
}

async function handlePlay(sock: WASocket, msg: WAMessage, _text: string, ctx: CommandContext) {
    const query = ctx.match;

    if (/^https?:\/\//i.test(query)) {
        await processMediaDownload(sock, query, ctx.chatId, msg);
        return;
    }

    await ctx.replyText(`🔍 Searching YouTube for: *${query}*...`);

    try {
        const searchResults = await yts(query);
        const videos = searchResults.videos.slice(0, MAX_RESULTS);

        if (videos.length === 0) {
            await ctx.replyText("❌ No results found on YouTube.");
            return;
        }

        const options: string[] = [];
        const resultsMap: Record<string, string> = {};

        for (const video of videos) {
            /*
            Poll options must be unique or WhatsApp merges them, and the vote
            hash would then match two different videos. Padding with spaces
            keeps them distinct while looking identical.
            */
            let title = video.title.length > TITLE_MAX
                ? video.title.substring(0, TITLE_MAX - 3) + "..."
                : video.title;
            while (options.includes(title)) title += " ";
            options.push(title);
            resultsMap[title] = video.url;
        }

        /*
        The poll is the one send whose RESULT matters - the vote handler looks up
        the returned message id. queueMessage hands back the sent message when it
        went out inline, and undefined when it had to be persisted; a queued poll
        can't be tracked, so we say so rather than leaving votes silently dead.
        */
        const pollMsg = await ctx.reply({
            poll: {
                name: `🎵 *Search Results:* ${query}\n\nSelect a video to download:`,
                values: options,
                selectableCount: 1,
            },
        });

        if (!pollMsg?.key?.id || !pollMsg.message) {
            await ctx.replyText(
                "⚠️ The connection dropped while sending the results poll - votes on it won't register.\n" +
                `Try \`${cmd("play")}\` again in a moment.`
            );
            return;
        }

        savedPollMessages.set(pollMsg.key.id, { key: pollMsg.key, message: pollMsg.message });
        activeSearches.set(pollMsg.key.id, {
            requester: ctx.userId,
            results: resultsMap,
        });

        console.log(`💾 Poll saved to memory with ID: ${pollMsg.key.id}`);

    } catch (error) {
        console.error("YT Search Error:", error);
        await ctx.replyText("❌ Error searching YouTube.");
    }
}

const command: Command = {
    name: "play",
    aliases: ["p"],
    description: "Search & download a song from YouTube",
    usage: `${cmd("play")} <song name or YouTube URL>`,
    requiresArgs: true,
    handler: handlePlay,
};

export default command;
