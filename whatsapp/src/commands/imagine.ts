/**
 * imagine.ts - src/commands/imagine.ts
 *
 * Generate an image from a text prompt using Gemini 2.5 Flash Image
 * ("Nano Banana"). Free tier: ~500 images/day, 1024x1024, reuses AI_API_KEY.
 *
 *   !imagine a cyberpunk cat hacking a neon terminal
 *
 * You can also attach or reply to an image to EDIT it (Nano Banana supports
 * image+text => image), e.g. reply to a photo with "!imagine make it snow".
 *
 * Response shape note: the generated image is NOT in response.text. It's a
 * base64 blob inside candidates[0].content.parts[].inlineData - we iterate the
 * parts and pick the one with inlineData.
 */

import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { GoogleGenAI } from "@google/genai";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { findImage, downloadMedia, formatBytes } from "../lib/media.js";
import { truncate } from "../lib/wa-text.js";

const ai = new GoogleGenAI({ apiKey: process.env.AI_API_KEY });

// The free image model. (gemini-2.5-flash-image = "Nano Banana", free tier.)
const IMAGE_MODEL = "gemini-2.5-flash-image";

const MAX_INPUT_MEDIA_BYTES = 10 * 1024 * 1024;   // 10 MB cap on edit-source images
const MAX_CAPTION = 900;

async function handleImagine(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
  const prompt = ctx.match;
  const source = findImage(ctx.msg);

  if (!prompt) {
    await ctx.sendUsage();
    return;
  }

  try {
    await ctx.replyText(source ? "🎨 Editing your image..." : "🎨 Generating...");

    // Build the request parts: [optional source image] + text prompt
    const parts: any[] = [];

    if (source) {
      const buf = await downloadMedia(source);
      if (buf.length > MAX_INPUT_MEDIA_BYTES) {
        await ctx.replyText(
          `❌ Source image too large: ${formatBytes(buf.length)} ` +
          `(max ${formatBytes(MAX_INPUT_MEDIA_BYTES)}).`
        );
        return;
      }
      parts.push({ inlineData: { mimeType: source.mimetype, data: buf.toString("base64") } });
    }
    parts.push({ text: prompt });

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
      await ctx.replyText(
        textNote
          ? `⚠️ No image returned. Model said:\n${truncate(textNote, 500)}`
          : "❌ No image was generated. Try rephrasing your prompt."
      );
      await ctx.react("❌");
      return;
    }

    await ctx.reply({
      image: imageBuf,
      caption: truncate(textNote.trim() || `🎨 ${prompt}`, MAX_CAPTION),
      mimetype: "image/png",
    });

    await ctx.react("✅");

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
    await ctx.replyText(errText);
    await ctx.react("❌");
  }
}

const command: Command = {
  name: "imagine",
  aliases: ["img", "image"],
  description: "Generate (or edit) an image from a text prompt using Gemini 2.5 Flash Image",
  usage: `${cmd("imagine")} <description>  (or reply to an image to edit it)`,
  usageHint:
    "🎨 *Usage:*\n" +
    `• \`${cmd("imagine")} <description>\` - generate an image\n` +
    `• Reply to / attach an image with \`${cmd("imagine")} <edit>\` - edit it\n\n` +
    `*Example:* \`${cmd("imagine")} a samurai cat under cherry blossoms, cinematic\``,
  requiresArgs: false,
  handler: handleImagine,
};

export default command;
