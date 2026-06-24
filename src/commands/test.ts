import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import db from "../firebase.js";
import { loadCreds, saveCreds } from "../lib/hi-hive/creds.js";
import { handleAttendance } from "./attendance.js";

export interface StudentInfo
{
    id: string;
    email: string;
    encryptedData: string
}

async function handleTest(sock: WASocket, msg: WAMessage, text: string): Promise<void>
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
        console.log('Unexpected result...');
        return;
    }

    const params: string[] = extractParams(msg);
    const studentInfo: StudentInfo | undefined = await loadCreds(userId);

    switch (params.length)
    {
        case 0: {
            if (studentInfo === undefined)
            {
                sock.sendMessage(chatId, { text: 'Please fill up your personal info using `!test <Student ID> <Utar Email> <Encrypted Data>`' });
                return;
            }

            sock.sendMessage(chatId, { text: `Personal Info\nID: ${studentInfo.id}\nEmail: ${studentInfo.email}\nEcrypted Data: ${studentInfo.encryptedData}` });
            break;
        }
        case 1:
            switch (params[0])
            {
                case 'scan':
                case 'scn':
                case 'sc':
                case 's':
                    
                    break;
                case 'attendance':
                case 'att':
                case 'a':
                    break;
            }
            break;
        case 3: {
            const studentInfo: StudentInfo = {
                id: params[0],
                email: params[1],
                encryptedData: params[2]
            };

            await saveCreds(userId, studentInfo);

            sock.sendMessage(chatId, { text: `Personal Info\nID: ${studentInfo.id}\nEmail: ${studentInfo.email}\nEcrypted Data: ${studentInfo.encryptedData}` });
            break;
        }
        default:
            sock.sendMessage(chatId, { text: 'Invalid Format\nAcceptable Formats:\n!test <Student ID> <Utar Email> <Encrypted Data>\n!test s\n!test a' });
            break;
    }
}

function extractParams(msg: WAMessage): string[] {
    const m: any = msg.message?.ephemeralMessage?.message || msg.message;

    if (!m)
        return [];

    const raw: string =
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        "";

    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith('!test '))
        return trimmed.slice('!test '.length).trim().split(' ');
    else
        return [];
}

const command: Command = {
    name: 'test',
    description: 'To get remoteJid and participant value.',
    usage: 'Type !test',
    requiresArgs: true,
    handler: handleTest
};

export default command;