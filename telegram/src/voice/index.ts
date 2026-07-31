/**
 * index.ts - relasma/src/voice/index.ts
 *
 * /say <text> - read text aloud in the chat's chosen voice language.
 *
 * This used to build a URL against the Vercel deployment and hand it to
 * Telegram to fetch, which meant /say was broken whenever the deployment was
 * down, and it always spoke English regardless of /lang.
 * It runs the same local gTTS engine the WhatsApp bot uses and honours the
 * per-chat language setting, which is stored in the shared database.
 */

import { InputFile } from "grammy";
import { cmd, feature, type Ctx } from "../lib/command.js";
import { generateSpeech, getUserTtsLang } from "../../../shared/lib/tts.js";
import { SUPPORTED_LANGS } from "../lib/langs.js";

// gTTS rejects very long inputs, and a voice note that long is unusable anyway
const MAX_CHARS = 1000;

const say = cmd("say", {
    aliases: ["speak"],
    description: "Read text aloud in your chosen voice language",
    args: "<text>",
    usageHint: "Usage: /say <text>\nUse /lang to change the voice language.",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    if (ctx.match.length > MAX_CHARS) {
        await ctx.reply(`❌ That's ${ctx.match.length} characters; the limit is ${MAX_CHARS}.`);
        return;
    }

    // Per chat, so a group and a DM can each have their own voice
    const lang = await getUserTtsLang(String(ctx.chatId));
    const audio = await generateSpeech(ctx.match, lang);

    await ctx.tg.replyWithVoice(new InputFile(audio, "say.mp3"), {
        caption: `🔊 ${SUPPORTED_LANGS[lang] ?? lang}`,
    });
});

export default feature("voice", [say]);
