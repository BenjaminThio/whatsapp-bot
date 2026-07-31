import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { cmd } from "../config/prefixes.js";

async function handleStart(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    await ctx.sendText("Hello Mum!");
}

const command: Command = {
    name: "start",
    description: "Greeting / ping",
    usage: cmd("start"),
    handler: handleStart,
};

export default command;
