import { WAMessage } from "@whiskeysockets/baileys";
import { setPrefs } from "../lib/user-prefs-db.js";
import { Command } from "./_types.js";

// A mapped list of the most popular gTTS supported languages
export const SUPPORTED_LANGS: Record<string, string> = {
    'af': 'Afrikaans',
    'am': 'Amharic',
    'ar': 'Arabic',
    'bg': 'Bulgarian',
    'bn': 'Bengali',
    'bs': 'Bosnian',
    'ca': 'Catalan',
    'cs': 'Czech',
    'cy': 'Welsh',
    'da': 'Danish',
    'de': 'German',
    'el': 'Greek',
    'en': 'English',
    'es': 'Spanish',
    'et': 'Estonian',
    'eu': 'Basque',
    'fi': 'Finnish',
    'fr': 'French',
    'fr-CA': 'French (Canada)',
    'gl': 'Galician',
    'gu': 'Gujarati',
    'ha': 'Hausa',
    'hi': 'Hindi',
    'hr': 'Croatian',
    'hu': 'Hungarian',
    'id': 'Indonesian',
    'is': 'Icelandic',
    'it': 'Italian',
    'iw': 'Hebrew',
    'ja': 'Japanese',
    'jw': 'Javanese',
    'km': 'Khmer',
    'kn': 'Kannada',
    'ko': 'Korean',
    'la': 'Latin',
    'lt': 'Lithuanian',
    'lv': 'Latvian',
    'ml': 'Malayalam',
    'mr': 'Marathi',
    'ms': 'Malay',
    'my': 'Myanmar (Burmese)',
    'ne': 'Nepali',
    'nl': 'Dutch',
    'no': 'Norwegian',
    'pa': 'Punjabi (Gurmukhi)',
    'pl': 'Polish',
    'pt': 'Portuguese (Brazil)',
    'pt-PT': 'Portuguese (Portugal)',
    'ro': 'Romanian',
    'ru': 'Russian',
    'si': 'Sinhala',
    'sk': 'Slovak',
    'sq': 'Albanian',
    'sr': 'Serbian',
    'su': 'Sundanese',
    'sv': 'Swedish',
    'sw': 'Swahili',
    'ta': 'Tamil',
    'te': 'Telugu',
    'th': 'Thai',
    'tl': 'Filipino',
    'tr': 'Turkish',
    'uk': 'Ukrainian',
    'ur': 'Urdu',
    'vi': 'Vietnamese',
    'yue': 'Cantonese',
    'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Mandarin/Taiwan)',
    'zh': 'Chinese (Mandarin)'
};

async function handleLang(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    // Extract the requested language code
    const requestedCode = text.slice("!lang".length).trim().toLowerCase();

    // If no argument is provided, display the menu
    if (!requestedCode) {
        const langList = Object.entries(SUPPORTED_LANGS)
            .map(([code, name]) => `• *${code}* : ${name}`)
            .join("\n");
        
        await sock.sendMessage(msg.key.remoteJid, {
            text: `🌐 *Available Voice Languages*\n\n${langList}\n\n*Usage:* \`!lang <code>\` (e.g., \`!lang ja\`)`
        }, { quoted: msg });
        return;
    }

    // Validate the input
    if (!SUPPORTED_LANGS[requestedCode]) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Invalid language code: \`${requestedCode}\`\nType \`!lang\` to see the supported list.`
        }, { quoted: msg });
        return;
    }

    try {
        // Save per-chat (remoteJid) so settings apply per-group or per-DM
        await setPrefs(msg.key.remoteJid, { ttsLang: requestedCode });

        await sock.sendMessage(msg.key.remoteJid, {
            text: `✅ Voice language successfully set to *${SUPPORTED_LANGS[requestedCode]}*!`
        }, { quoted: msg });

    } catch (err) {
        console.error("Firebase error saving lang:", err);
        await sock.sendMessage(msg.key.remoteJid, { 
            text: "❌ Failed to save language preference to cloud." 
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "lang",
    description: "View or set the text-to-speech language",
    usage: "!lang [code]",
    requiresArgs: false,
    handler: handleLang,
};

export default command;