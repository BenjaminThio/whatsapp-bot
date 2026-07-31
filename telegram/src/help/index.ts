/**
 * index.ts - relasma/src/help/index.ts
 *
 * /help  - list every command, or explain one
 * /debug - the ids and queue depth you need when something isn't arriving
 */

import {
    cmd, feature, visibleCommands, usageLine, escapeHtml, describeLegacy, type Ctx,
} from "../lib/command.js";
import { outboxDepth } from "../../../shared/messaging/outbox.js";
import { pingDatabase } from "../../../shared/db/index.js";
import { checkAssets } from "../../../shared/assets/index.js";

/*
Features that register on a Composer directly rather than through feature().
Listed here so /help describes the whole bot; each is still handled by its own
module.
*/
describeLegacy([
    { name: "start", description: "Greeting / ping" },
    { name: "birthday", description: "Save a birthday reminder", args: "<date> <name> | list | delete <name>" },
    
    { name: "emojipedia", description: "Look up emoji artwork and metadata", args: "<emoji>" },
    // Telegram-exclusive - no WhatsApp equivalent
    { name: "shop", description: "Buy and equip game skins" },
    { name: "snake", description: "Play snake" },
    { name: "sokoban", description: "Play sokoban" },
    { name: "chess", description: "Play chess" },
    { name: "calculator", description: "Scientific calculator" },
    { name: "tictactoe", description: "Play tic-tac-toe" },
]);

const help = cmd("help", {
    aliases: ["h", "commands"],
    description: "List all available commands",
    args: "[command]",
}, async (ctx: Ctx) => {
    const commands = visibleCommands();

    if (ctx.hasArgs) {
        const wanted = ctx.args[0]!.replace(/^\//, "").toLowerCase();
        const found = commands.find(
            c => c.name === wanted || (c.aliases ?? []).includes(wanted)
        );

        if (!found) {
            await ctx.reply(`❌ No such command: ${wanted}\nTry /help for the full list.`);
            return;
        }

        const lines = [`<b>/${found.name}</b>`, "", escapeHtml(found.description), "", `<code>${escapeHtml(usageLine(found))}</code>`];
        if (found.aliases?.length) {
            lines.push("", `🪶 Aliases: ${found.aliases.map(a => `/${a}`).join(", ")}`);
        }
        if (found.usageHint) lines.push("", `<pre>${escapeHtml(found.usageHint)}</pre>`);

        await ctx.html(lines.join("\n"));
        return;
    }

    /*
    Sorted by name so the list is stable. Modules load from a directory listing,
    so without this the order would silently shuffle whenever a file was added.
    */
    const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
    const body = sorted
        .map(c => `• <code>${escapeHtml(usageLine(c))}</code>\n  ${escapeHtml(c.description)}`)
        .join("\n");

    await ctx.html(
        `🤖 <b>Available commands</b>\n\n${body}\n\n` +
        `💡 <code>/help &lt;command&gt;</code> for one in detail.`
    );
});

const debug = cmd("debug", {
    description: "Show chat/user ids and the health of the shared services",
    hidden: true,
}, async (ctx: Ctx) => {
    const lines = [
        `<b>Chat ID:</b> <code>${ctx.chatId}</code>`,
        `<b>User ID:</b> <code>${ctx.userId}</code>`,
        `<b>Chat type:</b> ${ctx.tg.chat.type}`,
    ];

    // Queue depth separates "nothing is sending" from "everything is queued"
    try {
        lines.push(`<b>Outbox queue:</b> ${await outboxDepth("telegram")} waiting`);
    } catch {
        lines.push(`<b>Outbox queue:</b> <i>unavailable</i>`);
    }

    lines.push(`<b>Postgres:</b> ${(await pingDatabase()) ? "✅ reachable" : "❌ unreachable"}`);

    const assets = checkAssets();
    lines.push(
        assets.ok
            ? "<b>Assets:</b> ✅ present"
            : `<b>Assets:</b> ⚠️ missing ${assets.missing.length} file(s)`
    );

    await ctx.html(lines.join("\n"));
});

export default feature("help", [help, debug]);
