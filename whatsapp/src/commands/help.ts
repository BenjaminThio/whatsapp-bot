import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { getVisibleCommands, commandByName } from "../loader.js";
import { cmd, commandPrefixes, primaryPrefix } from "../config/prefixes.js";
import { ignoreWords } from "../config/scan-ignore.js";

function describe(c: Command): string {
    const aliasPart = c.aliases && c.aliases.length > 0
        ? `  (aliases: ${c.aliases.map(a => primaryPrefix() + a).join(", ")})`
        : "";
    return `• \`${c.usage}\`${aliasPart}\n  ${c.description}`;
}

function detail(c: Command): string {
    const lines = [`📖 *${primaryPrefix()}${c.name}*`, "", c.description, "", `\`${c.usage}\``];
    if (c.aliases?.length) {
        lines.push("", `🪶 Aliases: ${c.aliases.map(a => `\`${primaryPrefix()}${a}\``).join(", ")}`);
    }
    if (c.usageHint) lines.push("", c.usageHint);
    return lines.join("\n");
}

function footer(): string {
    const prefixes = commandPrefixes().map(p => `\`${p}\``).join(" or ");
    return [
        "",
        "─".repeat(30),
        `🔣 Prefixes: ${prefixes} - both work everywhere.`,
        `🚫 Add \`${cmd(ignoreWords()[0])}\` to an image caption to stop the QR scanner reading it.`,
        `💡 \`${cmd("help")} <command>\` for one command in detail.`,
    ].join("\n");
}

async function handleHelp(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    // !help <command> - detail for a single command
    if (ctx.hasArgs) {
        const wanted = commandByName(ctx.args[0].replace(/^\W+/, ""));
        if (!wanted) {
            await ctx.replyText(`❌ No such command: \`${ctx.args[0]}\`\nTry \`${cmd("help")}\` for the full list.`);
            return;
        }
        await ctx.replyText(detail(wanted));
        return;
    }

    const commands = getVisibleCommands();
    const lines = ["🤖 *Available commands:*\n", ...commands.map(describe)];
    await ctx.replyText(lines.join("\n\n") + "\n" + footer());
}

const command: Command = {
    name: "help",
    aliases: ["h", "commands"],
    description: "List all available commands",
    usage: `${cmd("help")} [command]`,
    handler: handleHelp,
};

export default command;
