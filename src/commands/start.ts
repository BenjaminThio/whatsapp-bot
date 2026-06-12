import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";

async function handleStart(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;
    await sock.sendMessage(msg.key.remoteJid, { text: "Hello Mum!" });
}

const command: Command = {
    name: "start",
    description: "Greeting / ping",
    usage: "!start",
    handler: handleStart,
};

export default command;