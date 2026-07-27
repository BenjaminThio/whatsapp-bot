import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { addAnonymousCreds, deleteCreds, exists, getAnonymousDocIds, getRelatedDocIds, loadCreds, looseLoadCreds, saveCreds } from "../lib/hi-hive/creds.js";
import { handleScanAttendance } from "./scan.js";
import { getAttendance } from "../lib/hi-hive/get-attendance.js";
import { formatAttendance } from "./attendance.js";
import { decryptData, generateEncryptedData } from "../lib/hi-hive/scan-qr.js";
import { addWhitelist, removeWhitelist, listWhitelist, getRankings } from "../lib/hi-hive/scan-buffer-db.js";
import { findIsolatedSessions, formatIsolated, slotsForDoc } from "../lib/hi-hive/timetable.js";
import { renderTimetablePng } from "../lib/hi-hive/visualise.js";

export interface Creds
{
    id: string;
    email: string;
    hidden: boolean;
    ownerId?: string;
}

const SUBCOMMANDS = ['scan', 'scn', 'sc', 'attendance', 'att', 'info', 'i', 'add', 'set', 'delete', 'del', 'd', 'list', 'l', 'help', 'h', 'token', 't', 'decrypt', 'whitelist', 'wl', 'isolated', 'iso', 'visualise', 'visualize', 'vis', 'v', 'rank', 'ranks', 'leaderboard', 'lb'] as const;
type Subcommand = typeof SUBCOMMANDS[number];
const ID_REGEX: RegExp = /^\d{7}$/;
const EMAIL_REGEX: RegExp = /^[a-zA-Z0-9._%+-]+@1utar\.my$/i;

function isSubcommand(value: string): value is Subcommand 
{
    return (SUBCOMMANDS as readonly string[]).includes(value);
}

const isIdValid = (id: string): boolean => ID_REGEX.test(id);
const isEmailValid = (email: string): boolean => EMAIL_REGEX.test(email);
const toBoolean = (s: string | undefined): boolean | undefined => {
    if (s === undefined)
        return false;
    if (s.toLowerCase() !== 'true' && s.toLowerCase() !== 'false')
        return undefined;
    return s.toLowerCase() === 'true'
};

async function handleTest(sock: WASocket, msg: WAMessage, _text: string): Promise<void>
{
    const [chatId, userId]: [string, string] = parseJid(msg);
    const params: string[] = extractParams(msg);

    function isCredsValid(id: string, email: string): boolean
    {
        let errors: string[] = [];

        if (!isIdValid(id))
        {
            errors.push(`❌ *Invalid Student ID*\n- Student ID consists of 7 digits.`);
        }
        if (!isEmailValid(email))
        {
            errors.push('❌ *Invalid Email*\n- Valid Email Example: `thioziliang123@1utar.my`');
        }

        sock.sendMessage(chatId, { text: errors.join('\n') });
        return errors.length === 0;
    }

    async function scanAttendanceQR(rawQrArg: string | undefined)
    {
        try
        {
            await handleScanAttendance(sock, msg, chatId, userId, rawQrArg);
        }
        catch (err: any)
        {
            console.error("Scan attendance error:", err);
            await sock.sendMessage(chatId, {
                text: `❌ Unexpected error: ${err?.message ?? err}`,
            }, { quoted: msg });
            await sock.sendMessage(chatId, {
                react: { text: "❌", key: msg.key },
            });
        }
    }

    function getInfo(creds: Creds | undefined, warning: string = ''): void
    {
        let info: string = warning;

        if (creds === undefined)
        {
            info += 'There is no creds set from you. Please fill up your personal info using `!test`.';
        }
        else
        {
            info += `👤 *Personal Info*\n🫆 Student ID: \`${creds.id}\`\n📧 Utar Email: \`${creds.email}\``;
        }

        sock.sendMessage(chatId, { text: info });
    }

    async function addCreds(id: string, email: string, hidden: boolean = false): Promise<void>
    {
        if (!isCredsValid(id, email))
            return;

        const newCreds: Creds = {
            id: id,
            email: email,
            hidden: hidden,
            ownerId: userId
        };
        const docRef = await addAnonymousCreds(newCreds);

        sock.sendMessage(chatId, { text: `👤 *Anonymous Credentials Added!*\n🫆 Student ID: \`${newCreds.id}\`\n📧 Utar Email: \`${newCreds.email}\`\n🆔 Doc ID: \`${docRef.id}\`` });
    }

    async function setCreds(id: string, email: string, hidden?: boolean, anonymousId: string | undefined = undefined): Promise<void>
    {
        if (!isCredsValid(id, email))
            return;

        const creds: Creds = {
            id: id,
            email: email,
            hidden: hidden ?? false
        };

        if (anonymousId !== undefined)
        {
            creds.ownerId = userId;
        }

        await saveCreds(anonymousId ?? userId, creds);

        sock.sendMessage(chatId, { text: `${ hidden === undefined ? '⚠️ *Warning:* Hidden value provided is incorrect, proceed fallback to `false`.\n\n' : '' }👤 *${anonymousId === undefined ? 'Personal' : 'Anonymous'} Info Set!*\n🫆 Student ID: \`${creds.id}\`\n📧 Utar Email: \`${creds.email}\`${anonymousId !== undefined ? `\n🆔 Doc ID: \`${anonymousId}\`` : ''}${creds.ownerId !== undefined ? `\n🌐 Onwer ID: \`${userId}\`` : ''}` });
    }

    async function getAttendanceReport(docId: string, courseFilter: string | undefined)
    {
        await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

        try {
            const result = await getAttendance(docId, { courseCode: courseFilter });

            if (result === undefined)
            {
                await sock.sendMessage(chatId, { text: 'Creds are not set. Please do !test for more info.' });
                return;
            }

            const reply = formatAttendance(result, courseFilter);

            await sock.sendMessage(chatId, { text: reply }, { quoted: msg });
            await sock.sendMessage(chatId, {
                react: { text: result.ok && !result.no_record ? "✅" : "❌", key: msg.key },
            });
            } catch (err: any) {
            console.error("!attendance error:", err);
            await sock.sendMessage(chatId, {
                text: `❌ Unexpected error: ${err?.message ?? err}`,
            }, { quoted: msg });
            await sock.sendMessage(chatId, { react: { text: "❌", key: msg.key } });
        }
    }

    /** Resolve a user-supplied id (doc id, student id or email) to a real doc id. */
    async function resolveDocId(input: string | undefined): Promise<string | undefined>
    {
        const key = (input ?? userId).trim();

        if (await exists(key))
            return key;

        const related: string[] = await getRelatedDocIds(key);
        return related.length > 0 ? related[0] : undefined;
    }

    async function deleteCredentials(docId: string)
    {
        const deletedCreds: Creds | undefined = await deleteCreds(docId);

        if (deletedCreds === undefined)
        {
            sock.sendMessage(chatId, { text: `${docId} not found! No creds deleted. ` });
        }
        else
        {
            sock.sendMessage(chatId, { text: `🚮 *Credentials Deleted!*\n🫆 Student Id: ${deletedCreds.id}\n📧 Utar Email: \`${deletedCreds.email}\`\n🆔 Doc ID: \`${docId}\`` });
        }
    }

    if (params.length === 0)
    {
        const creds: Creds | undefined = await loadCreds(userId);

        getInfo(creds);
    }
    else if (params.length >= 1)
    {
        if (isSubcommand(params[0]))
        {
            const subcommand: Subcommand = params[0];

            switch (subcommand)
            {
                case 'scan':
                case 'scn':
                case 'sc':
                {
                    switch (params.length)
                    {
                        case 1:
                        case 2:
                        {
                            const rawQr: string | undefined = params[1];

                            scanAttendanceQR(rawQr);
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test <scan | scn | sc>\n- !test <scan | scn | sc> <Raw QR>' });
                        }
                    }
                    break;
                }
                case 'attendance':
                case 'att':
                {
                    switch (params.length)
                    {
                        case 1:
                        {
                            getAttendanceReport(userId, undefined);
                            break;
                        }
                        case 2:
                        {
                            const inputDocId: string = params[1];

                            if (await exists(inputDocId))
                            {
                                getAttendanceReport(inputDocId, undefined);
                            }
                            else
                            {
                                const relatedDocIds: string[] = await getRelatedDocIds(inputDocId);

                                if (relatedDocIds.length > 0)
                                    getAttendanceReport(relatedDocIds[0], undefined);
                                else
                                    sock.sendMessage(chatId, { text: `\`${inputDocId}\` not found!` })
                            }
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test <attendance | att>\n- !test <attendance | att> <Creds Doc Ref ID>' });
                        }
                    }
                    break;
                }
                // Get current user info.
                case 'info':
                case 'i':
                {
                    switch (params.length)
                    {
                        case 1:
                        case 2:
                        {
                            const docId: string = params[1] === undefined ? userId : params[1];
                            const creds: Creds | undefined = await looseLoadCreds(docId);

                            if (creds === undefined)
                                sock.sendMessage(chatId, { text: `\`${docId}\` not found!` });
                            else
                                getInfo(creds);
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test <info | i>\n- !test <info | i> <Creds Doc Ref ID>' })
                        }
                    }
                    break;
                }
                // Add anonymous credential just for auto scan feature.
                case 'add':
                {
                    switch (params.length)
                    {
                        case 3:
                        case 4:
                        {
                            const [id, email, hidden]: [string, string, string | undefined] = [params[1], params[2], params[3]];

                            addCreds(id, email, toBoolean(hidden));
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Format*\n- !test add <Student ID> <Utar Email>\n- !test add <Student ID> <Utar Email> <isHidden (true/false)>' });
                        }
                    }
                    break;
                }
                case 'set':
                {
                    switch (params.length)
                    {
                        case 3:
                        {
                            const [id, email] = [params[1], params[2]];

                            setCreds(id, email);
                            break;
                        }
                        case 4:
                        {
                            if (EMAIL_REGEX.test(params[3]))
                            {
                                const [anonymousId, id, email] = [params[1], params[2], params[3]];

                                setCreds(id, email, false, anonymousId);
                            }
                            else
                            {
                                const [id, email, hidden] = [params[1], params[2], params[3]];

                                setCreds(id, email, toBoolean(hidden));
                            }
                            break;
                        }
                        case 5:
                        {
                            const [anonymousId, id, email, hidden] = [params[1], params[2], params[3], params[4]];

                            setCreds(id, email, toBoolean(hidden), anonymousId);
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test set <Student ID> <Utar Email>\n- !test set <Creds Doc Ref ID> <Student ID> <Utar Email>\n- !test set <Student ID> <Utar Email> <isHidden (true/false)>\n- !test set <Creds Doc Ref ID> <Student ID> <Utar Email> <isHidden (true/false)>' });
                        }
                    }
                    break;
                }
                case 'delete':
                case 'del':
                case 'd':
                {
                    switch (params.length)
                    {
                        case 1:
                        case 2:
                        {
                            const docId: string = params[1] === undefined ? userId : params[1];

                            deleteCredentials(docId);
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test <delete | del | d>\n- !test <delete | del | d> <Creds Doc Ref ID>' });
                        }
                    }
                    break;
                }
                case "list":
                case "l":
                {
                    const anonymousDocIds: string[] = await getAnonymousDocIds(userId);

                    sock.sendMessage(chatId, { text: `📁 *Owned Anonymous Docs*\n${
                        anonymousDocIds.length > 0 ?
                            anonymousDocIds.map((docId: string, idx: number) => `${idx + 1}. \`${docId}\``).join('\n')
                            :
                            'No registered anonymous docs.'
                    }`})
                    break;
                }
                case "help":
                case "h":
                {
                    const allSubcommandFormats: string[] = [
                        '- !test <scan | scn | sc>',
                        '- !test <scan | scn | sc> <Raw QR>',
                        '- !test <attendance | att>',
                        '- !test <attendance | att> <Creds Doc Ref ID>',
                        '- !test <info | i>',
                        '- !test <info | i> <Creds Doc Ref ID>',
                        '- !test add <Student ID> <Utar Email>',
                        '- !test add <Student ID> <Utar Email> <isHidden (true/false)>',
                        '- !test set <Student ID> <Utar Email>',
                        '- !test set <Creds Doc Ref ID> <Student ID> <Utar Email>',
                        '- !test set <Student ID> <Utar Email> <isHidden (true/false)>',
                        '- !test set <Creds Doc Ref ID> <Student ID> <Utar Email> <isHidden (true/false)>',
                        '- !test <delete | del | d>',
                        '- !test <delete | del | d> <Creds Doc Ref ID>',
                        '- !test <list | l>',
                        '- !test <help | h>',
                        '- !test <token | t>',
                        '- !test <whitelist | wl>',
                        '- !test <whitelist | wl> list',
                        '- !test <whitelist | wl> remove [Group JID]',
                        '- !test <isolated | iso> [Student ID | Doc ID]',
                        '- !test <visualise | vis | v> [Student ID | Doc ID]',
                        '- !test <rank | leaderboard | lb>'
                    ];

                    sock.sendMessage(chatId, { text: `*All Valid Formats*\n${allSubcommandFormats.join('\n')}` });
                    break;
                }
                case "decrypt":
                {
                    switch (params.length)
                    {
                        case 2:
                        {
                            const token: string = params[1];

                            if (token === undefined)
                                sock.sendMessage(chatId, { text: `\`${token}\` is undefined.` });
                            else
                                sock.sendMessage(chatId, { text: `*Decrypted Data:* \n\`${JSON.stringify(decryptData(token))}\`` });
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Format*\n- !test decrypt <Token>' })
                        }
                    }
                    break;
                }
                case 'token':
                case 't':
                    switch (params.length)
                    {
                        case 1:
                        case 2:
                        {
                            const docId: string = params[1] === undefined ? userId : params[1];
                            const creds: Creds | undefined = await loadCreds(docId);

                            if (creds === undefined)
                                sock.sendMessage(chatId, { text: `\`${docId}\` not found!` });
                            else
                                sock.sendMessage(chatId, { text: `🪙 *Fresh Generated Token:* \n\`${generateEncryptedData(creds.id, creds.email)}\`` });
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Format*\n- !test <token | t>' })
                        }
                    }
                    break;
                case 'whitelist':
                case 'wl':
                {
                    const action: string = (params[1] ?? '').toLowerCase();

                    if (action === 'remove' || action === 'rm')
                    {
                        const target: string = params[2] ?? chatId;
                        const removed: boolean = await removeWhitelist(target);

                        sock.sendMessage(chatId, { text: removed
                            ? `🗑️ *Removed from whitelist*\n🆔 \`${target}\``
                            : `❔ That chat was not whitelisted.\n🆔 \`${target}\`` });
                    }
                    else if (action === 'list' || action === 'l')
                    {
                        const rows = await listWhitelist();

                        sock.sendMessage(chatId, { text: rows.length > 0
                            ? `✅ *Whitelisted Groups*\n${rows.map((r, i) => `${i + 1}. \`${r.jid}\``).join('\n')}`
                            : '📭 No groups are whitelisted yet.' });
                    }
                    else
                    {
                        const added: boolean = await addWhitelist(chatId, userId);

                        sock.sendMessage(chatId, { text: added
                            ? `✅ *Auto-scan enabled for this chat!*\n🆔 \`${chatId}\`\n\n_QR codes sent here will now be scanned automatically._`
                            : `ℹ️ This chat is already whitelisted.\n🆔 \`${chatId}\`` });
                    }
                    break;
                }
                case 'isolated':
                case 'iso':
                {
                    switch (params.length)
                    {
                        case 1:
                        case 2:
                        {
                            const docId: string | undefined = await resolveDocId(params[1]);

                            if (docId === undefined)
                            {
                                sock.sendMessage(chatId, { text: `\`${params[1] ?? userId}\` not found!` });
                                break;
                            }

                            await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });
                            await sock.sendMessage(chatId, { text: '🔎 Comparing timetables across all registered students...' });

                            const creds: Creds | undefined = await loadCreds(docId);
                            const label: string = creds ? (creds.hidden ? '*'.repeat(creds.id.length) : creds.id) : docId;
                            const result = await findIsolatedSessions(docId, label);

                            if ('error' in result)
                            {
                                await sock.sendMessage(chatId, { text: `❌ ${result.error}` }, { quoted: msg });
                                await sock.sendMessage(chatId, { react: { text: "❌", key: msg.key } });
                                break;
                            }

                            await sock.sendMessage(chatId, { text: formatIsolated(result) }, { quoted: msg });
                            await sock.sendMessage(chatId, { react: { text: "✅", key: msg.key } });
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test <isolated | iso>\n- !test <isolated | iso> <Student ID | Doc ID>' });
                        }
                    }
                    break;
                }
                case 'visualise':
                case 'visualize':
                case 'vis':
                case 'v':
                {
                    switch (params.length)
                    {
                        case 1:
                        case 2:
                        {
                            const docId: string | undefined = await resolveDocId(params[1]);

                            if (docId === undefined)
                            {
                                sock.sendMessage(chatId, { text: `\`${params[1] ?? userId}\` not found!` });
                                break;
                            }

                            await sock.sendMessage(chatId, { react: { text: "⏳", key: msg.key } });

                            try
                            {
                                const slots = await slotsForDoc(docId);

                                if (slots === null)
                                {
                                    await sock.sendMessage(chatId, { text: '❌ Could not load this student\'s attendance.' }, { quoted: msg });
                                    await sock.sendMessage(chatId, { react: { text: "❌", key: msg.key } });
                                    break;
                                }
                                if (slots.length === 0)
                                {
                                    await sock.sendMessage(chatId, { text: '📭 No attendance history yet — a timetable cannot be drawn.' }, { quoted: msg });
                                    await sock.sendMessage(chatId, { react: { text: "❌", key: msg.key } });
                                    break;
                                }

                                const creds: Creds | undefined = await loadCreds(docId);
                                const label: string = creds ? (creds.hidden ? '*'.repeat(creds.id.length) : creds.id) : docId;
                                const courses: number = new Set(slots.map(s => s.courseCode)).size;

                                const png: Buffer = await renderTimetablePng(
                                    slots,
                                    `Timetable — ${label}`,
                                    `${slots.length} sessions · ${courses} courses`
                                );

                                await sock.sendMessage(chatId, {
                                    image: png,
                                    caption: `🗓️ *Timetable — \`${label}\`*\n${slots.length} weekly sessions across ${courses} courses.`,
                                    mimetype: 'image/png'
                                }, { quoted: msg });
                                await sock.sendMessage(chatId, { react: { text: "✅", key: msg.key } });
                            }
                            catch (err: any)
                            {
                                console.error('!test visualise error:', err);
                                await sock.sendMessage(chatId, { text: `❌ Failed to render timetable: ${err?.message ?? err}` }, { quoted: msg });
                                await sock.sendMessage(chatId, { react: { text: "❌", key: msg.key } });
                            }
                            break;
                        }
                        default:
                        {
                            sock.sendMessage(chatId, { text: '*Valid Formats*\n- !test <visualise | vis | v>\n- !test <visualise | vis | v> <Student ID | Doc ID>' });
                        }
                    }
                    break;
                }
                case 'rank':
                case 'ranks':
                case 'leaderboard':
                case 'lb':
                {
                    const rows = await getRankings(25);

                    if (rows.length === 0)
                    {
                        sock.sendMessage(chatId, { text: '📭 No QR contributions recorded yet.' });
                        break;
                    }

                    const medal = (i: number): string =>
                        i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

                    const total: number = rows.reduce((sum, r) => sum + r.contributions, 0);

                    const lines: string[] = rows.map((r, i) => {
                        const name: string = r.hidden ? 'Hidden User' : r.studentId;
                        const share: string = ((r.contributions / total) * 100).toFixed(0);
                        return `${medal(i)} \`${name}\` — *${r.contributions}* QR${r.contributions === 1 ? '' : 's'} _(${share}%)_`;
                    });

                    sock.sendMessage(chatId, { text:
                        `🏆 *QR CONTRIBUTION RANKING*\n_Who supplies the QR codes everyone scans._\n\n` +
                        `${lines.join('\n')}\n\n` +
                        `📊 ${total} QR${total === 1 ? '' : 's'} contributed by ${rows.length} student${rows.length === 1 ? '' : 's'}.`
                    });
                    break;
                }
                default:
                {
                    sock.sendMessage(chatId, { text: 'Subcommand not found!' })
                }
            }
        }
        else if (params.length === 2)
        {
            setCreds(params[0], params[1]);
        }
        else if (params.length === 3)
        {
            setCreds(params[0], params[1], toBoolean(params[2]));
        }
        else
        {
            sock.sendMessage(chatId, { text: 'Subcommand not found!' });
        }
    }
    else
    {
        sock.sendMessage(chatId, { text: 'Invalid format!' });
    }
}

function parseJid(msg: WAMessage): [string, string]
{
    let [chatId, userId]: [string, string] = ['', ''];

    if (!msg.key.remoteJid)
    {
        return [chatId, userId];
    }
    else if (!msg.key.participant && msg.key.remoteJid.endsWith('@lid'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.remoteJid;
    }
    else if (msg.key.participant && msg.key.remoteJid.endsWith('@g.us'))
    {
        chatId = msg.key.remoteJid;
        userId = msg.key.participant;
    }
    else if (!msg.key.participant)
    {
        // Plain DM (@s.whatsapp.net) — treat the chat as the user
        chatId = msg.key.remoteJid;
        userId = msg.key.remoteJid;
    }

    return [chatId, userId];
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
    description: ':D',
    usage: '!test',
    requiresArgs: true,
    handler: handleTest
};

export default command;