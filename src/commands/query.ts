import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { askWithFallback } from "../lib/ai-fallback.js";
import { loadHistory, saveHistory } from "../lib/ai-memory.js";

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

interface ExtractedMedia {
    mediaMsg: any;
    mimeType: string;
    kind: "image" | "audio" | "video" | "document";
}

/*
Find media attached to the !query command, in priority order:
1. Media directly on the command message (caption-based)
2. Media on the message the user is replying to
*/
function extractMediaMessage(msg: WAMessage): ExtractedMedia | null {
    const m: any = msg.message?.ephemeralMessage?.message || msg.message;
    if (!m) return null;

    if (m.imageMessage)    return { mediaMsg: msg, mimeType: m.imageMessage.mimetype    || "image/jpeg",       kind: "image"    };
    if (m.videoMessage)    return { mediaMsg: msg, mimeType: m.videoMessage.mimetype    || "video/mp4",        kind: "video"    };
    if (m.audioMessage)    return { mediaMsg: msg, mimeType: m.audioMessage.mimetype    || "audio/ogg",        kind: "audio"    };
    if (m.documentMessage) return { mediaMsg: msg, mimeType: m.documentMessage.mimetype || "application/pdf",  kind: "document" };

    const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) {
        const reconstructed = { key: msg.key, message: quoted };
        if (quoted.imageMessage)    return { mediaMsg: reconstructed, mimeType: quoted.imageMessage.mimetype    || "image/jpeg",      kind: "image"    };
        if (quoted.videoMessage)    return { mediaMsg: reconstructed, mimeType: quoted.videoMessage.mimetype    || "video/mp4",       kind: "video"    };
        if (quoted.audioMessage)    return { mediaMsg: reconstructed, mimeType: quoted.audioMessage.mimetype    || "audio/ogg",       kind: "audio"    };
        if (quoted.documentMessage) return { mediaMsg: reconstructed, mimeType: quoted.documentMessage.mimetype || "application/pdf", kind: "document" };
    }

    return null;
}

/*
Extract the prompt text from the !query message - caption when media is attached,
or extendedTextMessage.text when replying to media.
*/
function extractPrompt(msg: WAMessage): string {
    const m: any = msg.message?.ephemeralMessage?.message || msg.message;
    if (!m) return "";

    const raw: string =
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        "";

    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    for (const trigger of ["!query ", "!ask ", "!ai "]) {
        if (lower.startsWith(trigger)) return trimmed.slice(trigger.length).trim();
    }
    if (lower === "!query" || lower === "!ask" || lower === "!ai") return "";
    return trimmed;
}

async function handleQuery(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;

    const prompt = extractPrompt(msg);
    const media = extractMediaMessage(msg);

    if (!prompt && !media) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage:\n• `!query <question>` - text only\n• Send media with `!query <question>` as the caption\n• Reply to media with `!query <question>`"
        }, { quoted: msg });
        return;
    }

    try {
        const thinkingText = media ? `🧠 Analyzing ${media.kind}...` : "🧠 Thinking...";
        await sock.sendMessage(msg.key.remoteJid, { text: thinkingText }, { quoted: msg });

        // Load chat history (Postgres-backed; trimmed to last MAX_HISTORY turns)
        const chatId = msg.key.remoteJid;
        let chatHistory: any[] = await loadHistory(chatId);

        // Build the message parts
        const parts: any[] = [];
        let hasMedia = false;

        if (media) {
            const supported = SUPPORTED_MIME_PREFIXES.some(p => media.mimeType.startsWith(p));
            if (!supported) {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `❌ Unsupported file type: \`${media.mimeType}\`\n\nAccepted: images, audio, video, and PDF.`
                }, { quoted: msg });
                return;
            }

            const buffer = await downloadMediaMessage(media.mediaMsg, "buffer", {}) as Buffer;

            if (buffer.length > MAX_MEDIA_BYTES) {
                const mb = (buffer.length / 1024 / 1024).toFixed(1);
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `❌ File too large: ${mb} MB (limit is 20 MB).`
                }, { quoted: msg });
                return;
            }

            parts.push({
                inlineData: { mimeType: media.mimeType, data: buffer.toString("base64") }
            });
            hasMedia = true;

            console.log(`📎 Attached ${media.kind} (${media.mimeType}, ${(buffer.length / 1024).toFixed(1)} KB)`);
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

        await sock.sendMessage(msg.key.remoteJid, { text: aiAnswer + footer }, { quoted: msg });

    } catch (error: any) {
        console.error("AI fallback error:", error);
        const errMsg =
            error?.message?.includes("PERMISSION") || error?.message?.includes("API key")
                ? "❌ AI key issue - check your AI_API_KEY env var."
                : error?.message?.includes("All AI models")
                    ? "❌ All AI models are rate-limited right now. Try again in a minute!"
                    : "❌ Sorry bro, my brain crashed. Check the terminal logs!";
        await sock.sendMessage(msg.key.remoteJid, { text: errMsg }, { quoted: msg });
    }
}

const command: Command = {
    name: "query",
    aliases: ["ask", "ai"],
    description: "Ask the AI a question - accepts text, images, audio, video, and PDFs",
    usage: "!query <question>  (or attach/reply-to media with !query as caption)",
    requiresArgs: false,
    handler: handleQuery,
};

export default command;