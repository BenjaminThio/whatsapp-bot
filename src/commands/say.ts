import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { generateSpeech, getUserTtsLang } from "../lib/tts.js";

async function handleSay(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    const query = text.slice("!say ".length).trim();

    if (!query) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage: `!say <text>`\nUse `!lang` to change the voice language."
        }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(msg.key.remoteJid, { react: { text: "🎙️", key: msg.key } });

        const currentLang = await getUserTtsLang(msg.key.remoteJid);
        const audioBuffer = await generateSpeech(query, currentLang);

        // No PTT flag so WhatsApp doesn't reject MP3s with weird codec checks
        await sock.sendMessage(msg.key.remoteJid, {
            audio: audioBuffer,
            mimetype: "audio/mpeg"
        }, { quoted: msg });

    } catch (error: any) {
        console.error("gTTS Error:", error?.message || error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Failed to generate voice message. Check server logs."
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "say",
    aliases: ["speak"],
    description: "Convert text to audio using your set !lang",
    usage: "!say <text>",
    requiresArgs: true,
    handler: handleSay,
};

export default command;