import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { generateSpeech, getUserTtsLang } from "../../../shared/lib/tts.js";

async function handleSay(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    try {
        await ctx.react("🎙️");

        const currentLang = await getUserTtsLang(ctx.chatId);
        const audioBuffer = await generateSpeech(ctx.match, currentLang);

        // No PTT flag so WhatsApp doesn't reject MP3s with weird codec checks
        await ctx.reply({ audio: audioBuffer, mimetype: "audio/mpeg" });

    } catch (error: any) {
        console.error("gTTS Error:", error?.message || error);
        await ctx.replyText("❌ Failed to generate voice message. Check server logs.");
    }
}

const command: Command = {
    name: "say",
    aliases: ["speak"],
    description: "Convert text to audio using your set language",
    usage: `${cmd("say")} <text>`,
    usageHint: `⚠️ *Usage:* \`${cmd("say")} <text>\`\nUse \`${cmd("lang")}\` to change the voice language.`,
    requiresArgs: true,
    handler: handleSay,
};

export default command;
