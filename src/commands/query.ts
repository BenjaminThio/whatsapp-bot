import { FieldValue } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import db from "../firebase.js";
import { Command } from "./_types.js";

const ai = new GoogleGenAI({ apiKey: process.env.AI_API_KEY });

// Gemini 2.5 Flash inline payload limit is 100 MB base64-encoded.
// Cap raw bytes at 20 MB to stay safely under that after base64 expansion (~33%)
// and to keep WhatsApp media handling snappy.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

// MIME types Gemini 2.5 Flash accepts as inline data.
// (Anything outside this set, send to Gemini anyway with a warning - Gemini
//  will reject it cleanly if unsupported, and we'd rather try than over-restrict.)
const SUPPORTED_MIME_PREFIXES = ["image/", "audio/", "video/", "application/pdf"];

interface ExtractedMedia {
    /** A WAMessage-shaped object that downloadMediaMessage can consume */
    mediaMsg: any;
    mimeType: string;
    kind: "image" | "audio" | "video" | "document";
}

/*
Find media attached to the !query command, in this priority order:
1. Media directly on the command message (caption-based)
2. Media on the message the user is replying to
Returns null when no media is present.
*/
function extractMediaMessage(msg: WAMessage): ExtractedMedia | null {
    const m: any = msg.message?.ephemeralMessage?.message || msg.message;
    if (!m) return null;

    // 1. Media attached directly (caption use case)
    if (m.imageMessage) {
        return { mediaMsg: msg, mimeType: m.imageMessage.mimetype || "image/jpeg", kind: "image" };
    }
    if (m.videoMessage) {
        return { mediaMsg: msg, mimeType: m.videoMessage.mimetype || "video/mp4", kind: "video" };
    }
    if (m.audioMessage) {
        return { mediaMsg: msg, mimeType: m.audioMessage.mimetype || "audio/ogg", kind: "audio" };
    }
    if (m.documentMessage) {
        return { mediaMsg: msg, mimeType: m.documentMessage.mimetype || "application/pdf", kind: "document" };
    }

    // 2. Media in the quoted/replied message
    const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted) {
        // Reconstruct a minimal WAMessage so downloadMediaMessage can fetch the bytes
        const reconstructed = { key: msg.key, message: quoted };
        if (quoted.imageMessage) {
            return { mediaMsg: reconstructed, mimeType: quoted.imageMessage.mimetype || "image/jpeg", kind: "image" };
        }
        if (quoted.videoMessage) {
            return { mediaMsg: reconstructed, mimeType: quoted.videoMessage.mimetype || "video/mp4", kind: "video" };
        }
        if (quoted.audioMessage) {
            return { mediaMsg: reconstructed, mimeType: quoted.audioMessage.mimetype || "audio/ogg", kind: "audio" };
        }
        if (quoted.documentMessage) {
            return { mediaMsg: reconstructed, mimeType: quoted.documentMessage.mimetype || "application/pdf", kind: "document" };
        }
    }

    return null;
}

/*
Extract the prompt text from the !query message.
Could be in the caption (when media is attached) OR in extendedTextMessage.text
(when replying to media).
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

    // Strip the "!query " (or alias) prefix
    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();
    for (const trigger of ["!query ", "!ask ", "!ai "]) {
        if (lower.startsWith(trigger)) return trimmed.slice(trigger.length).trim();
    }
    // Bare "!query" with no text - return empty
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

        // Load chat history
        const chatId = msg.key.remoteJid;
        const docRef = db.collection("ai_memory").doc(chatId);
        const docSnap = await docRef.get();
        let chatHistory: any[] = docSnap.exists ? (docSnap.data()?.history || []) : [];

        // Build the message parts
        const parts: any[] = [];

        if (media) {
            // Sanity-check MIME type
            const supported = SUPPORTED_MIME_PREFIXES.some(p => media.mimeType.startsWith(p));
            if (!supported) {
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `❌ Unsupported file type: \`${media.mimeType}\`\n\nGemini accepts: images, audio, video, and PDF.`
                }, { quoted: msg });
                return;
            }

            // Download bytes from WhatsApp
            const buffer = await downloadMediaMessage(media.mediaMsg, "buffer", {}) as Buffer;

            if (buffer.length > MAX_MEDIA_BYTES) {
                const mb = (buffer.length / 1024 / 1024).toFixed(1);
                await sock.sendMessage(msg.key.remoteJid, {
                    text: `❌ File too large: ${mb} MB (limit is 20 MB).`
                }, { quoted: msg });
                return;
            }

            parts.push({
                inlineData: {
                    mimeType: media.mimeType,
                    data: buffer.toString("base64"),
                }
            });

            console.log(`📎 Attached ${media.kind} (${media.mimeType}, ${(buffer.length / 1024).toFixed(1)} KB)`);
        }

        // Prompt text - if user gave none with media, ask for a generic description
        const effectivePrompt = prompt || (media ? `Describe this ${media.kind} in detail.` : "");
        if (effectivePrompt) {
            parts.push({ text: effectivePrompt });
        }

        // Send to Gemini
        const chatSession = ai.chats.create({
            model: "gemini-2.5-flash",
            history: chatHistory,
            config: {
                systemInstruction: `You are Benjamin Thio Zi Liang, a software engineering student at UTAR LKC FES. 
                Your tone is casual, direct, and confident. You are a hardcore programmer who builds high-performance tools, and complex systems using TypeScript, Python, C++, Java, and etc.`
            }
        });

        const response = await chatSession.sendMessage({ message: parts });
        const aiAnswer = response.text;
        if (!aiAnswer) throw new Error("Empty response from AI");

        /*
        ave text-only turn to history
        We deliberately DON'T persist media bytes - Firestore has a 1 MB document
        limit and base64 media would blow that fast. The model sees the media in
        the current turn but won't remember the bytes next turn (only what it said
        about them, which is the useful part anyway).
        */
        const historyPromptText = media
            ? `[User sent ${media.kind}] ${effectivePrompt}`
            : effectivePrompt;
        chatHistory.push({ role: "user", parts: [{ text: historyPromptText }] });
        chatHistory.push({ role: "model", parts: [{ text: aiAnswer }] });

        await docRef.set({
            history: chatHistory,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });

        await sock.sendMessage(msg.key.remoteJid, { text: aiAnswer }, { quoted: msg });

    } catch (error: any) {
        console.error("Gemini/Firebase API Error:", error);
        const errMsg = error?.message?.includes("PERMISSION") || error?.message?.includes("API key")
            ? "❌ AI key issue - check your AI_API_KEY env var."
            : "❌ Sorry bro, my brain crashed. Check the terminal logs!";
        await sock.sendMessage(msg.key.remoteJid, { text: errMsg }, { quoted: msg });
    }
}

const command: Command = {
    name: "query",
    aliases: ["ask", "ai"],
    description: "Ask the AI a question - accepts text, images, audio, video, and PDFs",
    usage: "!query <question>  (or attach/reply-to media with !query as caption)",
    requiresArgs: false, // because media alone is a valid invocation
    handler: handleQuery,
};

export default command;