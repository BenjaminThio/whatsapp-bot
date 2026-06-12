import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { getAllCommands } from "../loader.js";

async function handleHelp(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;

    const commands = getAllCommands();
    const lines = ["🤖 *Available commands:*\n"];

    for (const cmd of commands) {
        const aliasPart = cmd.aliases && cmd.aliases.length > 0
            ? `  (aliases: ${cmd.aliases.map((a: any) => `!${a}`).join(", ")})`
            : "";
        lines.push(`• \`${cmd.usage}\`${aliasPart}\n  ${cmd.description}`);
    }

    await sock.sendMessage(msg.key.remoteJid, { text: lines.join("\n\n") }, { quoted: msg });
}

const command: Command = {
    name: "help",
    aliases: ["h", "commands"],
    description: "List all available commands",
    usage: "!help",
    handler: handleHelp,
};

export default command;