import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { generateSpeech } from "../../../shared/lib/tts.js";
import { lookupWord, isDictAvailable } from "../../../shared/lib/dict.js";
import { extractLanguages, gttsCodeForLanguage } from "../../../shared/lib/langmap.js";
import { cmd } from "../config/prefixes.js";
import { truncate } from "../lib/wa-text.js";

const TEXT_MAX = 3800;

/*
Max number of per-language pronunciations to send for one word. A word like
"love" exists in 20+ languages; sending 20 audio clips would be spam.
*/
const MAX_PRONUNCIATIONS = 4;

// Pronunciation planning
interface PronunciationPlan {
    langName: string;   // Wiktionary display name, e.g. "French"
    gttsCode: string;   // gTTS code, e.g. "fr"
}

/*
From the definition text, work out which languages to pronounce and in what
voice. Reads the `=== Language ===` headers, maps each to a gTTS code, drops
unsupported languages and duplicate voices, and caps the count.
*/
function planPronunciations(definition: string): PronunciationPlan[] {
    const langs = extractLanguages(definition);
    const plans: PronunciationPlan[] = [];
    const seenCodes = new Set<string>();

    for (const langName of langs) {
        const code = gttsCodeForLanguage(langName);
        if (!code) continue;                 // gTTS can't speak this language
        if (seenCodes.has(code)) continue;   // e.g. Bokmål + Nynorsk both => "no"
        seenCodes.add(code);
        plans.push({ langName, gttsCode: code });
        if (plans.length >= MAX_PRONUNCIATIONS) break;
    }

    return plans;
}

// Handler
async function handleDict(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    // Collapse any run of whitespace so "  hello   world " looks up "hello world"
    const word = ctx.args.join(" ");

    if (!isDictAvailable()) {
        await ctx.replyText("❌ The dictionary index isn't installed on this host.");
        return;
    }

    try {
        await ctx.react("📖");

        // 1. Look up the word
        const definition = await lookupWord(word);
        if (!definition) {
            await ctx.replyText(`❌ Not found in Wiktionary: *${word}*`);
            return;
        }

        // 2. Send the definition text first
        await ctx.replyText(
            truncate(`📖 *${word}*\n\n${definition.trim()}`, TEXT_MAX, "\n\n... _(truncated)_")
        );

        /*
        3. Figure out which languages to pronounce, based on the definition's
           own language sections - not the user's !lang setting.
        */
        const plans = planPronunciations(definition);
        if (plans.length === 0) {
            console.log(`📖 No pronounceable language for "${word}"`);
            return;
        }

        // 4. Generate and send one labeled pronunciation per language
        for (const plan of plans) {
            try {
                const audio = await generateSpeech(word, plan.gttsCode);
                await ctx.reply({ audio, mimetype: "audio/mpeg" });
                /*
                Label which language this pronunciation is - sent as a tiny
                follow-up so the user knows which voice they just heard.
                */
                await ctx.sendText(`🔊 _${plan.langName} pronunciation of_ *${word}*`);
            } catch (ttsErr: any) {
                console.error(`📖 TTS failed for ${plan.langName} (${plan.gttsCode}):`, ttsErr?.message || ttsErr);
                // Skip this language, continue with the rest
            }
        }

    } catch (error: any) {
        console.error("Dict error:", error?.message || error);
        await ctx.replyText(`❌ Dict lookup failed: ${error?.message || "unknown error"}`);
    }
}

const command: Command = {
    name: "dict",
    aliases: ["define", "dictionary"],
    description: "Look up a word in Wiktionary with per-language pronunciation",
    usage: `${cmd("dict")} <word>`,
    usageHint: `⚠️ *Usage:* \`${cmd("dict")} <word>\`\nExample: \`${cmd("dict")} serendipity\``,
    requiresArgs: true,
    handler: handleDict,
};

export default command;