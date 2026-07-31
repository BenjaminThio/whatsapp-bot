import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";
import { outboxDepth } from "../lib/outbox.js";

async function handleDebug(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext): Promise<void> {
    const lines = [
        `*Chat ID:* \`${ctx.chatId}\``,
        `*User ID:* \`${ctx.userId}\``,
        `*Group:* ${ctx.isGroup ? "yes" : "no"}`,
        `*Prefix used:* \`${ctx.prefix}\``,
    ];

    // Queue depth is the quickest way to tell "nothing is sending" apart from
    // "everything is sending but the socket is down".
    try {
        lines.push(`*Outbox queue:* ${await outboxDepth()} waiting`);
    } catch {
        lines.push(`*Outbox queue:* _unavailable_`);
    }

    await ctx.replyText(lines.join("\n"));
    await ctx.react("✅");
}

const command: Command = {
    name: "debug",
    description: "Show the resolved chat id, user id and outbox depth",
    usage: cmd("debug"),
    requiresArgs: false,
    handler: handleDebug,
};

export default command;
