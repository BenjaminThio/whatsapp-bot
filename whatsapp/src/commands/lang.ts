import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { setPrefs } from "../../../shared/lib/user-prefs-db.js";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";

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

/*
Codes are matched case-insensitively, but gTTS needs the exact casing of
"zh-CN" / "pt-PT" / "fr-CA". This index maps a lowercased input back to the
canonical code, so `!lang ZH-cn` works instead of being rejected.
*/
const CANONICAL: Record<string, string> = Object.fromEntries(
    Object.keys(SUPPORTED_LANGS).map(code => [code.toLowerCase(), code])
);

async function handleLang(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    // No argument - display the menu
    if (!ctx.hasArgs) {
        const langList = Object.entries(SUPPORTED_LANGS)
            .map(([code, name]) => `• *${code}* : ${name}`)
            .join("\n");

        await ctx.replyText(
            `🌐 *Available Voice Languages*\n\n${langList}\n\n` +
            `*Usage:* \`${cmd("lang")} <code>\` (e.g. \`${cmd("lang")} ja\`)`
        );
        return;
    }

    const canonical = CANONICAL[ctx.args[0].toLowerCase()];
    if (!canonical) {
        await ctx.replyText(
            `❌ Invalid language code: \`${ctx.args[0]}\`\n` +
            `Type \`${cmd("lang")}\` to see the supported list.`
        );
        return;
    }

    try {
        // Saved per-chat (remoteJid) so settings apply per-group or per-DM
        await setPrefs(ctx.chatId, { ttsLang: canonical });
        await ctx.replyText(`✅ Voice language successfully set to *${SUPPORTED_LANGS[canonical]}*!`);
    } catch (err) {
        console.error("Error saving lang:", err);
        await ctx.replyText("❌ Failed to save language preference.");
    }
}

const command: Command = {
    name: "lang",
    description: "View or set the text-to-speech language",
    usage: `${cmd("lang")} [code]`,
    requiresArgs: false,
    handler: handleLang,
};

export default command;
