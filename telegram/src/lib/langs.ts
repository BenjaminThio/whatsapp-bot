/**
 * langs.ts - relasma/src/lib/langs.ts
 *
 * The gTTS languages both bots offer, and case-insensitive lookup for them.
 *
 * Codes are matched case-insensitively but gTTS needs the exact casing of
 * "zh-CN", "pt-PT" and "fr-CA", so `canonicalLang` maps a lowercased input back
 * to the real code rather than rejecting it.
 */

export const SUPPORTED_LANGS: Record<string, string> = {
    'af': 'Afrikaans', 'am': 'Amharic', 'ar': 'Arabic', 'bg': 'Bulgarian',
    'bn': 'Bengali', 'bs': 'Bosnian', 'ca': 'Catalan', 'cs': 'Czech',
    'cy': 'Welsh', 'da': 'Danish', 'de': 'German', 'el': 'Greek',
    'en': 'English', 'es': 'Spanish', 'et': 'Estonian', 'eu': 'Basque',
    'fi': 'Finnish', 'fr': 'French', 'fr-CA': 'French (Canada)', 'gl': 'Galician',
    'gu': 'Gujarati', 'ha': 'Hausa', 'hi': 'Hindi', 'hr': 'Croatian',
    'hu': 'Hungarian', 'id': 'Indonesian', 'is': 'Icelandic', 'it': 'Italian',
    'iw': 'Hebrew', 'ja': 'Japanese', 'jw': 'Javanese', 'km': 'Khmer',
    'kn': 'Kannada', 'ko': 'Korean', 'la': 'Latin', 'lt': 'Lithuanian',
    'lv': 'Latvian', 'ml': 'Malayalam', 'mr': 'Marathi', 'ms': 'Malay',
    'my': 'Myanmar (Burmese)', 'ne': 'Nepali', 'nl': 'Dutch', 'no': 'Norwegian',
    'pa': 'Punjabi (Gurmukhi)', 'pl': 'Polish', 'pt': 'Portuguese (Brazil)',
    'pt-PT': 'Portuguese (Portugal)', 'ro': 'Romanian', 'ru': 'Russian',
    'si': 'Sinhala', 'sk': 'Slovak', 'sq': 'Albanian', 'sr': 'Serbian',
    'su': 'Sundanese', 'sv': 'Swedish', 'sw': 'Swahili', 'ta': 'Tamil',
    'te': 'Telugu', 'th': 'Thai', 'tl': 'Filipino', 'tr': 'Turkish',
    'uk': 'Ukrainian', 'ur': 'Urdu', 'vi': 'Vietnamese', 'yue': 'Cantonese',
    'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Mandarin/Taiwan)',
    'zh': 'Chinese (Mandarin)',
};

const BY_LOWER: Record<string, string> = Object.fromEntries(
    Object.keys(SUPPORTED_LANGS).map(code => [code.toLowerCase(), code])
);

/** The canonical gTTS code for a user-typed one, or null if unsupported. */
export function canonicalLang(input: string): string | null {
    return BY_LOWER[input.trim().toLowerCase()] ?? null;
}
