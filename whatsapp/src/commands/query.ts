import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { askWithFallback } from "../../../shared/lib/ai-fallback.js";
import { loadHistory, saveHistory } from "../../../shared/lib/ai-memory.js";
import { cmd } from "../config/prefixes.js";
import { findMedia, downloadMedia, formatBytes } from "../lib/media.js";

// Cap raw media bytes at 20 MB to stay safely under Gemini's 100 MB base64 inline
// limit (~33% expansion) and keep WhatsApp media handling snappy.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// MIME types accepted as inline data by the multimodal models.
const SUPPORTED_MIME_PREFIXES = ["image/", "audio/", "video/", "application/pdf"];

// System prompt shared across every model in the fallback chain.
const SYSTEM_INSTRUCTION =
    `You are Benjamin Thio Zi Liang, a software engineering student at UTAR LKC FES. ` +
    `Your tone is casual, direct, and confident. You are a hardcore programmer who builds ` +
    `high-performance tools, and complex systems using TypeScript, Python, C++, Java, and etc.`;

async function handleQuery(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    const prompt = ctx.match;
    const media = findMedia(ctx.msg, ["image", "video", "audio", "document"]);

    if (!prompt && !media) {
        await ctx.sendUsage();
        return;
    }

    try {
        await ctx.replyText(media ? `🧠 Analyzing ${media.kind}...` : "🧠 Thinking...");

        // Load chat history (Postgres-backed; trimmed to last MAX_HISTORY turns)
        const chatId = ctx.chatId;
        let chatHistory: any[] = await loadHistory(chatId);

        // Build the message parts
        const parts: any[] = [];
        let hasMedia = false;

        if (media) {
            const supported = SUPPORTED_MIME_PREFIXES.some(p => media.mimetype.startsWith(p));
            if (!supported) {
                await ctx.replyText(
                    `❌ Unsupported file type: \`${media.mimetype}\`\n\nAccepted: images, audio, video, and PDF.`
                );
                return;
            }

            const buffer = await downloadMedia(media);

            if (buffer.length > MAX_MEDIA_BYTES) {
                await ctx.replyText(
                    `❌ File too large: ${formatBytes(buffer.length)} (limit is ${formatBytes(MAX_MEDIA_BYTES)}).`
                );
                return;
            }

            parts.push({
                inlineData: { mimeType: media.mimetype, data: buffer.toString("base64") }
            });
            hasMedia = true;

            console.log(`📎 Attached ${media.kind} (${media.mimetype}, ${formatBytes(buffer.length)})`);
        }

        const effectivePrompt = prompt || (media ? `Describe this ${media.kind} in detail.` : "");
        if (effectivePrompt) parts.push({ text: effectivePrompt });

        // Ask the AI with automatic model/provider fallback
        // Cascades Gemini 2.5 Flash => 2.5 Flash-Lite => 3 Flash => Groq Llama,
        // skipping text-only Groq lanes when media is attached.
        const { text: aiAnswer, model } = await askWithFallback(
            chatHistory, parts, SYSTEM_INSTRUCTION, hasMedia
        );
        if (!aiAnswer) throw new Error("Empty response from AI");

        // Save text-only turn to history (no media bytes - Firestore 1 MB doc limit)
        const historyPromptText = media
            ? `[User sent ${media.kind}] ${effectivePrompt}`
            : effectivePrompt;
        chatHistory.push({ role: "user",  parts: [{ text: historyPromptText }] });
        chatHistory.push({ role: "model", parts: [{ text: aiAnswer }] });

        // Persist with sliding-window + size-guard (handled inside saveHistory)
        await saveHistory(chatId, chatHistory);

        // Append a tiny footer showing which model answered (only when it wasn't
        // the primary, so you know a fallback kicked in)
        const footer = model.startsWith("Gemini 2.5 Flash") && !model.includes("Lite")
            ? ""
            : `\n\n_⚡ via ${model}_`;

        await ctx.replyText(aiAnswer + footer);

    } catch (error: any) {
        console.error("AI fallback error:", error);
        const errMsg =
            error?.message?.includes("PERMISSION") || error?.message?.includes("API key")
                ? "❌ AI key issue - check your AI_API_KEY env var."
                : error?.message?.includes("All AI models")
                    ? "❌ All AI models are rate-limited right now. Try again in a minute!"
                    : "❌ Sorry bro, my brain crashed. Check the terminal logs!";
        await ctx.replyText(errMsg);
    }
}

const command: Command = {
    name: "query",
    aliases: ["ask", "ai"],
    description: "Ask the AI a question - accepts text, images, audio, video, and PDFs",
    usage: `${cmd("query")} <question>  (or attach/reply-to media with it as the caption)`,
    usageHint:
        "⚠️ *Usage:*\n" +
        `• \`${cmd("query")} <question>\` - text only\n` +
        `• Send media with \`${cmd("query")} <question>\` as the caption\n` +
        `• Reply to media with \`${cmd("query")} <question>\``,
    requiresArgs: false,
    handler: handleQuery,
};

export default command;