/**
 * index.ts - telegram/src/music/index.ts
 *
 * /play <song name or YouTube URL>
 *
 * Mirrors the WhatsApp bot's flow. A URL downloads straight away; a search term
 * lists the top results and lets you pick one.
 *
 * WhatsApp uses a native poll for the picker because that is what Baileys
 * offers. Telegram has inline keyboards, which suit this better: two buttons per
 * result - a thumbnail link you can preview first, and the title, which starts
 * the download.
 *
 * The download runs through the same shared music engine as the WhatsApp side,
 * so both bots resolve videos identically.
 */

import { Composer, Context, InlineKeyboard, InputFile, type CallbackQueryContext } from "grammy";
import yts from "yt-search";
import { cmd, feature, type Ctx } from "../lib/command.js";
import { Callback } from "../types.js";
import { runHelper } from "../../../shared/lib/subprocess.js";
import { engine } from "../../../shared/assets/index.js";
import { fetchWithTimeout } from "../../../shared/lib/http.js";
import { formatBytes } from "../lib/media.js";

const PROJECT_ROOT = process.cwd();
const MUSIC = engine("music_engine");
const MUSIC_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const MAX_RESULTS = 5;
const TITLE_MAX = 40;

/** Telegram refuses uploads over 50 MB from a bot. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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

/**
 * Search results awaiting a choice.
 *
 * Keyed by the picker's message id, so two people searching in the same chat
 * cannot select from each other's list. Telegram caps callback data at 64
 * bytes, which is why the URL lives here and the button carries only an index.
 */
interface PendingSearch {
    query: string;
    requester: number;
    videos: { title: string; url: string; duration: string; author: string }[];
    at: number;
}

const pending = new Map<number, PendingSearch>();

/** Forget pickers nobody acted on, so the map cannot grow forever. */
const PICKER_TTL_MS = 30 * 60_000;

function prunePending(): void {
    const cutoff = Date.now() - PICKER_TTL_MS;
    for (const [id, p] of pending) {
        if (p.at < cutoff) pending.delete(id);
    }
}

/** Ask the music engine to resolve a URL to a direct media link. */
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
        throw new Error("The music engine returned something that wasn't JSON:\n" + text.slice(0, 300));
    }
}

const shorten = (s: string, max: number): string =>
    s.length <= max ? s : s.slice(0, max - 1) + "…";

/**
 * Download a resolved video and send it.
 *
 * `notify` reports progress: the command path replies, the callback path edits
 * the picker message so the chat doesn't fill with status lines.
 */
async function downloadAndSend(
    ctx: Context,
    targetUrl: string,
    notify: (text: string) => Promise<unknown>
): Promise<void> {
    await notify("⏳ Fetching media link…");

    const info = await getMusicInfo(targetUrl);
    if (info.status === "error" || !info.url) {
        await notify(`❌ Failed: ${info.message ?? "unknown error"}`);
        return;
    }

    await notify(`⬇️ Downloading ${shorten(info.title ?? "audio", 60)}…`);

    const res = await fetchWithTimeout(info.url, {
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        headers: { Referer: "https://www.youtube.com/" },
    });
    if (!res.ok) throw new Error(`YouTube rejected the download (HTTP ${res.status}).`);

    const bytes = Buffer.from(await res.arrayBuffer());
    console.log(`🎵 Downloaded ${formatBytes(bytes.length)}: ${info.title ?? targetUrl}`);

    /*
    Checked before the upload, not after. Telegram rejects anything over 50 MB
    from a bot, and discovering that at the end of a five-minute download is a
    worse experience than being told up front - with the link, so the video is
    still reachable.
    */
    if (bytes.length > MAX_UPLOAD_BYTES) {
        await notify(
            `❌ That video is ${formatBytes(bytes.length)}, over Telegram's ` +
            `${formatBytes(MAX_UPLOAD_BYTES)} bot limit.\n🔗 ${targetUrl}`
        );
        return;
    }

    await ctx.replyWithVideo(new InputFile(bytes, "video.mp4"), {
        caption: shorten(info.title ?? "🎵 Here is your media!", 1000),
    });
}

// ── /play ─────────────────────────────────────────────────────────────────────

const play = cmd("play", {
    aliases: ["p"],
    description: "Search & download a song or video from YouTube",
    args: "<song name or YouTube URL>",
    usageHint: "Usage: /play <song name or YouTube URL>\nExample: /play never gonna give you up",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    const query = ctx.match;

    // A URL skips the picker entirely, same as the WhatsApp side
    if (/^https?:\/\//i.test(query)) {
        await downloadAndSend(ctx.tg, query, async (text) => { await ctx.reply(text); });
        return;
    }

    await ctx.status(`🔍 Searching YouTube for: ${query}…`);

    const results = await yts(query);
    const videos = results.videos.slice(0, MAX_RESULTS);

    if (videos.length === 0) {
        await ctx.reply(`❌ No results found for: ${query}`);
        return;
    }

    /*
    Two buttons per row: the thumbnail opens in the browser so you can see what
    you are about to download, and the title starts it.
    */
    const keyboard = new InlineKeyboard();
    videos.forEach((v, i) => {
        /*
        A url button with an empty or malformed href makes Telegram reject the
        whole keyboard, so a result without a usable thumbnail just gets its
        select button and no preview.
        */
        const thumb = typeof v.thumbnail === "string" && /^https?:\/\//i.test(v.thumbnail)
            ? v.thumbnail
            : null;

        if (thumb) keyboard.url("🖼", thumb);

        keyboard
            .text(`${i + 1}. ${shorten(v.title, TITLE_MAX)}`, `${Callback.MUSIC} ${ctx.userId} ${i}`)
            .row();
    });
    keyboard.text("✖️ Cancel", `${Callback.DELETE} ${ctx.userId}`);

    const lines = videos.map((v, i) =>
        `${i + 1}. ${shorten(v.title, 55)}\n    ⏱ ${v.timestamp}  ·  ${v.author.name}`
    );

    const sent = await ctx.tg.reply(
        `🎵 Results for: ${query}\n\n${lines.join("\n")}\n\nPick one to download:`,
        { reply_markup: keyboard }
    );

    prunePending();
    pending.set(sent.message_id, {
        query,
        requester: ctx.userId,
        videos: videos.map(v => ({
            title: v.title,
            url: v.url,
            duration: v.timestamp,
            author: v.author.name,
        })),
        at: Date.now(),
    });
});

// ── Selection ─────────────────────────────────────────────────────────────────

const selection = new Composer<Context>();

selection.callbackQuery(
    new RegExp(`^${Callback.MUSIC} (\\d+) (\\d+)$`),
    async (ctx: CallbackQueryContext<Context>) => {
        const ownerId = Number(ctx.match[1]);
        const index = Number(ctx.match[2]);
        const messageId = ctx.callbackQuery.message?.message_id;

        // Only the person who searched may pick from their own list
        if (ctx.from.id !== ownerId) {
            await ctx.answerCallbackQuery({ text: "This isn't your search.", show_alert: true });
            return;
        }

        const search = messageId === undefined ? undefined : pending.get(messageId);
        const video = search?.videos[index];

        if (!video) {
            // The picker outlived its entry: the bot restarted, or it timed out
            await ctx.answerCallbackQuery({
                text: "This search has expired. Run /play again.",
                show_alert: true,
            });
            return;
        }

        await ctx.answerCallbackQuery();

        // One selection per picker, so a double-tap can't download twice
        pending.delete(messageId!);

        const edit = async (text: string): Promise<unknown> =>
            ctx.editMessageText(`🎵 ${shorten(video.title, 60)}\n\n${text}`)
                .catch(() => { /* the message may already be gone */ });

        try {
            await downloadAndSend(ctx, video.url, edit);
            await edit("✅ Sent.");
        } catch (err) {
            console.error("/play download failed:", err);
            await edit(`❌ ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
        }
    }
);

const commands = feature("music", [play]);

const composer = new Composer<Context>();
composer.use(commands);
composer.use(selection);

export default composer;
