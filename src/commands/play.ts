import { WAMessage } from "@whiskeysockets/baileys";
import { spawn } from "node:child_process";
import path from "node:path";
import yts from "yt-search";
import { activeSearches, savedPollMessages } from "../memory.js";
import { Command } from "./_types.js";

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

const getMusicInfo = (url: string): Promise<MusicInfo> =>
    new Promise((resolve, reject) => {
        const exePath = path.join(import.meta.dir, "../modules/music.exe");
        const worker = spawn(exePath, [url]);

        let err = "";
        let out = "";

        worker.stderr.on("data", (d) => (err += d.toString("utf8")));
        worker.stdout.on("data", (d) => (out += d.toString("utf8")));

        worker.on("error", reject);
        worker.on("close", (code) => {
            if (code !== 0) return reject(err || "Process exited with error code");
            try {
                resolve(JSON.parse(out));
            } catch (e) {
                reject("Failed to parse JSON output: " + out);
            }
        });
    });

// Exported because the poll handler in index.ts calls this after a vote
export async function processMediaDownload(sock: any, targetUrl: string, jid: string, originalMsg: any) {
    try {
        await sock.sendMessage(jid, { text: "⏳ Fetching media link..." }, { quoted: originalMsg });

        const musicInfo = await getMusicInfo(targetUrl);
        if (musicInfo.status === "error" || !musicInfo.url) {
            await sock.sendMessage(jid, { text: `❌ Failed: ${musicInfo.message}` }, { quoted: originalMsg });
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

    } catch (error) {
        console.error("Play command error:", error);
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