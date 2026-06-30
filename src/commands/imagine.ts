/**
 * imagine.ts - src/commands/imagine.ts
 *
 * Generate an image from a text prompt using Gemini 2.5 Flash Image
 * ("Nano Banana"). Free tier: ~500 images/day, 1024x1024, reuses AI_API_KEY.
 *
 *   !imagine a cyberpunk cat hacking a neon terminal
 *   !img       (alias)
 *   !image     (alias)
 *
 * You can also attach or reply to an image to EDIT it (Nano Banana supports
 * image+text => image), e.g. reply to a photo with "!imagine make it snow".
 *
 * Response shape note: the generated image is NOT in response.text. It's a
 * base64 blob inside candidates[0].content.parts[].inlineData - we iterate the
 * parts and pick the one with inlineData.
 */

import { WAMessage, downloadMediaMessage } from "@whiskeysockets/baileys";
import { GoogleGenAI } from "@google/genai";
import { Command } from "./_types.js";

const ai = new GoogleGenAI({ apiKey: process.env.AI_API_KEY });

// The free image model. (gemini-2.5-flash-image = "Nano Banana", free tier.)
const IMAGE_MODEL = "gemini-2.5-flash-image";

const MAX_INPUT_MEDIA_BYTES = 10 * 1024 * 1024;   // 10 MB cap on edit-source images

// ─── Prompt + optional source-image extraction ────────────────────────────────

function extractPrompt(msg: WAMessage): string {
  const m: any = msg.message?.ephemeralMessage?.message || msg.message;
  if (!m) return "";
  const raw: string =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    "";
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  for (const trig of ["!imagine ", "!img ", "!image "]) {
    if (lower.startsWith(trig)) return trimmed.slice(trig.length).trim();
  }
  if (["!imagine", "!img", "!image"].includes(lower)) return "";
  return trimmed;
}

/** Find an image attached to the command or in the replied-to message (for editing). */
function extractSourceImage(msg: WAMessage): { mediaMsg: any; mimeType: string } | null {
  const m: any = msg.message?.ephemeralMessage?.message || msg.message;
  if (!m) return null;

  if (m.imageMessage) {
    return { mediaMsg: msg, mimeType: m.imageMessage.mimetype || "image/jpeg" };
  }
  const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;
  if (quoted?.imageMessage) {
    return { mediaMsg: { key: msg.key, message: quoted }, mimeType: quoted.imageMessage.mimetype || "image/jpeg" };
  }
  return null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handleImagine(sock: any, msg: WAMessage, _text: string) {
  if (!msg.key.remoteJid) return;
  const jid = msg.key.remoteJid;

  const prompt = extractPrompt(msg);
  const source = extractSourceImage(msg);

  if (!prompt) {
    await sock.sendMessage(jid, {
      text:
        "🎨 *Usage:*\n" +
        "• `!imagine <description>` - generate an image\n" +
        "• Reply to / attach an image with `!imagine <edit>` - edit it\n\n" +
        "*Example:* `!imagine a samurai cat under cherry blossoms, cinematic`",
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(jid, {
      text: source ? "🎨 Editing your image..." : "🎨 Generating...",
    }, { quoted: msg });

    // Build the request parts: [optional source image] + text prompt
    const parts: any[] = [];

    if (source) {
      const buf = await downloadMediaMessage(source.mediaMsg, "buffer", {}) as Buffer;
      if (buf.length > MAX_INPUT_MEDIA_BYTES) {
        await sock.sendMessage(jid, { text: "❌ Source image too large (max 10 MB)." }, { quoted: msg });
        return;
      }
      parts.push({ inlineData: { mimeType: source.mimeType, data: buf.toString("base64") } });
    }
    parts.push({ text: prompt });

    // Call the image model
    const response = await ai.models.generateContent({
      model: IMAGE_MODEL,
      contents: [{ role: "user", parts }],
    });

    // Pull the image out of candidates[0].content.parts[].inlineData
    // (NOT response.text - image data lives in inlineData)
    const respParts = response.candidates?.[0]?.content?.parts ?? [];
    let imageBuf: Buffer | null = null;
    let textNote = "";

    for (const part of respParts) {
      if ((part as any).inlineData?.data) {
        imageBuf = Buffer.from((part as any).inlineData.data, "base64");
      } else if ((part as any).text) {
        textNote += (part as any).text;
      }
    }

    if (!imageBuf) {
      // Model refused or returned only text (e.g. safety block)
      await sock.sendMessage(jid, {
        text: textNote
          ? `⚠️ No image returned. Model said:\n${textNote.slice(0, 500)}`
          : "❌ No image was generated. Try rephrasing your prompt.",
      }, { quoted: msg });
      await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } });
      return;
    }

    // Send the generated image, with any model note as the caption
    await sock.sendMessage(jid, {
      image: imageBuf,
      caption: textNote.trim() ? textNote.trim().slice(0, 900) : `🎨 ${prompt}`.slice(0, 900),
      mimetype: "image/png",
    }, { quoted: msg });

    await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } });

  } catch (error: any) {
    console.error("Imagine error:", error);
    const m = String(error?.message ?? error).toLowerCase();
    const errText =
      m.includes("permission") || m.includes("api key") || m.includes("api_key")
        ? "❌ AI key issue - check your AI_API_KEY env var."
        : m.includes("quota") || m.includes("rate") || m.includes("resource_exhausted") || m.includes("429")
          ? "❌ Image quota hit for today (free tier ~500/day). Try again after midnight Pacific."
          : m.includes("safety") || m.includes("blocked")
            ? "❌ That prompt was blocked by safety filters. Try something different."
            : "❌ Image generation failed. Check the terminal logs.";
    await sock.sendMessage(jid, { text: errText }, { quoted: msg });
    await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } });
  }
}

const command: Command = {
  name: "imagine",
  aliases: ["img", "image"],
  description: "Generate (or edit) an image from a text prompt using Gemini 2.5 Flash Image",
  usage: "!imagine <description>  (or reply to an image to edit it)",
  requiresArgs: false,
  handler: handleImagine,
};

export default command;