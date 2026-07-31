/**
 * index.ts - relasma/src/ai/index.ts
 *
 * /query (/ask, /ai)  - ask the AI, with optional image/audio/video/PDF
 * /imagine (/img)     - generate or edit an image
 *
 * Both run on the same shared implementations the WhatsApp bot uses, including
 * the model fallback chain and the per-chat conversation memory - so a chat's
 * history is genuinely the same history on either bot.
 */

import { GoogleGenAI } from "@google/genai";
import { cmd, escapeHtml, feature, type Ctx } from "../lib/command.js";
import { findMedia, findImage, downloadMedia, formatBytes } from "../lib/media.js";
import { askWithFallback } from "../../../shared/lib/ai-fallback.js";
import { loadHistory, saveHistory } from "../../../shared/lib/ai-memory.js";
import { truncate } from "../../../shared/lib/text.js";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const SUPPORTED_MIME_PREFIXES = ["image/", "audio/", "video/", "application/pdf"];
const MAX_TG_TEXT = 4000;

const SYSTEM_INSTRUCTION =
    `You are Benjamin Thio Zi Liang, a software engineering student at UTAR LKC FES. ` +
    `Your tone is casual, direct, and confident. You are a hardcore programmer who builds ` +
    `high-performance tools, and complex systems using TypeScript, Python, C++, Java, and etc.`;

const IMAGE_MODEL = "gemini-2.5-flash-image";
const MAX_INPUT_MEDIA_BYTES = 10 * 1024 * 1024;

const ai = new GoogleGenAI({ apiKey: process.env["AI_API_KEY"] });

/** Turn a provider failure into something worth reading. */
function friendlyAiError(err: unknown): string {
    const m = String(err instanceof Error ? err.message : err).toLowerCase();
    if (m.includes("permission") || m.includes("api key") || m.includes("api_key")) {
        return "❌ AI key issue - check the AI_API_KEY env var.";
    }
    if (m.includes("quota") || m.includes("rate") || m.includes("resource_exhausted") || m.includes("429")) {
        return "❌ Rate-limited right now. Try again in a minute.";
    }
    if (m.includes("safety") || m.includes("blocked")) {
        return "❌ That prompt was blocked by safety filters. Try rephrasing.";
    }
    if (m.includes("all ai models")) {
        return "❌ Every model in the fallback chain is rate-limited. Try again shortly.";
    }
    return "❌ The AI request failed. Check the server logs.";
}

const query = cmd("query", {
    aliases: ["ask", "ai"],
    description: "Ask the AI - accepts text, images, audio, video and PDFs",
    args: "<question>",
    usageHint:
        "Usage:\n" +
        "• /query <question>\n" +
        "• Send media with /query <question> as the caption\n" +
        "• Reply to media with /query <question>",
}, async (ctx: Ctx) => {
    const media = findMedia(ctx.tg, ["image", "video", "audio", "document"]);

    if (!ctx.hasArgs && !media) {
        await ctx.reply("Usage: /query <question>  (or attach/reply to media)");
        return;
    }

    await ctx.status(media ? `🧠 Analyzing ${media.kind}...` : "🧠 Thinking...");

    const parts: unknown[] = [];
    let hasMedia = false;

    if (media) {
        if (!SUPPORTED_MIME_PREFIXES.some(p => media.mimetype.startsWith(p))) {
            await ctx.reply(
                `❌ Unsupported file type: ${media.mimetype}\n\nAccepted: images, audio, video and PDF.`
            );
            return;
        }

        const buffer = await downloadMedia(media);
        if (buffer.length > MAX_MEDIA_BYTES) {
            await ctx.reply(
                `❌ File too large: ${formatBytes(buffer.length)} (limit ${formatBytes(MAX_MEDIA_BYTES)}).`
            );
            return;
        }

        parts.push({ inlineData: { mimeType: media.mimetype, data: buffer.toString("base64") } });
        hasMedia = true;
        console.log(`📎 Attached ${media.kind} (${media.mimetype}, ${formatBytes(buffer.length)})`);
    }

    const prompt = ctx.match || (media ? `Describe this ${media.kind} in detail.` : "");
    if (prompt) parts.push({ text: prompt });

    // Conversation memory is keyed by chat and shared with the WhatsApp bot
    const chatKey = String(ctx.chatId);
    const history = await loadHistory(chatKey);

    let answer: string;
    let model: string;
    try {
        const result = await askWithFallback(history, parts, SYSTEM_INSTRUCTION, hasMedia);
        answer = result.text;
        model = result.model;
    } catch (err) {
        console.error("AI fallback error:", err);
        await ctx.reply(friendlyAiError(err));
        return;
    }

    if (!answer) {
        await ctx.reply("❌ The AI returned an empty response.");
        return;
    }

    // Text-only turn saved; media bytes are never persisted into history
    history.push({ role: "user", parts: [{ text: hasMedia ? `[User sent ${media!.kind}] ${prompt}` : prompt }] });
    history.push({ role: "model", parts: [{ text: answer }] });
    await saveHistory(chatKey, history);

    const footer = model.startsWith("Gemini 2.5 Flash") && !model.includes("Lite")
        ? ""
        : `\n\n⚡ via ${model}`;

    /*
    Sent as plain text, not HTML. Model output routinely contains < and > in code
    and comparisons, and Telegram rejects the whole message if they don't parse
    as valid tags.
    */
    await ctx.reply(truncate(answer + footer, MAX_TG_TEXT, "\n\n…(truncated)"));
});

const imagine = cmd("imagine", {
    aliases: ["img", "image"],
    description: "Generate (or edit) an image from a text prompt",
    args: "<description>",
    usageHint:
        "🎨 Usage:\n" +
        "• /imagine <description> - generate an image\n" +
        "• Reply to / attach an image with /imagine <edit> - edit it\n\n" +
        "Example: /imagine a samurai cat under cherry blossoms, cinematic",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    const source = findImage(ctx.tg);

    await ctx.status(source ? "🎨 Editing your image..." : "🎨 Generating...");

    const parts: unknown[] = [];

    if (source) {
        const buf = await downloadMedia(source);
        if (buf.length > MAX_INPUT_MEDIA_BYTES) {
            await ctx.reply(
                `❌ Source image too large: ${formatBytes(buf.length)} ` +
                `(max ${formatBytes(MAX_INPUT_MEDIA_BYTES)}).`
            );
            return;
        }
        parts.push({ inlineData: { mimeType: source.mimetype, data: buf.toString("base64") } });
    }
    parts.push({ text: ctx.match });

    let response;
    try {
        response = await ai.models.generateContent({
            model: IMAGE_MODEL,
            contents: [{ role: "user", parts: parts as never }],
        });
    } catch (err) {
        console.error("Imagine error:", err);
        await ctx.reply(friendlyAiError(err));
        return;
    }

    /*
    The image is NOT in response.text - it arrives as a base64 blob inside
    candidates[0].content.parts[].inlineData, alongside any text the model chose
    to add.
    */
    let imageBuf: Buffer | null = null;
    let note = "";
    for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        const inline = (part as { inlineData?: { data?: string } }).inlineData;
        if (inline?.data) imageBuf = Buffer.from(inline.data, "base64");
        else if ((part as { text?: string }).text) note += (part as { text: string }).text;
    }

    if (!imageBuf) {
        await ctx.reply(
            note
                ? `⚠️ No image returned. The model said:\n${truncate(note, 500)}`
                : "❌ No image was generated. Try rephrasing your prompt."
        );
        return;
    }

    const { InputFile } = await import("grammy");
    await ctx.tg.replyWithPhoto(new InputFile(imageBuf, "imagine.png"), {
        caption: truncate(note.trim() || `🎨 ${ctx.match}`, 1000),
    });
});

export default feature("ai", [query, imagine]);
export { escapeHtml };
