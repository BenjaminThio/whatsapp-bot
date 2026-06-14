import { WAMessage } from "@whiskeysockets/baileys";
import path from "node:path";
import yts from "yt-search";
import { activeSearches, savedPollMessages } from "../memory.js";
import { Command } from "./_types.js";
import { runHelper } from "../lib/subprocess.js";

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

const PROJECT_ROOT = path.join(import.meta.dir, "../..");
const MUSIC_EXE = path.join(import.meta.dir, "../modules/music.exe");
const MUSIC_PY = path.join(import.meta.dir, "../modules/music_engine.py");
const MUSIC_TIMEOUT_MS = 60_000;

/**
 * Run the music engine for a single URL and parse its JSON output.
 * The engine takes the URL as a CLI arg and prints a MusicInfo JSON to stdout.
 * Cross-platform: music.exe on Windows, music_engine.py on Termux/Linux.
 */
async function getMusicInfo(url: string): Promise<MusicInfo> {
    const out = await runHelper(PROJECT_ROOT, {
        winExe: MUSIC_EXE,
        pyScript: MUSIC_PY,
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
export async function processMediaDownload(sock: any, targetUrl: string, jid: string, originalMsg: any) {
    try {
        await sock.sendMessage(jid, { text: "⏳ Fetching media link..." }, { quoted: originalMsg });

        const musicInfo = await getMusicInfo(targetUrl);
        if (musicInfo.status === "error" || !musicInfo.url) {
            await sock.sendMessage(jid, { text: `❌ Failed: ${musicInfo.message ?? "unknown error"}` }, { quoted: originalMsg });
            return;
        }

        const videoResponse = await fetch(musicInfo.url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
                "Referer": "https://www.youtube.com/"
            }
        });

        if (!videoResponse.ok) throw new Error("YouTube rejected download.");

        const arrayBuffer = await videoResponse.arrayBuffer();
        const videoBuffer = Buffer.from(arrayBuffer);

        await sock.sendMessage(jid, {
            video: videoBuffer,
            caption: musicInfo.title || "🎵 Here is your media!"
        }, { quoted: originalMsg });

    } catch (error: any) {
        console.error("Play command error:", error?.message || error);
        await sock.sendMessage(jid, { text: "❌ An internal error occurred during download." }, { quoted: originalMsg });
    }
}

async function handlePlay(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    const query = text.slice("!play ".length).trim();
    if (!query) return;

    const isUrl = query.startsWith("http://") || query.startsWith("https://");

    if (isUrl) {
        await processMediaDownload(sock, query, msg.key.remoteJid, msg);
        return;
    }

    await sock.sendMessage(msg.key.remoteJid, { text: `🔍 Searching YouTube for: *${query}*...` }, { quoted: msg });

    try {
        const searchResults = await yts(query);
        const videos = searchResults.videos.slice(0, 5);

        if (videos.length === 0) {
            await sock.sendMessage(msg.key.remoteJid, { text: "❌ No results found on YouTube." }, { quoted: msg });
            return;
        }

        const options: string[] = [];
        const resultsMap: Record<string, string> = {};

        for (const video of videos) {
            let title = video.title.length > 70 ? video.title.substring(0, 67) + "..." : video.title;
            while (options.includes(title)) title += " ";
            options.push(title);
            resultsMap[title] = video.url;
        }

        const pollMsg = await sock.sendMessage(
            msg.key.remoteJid,
            {
                poll: {
                    name: `🎵 *Search Results:* ${query}\n\nSelect a video to download:`,
                    values: options,
                    selectableCount: 1
                }
            },
            { quoted: msg }
        );

        if (pollMsg?.key?.id && pollMsg.message) {
            savedPollMessages.set(pollMsg.key.id, {
                key: pollMsg.key,
                message: pollMsg.message,
            });

            const requesterJid = msg.key.participant || msg.key.remoteJid;
            activeSearches.set(pollMsg.key.id, {
                requester: requesterJid!,
                results: resultsMap
            });

            console.log(`💾 Poll saved to memory with ID: ${pollMsg.key.id}`);
        }
    } catch (error) {
        console.error("YT Search Error:", error);
        await sock.sendMessage(msg.key.remoteJid, { text: "❌ Error searching YouTube." }, { quoted: msg });
    }
}

const command: Command = {
    name: "play",
    aliases: ["p"],
    description: "Search & download a song from YouTube",
    usage: "!play <song name or YouTube URL>",
    requiresArgs: true,
    handler: handlePlay,
};

export default command;