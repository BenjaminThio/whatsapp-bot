import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";

async function handleDebug(sock: WASocket, msg: WAMessage, _text: string): Promise<void>
{
    if (!msg.key.remoteJid) return;

    let chatId: string = '';
    let userId: string = '';

    if (!msg.key.participant && msg.key.remoteJid.endsWith('@lid'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.remoteJid;
    }
    else if (msg.key.participant && msg.key.remoteJid.endsWith('@g.us'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.participant;
    }
    else
    {
        sock.sendMessage(chatId, { text: 'Unexpected result...' });
        return;
    }

    sock.sendMessage(chatId, { text: `*Chat ID:* \`${chatId}\`\n*User ID:* \`${userId}\`` }, { quoted: msg });
    sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } });
}

const command: Command = {
    name: 'debug',
    description: 'To get remoteJid and participant value.',
    usage: '!debug',
    requiresArgs: true,
    handler: handleDebug
};

export default command;