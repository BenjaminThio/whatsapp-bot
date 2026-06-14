/*
langmap.ts - maps Wiktionary language-section names to gTTS language codes.

Wiktionary writes section headers like "=== French ===", "=== Mandarin ===".
gTTS wants IETF codes like "fr", "zh-CN". This table covers the languages
gTTS actually supports (~70). Wiktionary languages NOT in this table simply
won't get a pronunciation — better silence than a wrong-language voice.

Keys are lowercased Wiktionary language names.
*/
const WIKTIONARY_TO_GTTS: Record<string, string> = {
    // Major European
    "english": "en",
    "french": "fr",
    "german": "de",
    "spanish": "es",
    "italian": "it",
    "portuguese": "pt",
    "dutch": "nl",
    "polish": "pl",
    "russian": "ru",
    "ukrainian": "uk",
    "czech": "cs",
    "slovak": "sk",
    "croatian": "hr",
    "serbo-croatian": "hr",   // gTTS has no exact serbo-croatian; Croatian is closest
    "bosnian": "bs",
    "bulgarian": "bg",
    "romanian": "ro",
    "hungarian": "hu",
    "finnish": "fi",
    "swedish": "sv",
    "norwegian": "no",
    "norwegian bokmål": "no",
    "norwegian nynorsk": "no",
    "danish": "da",
    "icelandic": "is",
    "greek": "el",
    "latvian": "lv",
    "lithuanian": "lt",
    "estonian": "et",
    "catalan": "ca",
    "galician": "gl",
    "basque": "eu",
    "welsh": "cy",
    "irish": "ga",
    "albanian": "sq",
    "macedonian": "mk",
    "slovenian": "sl",
    "afrikaans": "af",
    "esperanto": "eo",
    "latin": "la",

    // Asian
    "mandarin": "zh-CN",
    "chinese": "zh-CN",
    "cantonese": "yue",
    "japanese": "ja",
    "korean": "ko",
    "vietnamese": "vi",
    "thai": "th",
    "indonesian": "id",
    "malay": "ms",
    "filipino": "tl",
    "tagalog": "tl",
    "hindi": "hi",
    "bengali": "bn",
    "tamil": "ta",
    "telugu": "te",
    "kannada": "kn",
    "malayalam": "ml",
    "marathi": "mr",
    "gujarati": "gu",
    "punjabi": "pa",
    "urdu": "ur",
    "nepali": "ne",
    "sinhalese": "si",
    "sinhala": "si",
    "khmer": "km",
    "myanmar": "my",
    "burmese": "my",

    // Middle Eastern / African
    "arabic": "ar",
    "hebrew": "iw",
    "persian": "fa",
    "turkish": "tr",
    "swahili": "sw",
    "amharic": "am",
    "hausa": "ha",
    "yoruba": "yo",
    "igbo": "ig",
    "somali": "so",
};

// Returns the gTTS code for a Wiktionary language name, or null if unsupported.
export function gttsCodeForLanguage(wiktionaryLang: string): string | null {
    const key = wiktionaryLang.trim().toLowerCase();
    return WIKTIONARY_TO_GTTS[key] ?? null;
}

/*
Extract the ordered list of language section names from a formatted
definition string (the `=== Language ===` headers our stripper emits).
*/
export function extractLanguages(definition: string): string[] {
    const langs: string[] = [];
    for (const line of definition.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("=== ") && trimmed.endsWith(" ===")) {
            const name = trimmed.slice(4, -4).trim();
            if (name) langs.push(name);
        }
    }
    return langs;
}