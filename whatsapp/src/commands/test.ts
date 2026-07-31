import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { addAnonymousCreds, deleteCreds, exists, getAnonymousDocIds, getRelatedDocIds, loadCreds, looseLoadCreds, saveCreds } from "../../../shared/hi-hive/creds.js";
import { handleScanAttendance } from "./scan.js";
import { sendAttendanceReport } from "./attendance.js";
import { decryptData, generateEncryptedData } from "../../../shared/hi-hive/scan-qr.js";
import { addWhitelist, removeWhitelist, listWhitelist, getRankings } from "../../../shared/hi-hive/scan-buffer-db.js";
import { findIsolatedSessions, formatIsolated, slotsForDoc } from "../../../shared/hi-hive/timetable.js";
import { renderTimetablePng } from "../../../shared/hi-hive/visualise.js";
import { cmd } from "../config/prefixes.js";

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

/*
Every accepted call shape, in one table.

The `help` subcommand used to hold a second, hand-maintained copy of this list,
which had already drifted from the per-subcommand error messages. Both are now
generated from here, so adding a form updates the error text and the help at
once - and all of them follow the configured prefix.
*/
const T = cmd('test');

const FORMATS = {
    scan:       [`${T} <scan | scn | sc>`, `${T} <scan | scn | sc> <Raw QR>`],
    attendance: [`${T} <attendance | att>`, `${T} <attendance | att> <Creds Doc Ref ID>`],
    info:       [`${T} <info | i>`, `${T} <info | i> <Creds Doc Ref ID>`],
    add:        [`${T} add <Student ID> <Utar Email>`, `${T} add <Student ID> <Utar Email> <isHidden (true/false)>`],
    set:        [
        `${T} set <Student ID> <Utar Email>`,
        `${T} set <Creds Doc Ref ID> <Student ID> <Utar Email>`,
        `${T} set <Student ID> <Utar Email> <isHidden (true/false)>`,
        `${T} set <Creds Doc Ref ID> <Student ID> <Utar Email> <isHidden (true/false)>`,
    ],
    delete:     [`${T} <delete | del | d>`, `${T} <delete | del | d> <Creds Doc Ref ID>`],
    list:       [`${T} <list | l>`],
    help:       [`${T} <help | h>`],
    token:      [`${T} <token | t>`, `${T} <token | t> <Creds Doc Ref ID>`],
    decrypt:    [`${T} decrypt <Token>`],
    whitelist:  [`${T} <whitelist | wl>`, `${T} <whitelist | wl> list`, `${T} <whitelist | wl> remove [Group JID]`],
    isolated:   [`${T} <isolated | iso> [Student ID | Doc ID]`],
    visualise:  [`${T} <visualise | vis | v> [Student ID | Doc ID]`],
    rank:       [`${T} <rank | leaderboard | lb>`],
} satisfies Record<string, string[]>;

const bullets = (forms: string[]): string => forms.map(f => `- ${f}`).join('\n');

/** "*Valid Formats*" block for one subcommand. */
const formatsFor = (key: keyof typeof FORMATS): string =>
    `*Valid Format${FORMATS[key].length === 1 ? '' : 's'}*\n${bullets(FORMATS[key])}`;

const allFormats = (): string =>
    `*All Valid Formats*\n${bullets(Object.values(FORMATS).flat())}`;

const isIdValid = (id: string): boolean => ID_REGEX.test(id);
const isEmailValid = (email: string): boolean => EMAIL_REGEX.test(email);
const toBoolean = (s: string | undefined): boolean | undefined => {
    if (s === undefined)
        return false;
    if (s.toLowerCase() !== 'true' && s.toLowerCase() !== 'false')
        return undefined;
    return s.toLowerCase() === 'true'
};

async function handleTest(sock: WASocket, msg: WAMessage, _text: string, ctx: CommandContext): Promise<void>
{
    const chatId: string = ctx.chatId;
    const userId: string = ctx.userId;
    const params: string[] = ctx.args;

    // Every reply in this command goes through the outbox
    const say = (text: string) => ctx.sendText(text);

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

        if (errors.length > 0)
            say(errors.join('\n'));
        return errors.length === 0;
    }

    async function scanAttendanceQR(rawQrArg: string | undefined)
    {
        try
        {
            await handleScanAttendance(sock, msg, chatId, userId, rawQrArg, ctx);
        }
        catch (err: any)
        {
            console.error("Scan attendance error:", err);
            await ctx.replyText(`❌ Unexpected error: ${err?.message ?? err}`);
            await ctx.react("❌");
        }
    }

    function getInfo(creds: Creds | undefined, warning: string = ''): void
    {
        let info: string = warning;

        if (creds === undefined)
        {
            info += `There is no creds set from you. Please fill up your personal info using \`${cmd('test')}\`.`;
        }
        else
        {
            info += `👤 *Personal Info*\n🫆 Student ID: \`${creds.id}\`\n📧 Utar Email: \`${creds.email}\``;
        }

        say(info);
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

        say(`👤 *Anonymous Credentials Added!*\n🫆 Student ID: \`${newCreds.id}\`\n📧 Utar Email: \`${newCreds.email}\`\n🆔 Doc ID: \`${docRef.id}\``);
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

        say(`${ hidden === undefined ? '⚠️ *Warning:* Hidden value provided is incorrect, proceed fallback to `false`.\n\n' : '' }👤 *${anonymousId === undefined ? 'Personal' : 'Anonymous'} Info Set!*\n🫆 Student ID: \`${creds.id}\`\n📧 Utar Email: \`${creds.email}\`${anonymousId !== undefined ? `\n🆔 Doc ID: \`${anonymousId}\`` : ''}${creds.ownerId !== undefined ? `\n🌐 Owner ID: \`${userId}\`` : ''}`);
    }

    // Delegates to the same routine !attendance uses - this used to be a copy
    const getAttendanceReport = (docId: string, courseFilter: string | undefined) =>
        sendAttendanceReport(docId, chatId, msg, courseFilter);

    /** Resolve a user-supplied id (doc id, student id or email) to a real doc id. */
    async function resolveDocId(input: string | undefined): Promise<string | undefined>
    {
        const key = (input ?? userId).trim();

        if (await exists(key))
            return key;

        const related: string[] = await getRelatedDocIds(key);
        return related.length > 0 ? related[0] : undefined;
    }

    /** Masked display name for a doc, falling back to the doc id. */
    async function labelFor(docId: string): Promise<string>
    {
        const creds: Creds | undefined = await loadCreds(docId);
        if (!creds) return docId;
        return creds.hidden ? '*'.repeat(creds.id.length) : creds.id;
    }

    async function deleteCredentials(docId: string)
    {
        const deletedCreds: Creds | undefined = await deleteCreds(docId);

        if (deletedCreds === undefined)
        {
            say(`${docId} not found! No creds deleted. `);
        }
        else
        {
            say(`🚮 *Credentials Deleted!*\n🫆 Student Id: ${deletedCreds.id}\n📧 Utar Email: \`${deletedCreds.email}\`\n🆔 Doc ID: \`${docId}\``);
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
                            say(formatsFor('scan'));
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
                                    say(`\`${inputDocId}\` not found!`);
                            }
                            break;
                        }
                        default:
                        {
                            say(formatsFor('attendance'));
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
                                say(`\`${docId}\` not found!`);
                            else
                                getInfo(creds);
                            break;
                        }
                        default:
                        {
                            say(formatsFor('info'));
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
                            say(formatsFor('add'));
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
                            say(formatsFor('set'));
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
                            say(formatsFor('delete'));
                        }
                    }
                    break;
                }
                case "list":
                case "l":
                {
                    const anonymousDocIds: string[] = await getAnonymousDocIds(userId);

                    say(`📁 *Owned Anonymous Docs*\n${
                        anonymousDocIds.length > 0 ?
                            anonymousDocIds.map((docId: string, idx: number) => `${idx + 1}. \`${docId}\``).join('\n')
                            :
                            'No registered anonymous docs.'
                    }`);
                    break;
                }
                case "help":
                case "h":
                {
                    say(allFormats());
                    break;
                }
                case "decrypt":
                {
                    switch (params.length)
                    {
                        case 2:
                        {
                            say(`*Decrypted Data:* \n\`${JSON.stringify(decryptData(params[1]))}\``);
                            break;
                        }
                        default:
                        {
                            say(formatsFor('decrypt'));
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
                                say(`\`${docId}\` not found!`);
                            else
                                say(`🪙 *Fresh Generated Token:* \n\`${generateEncryptedData(creds.id, creds.email)}\``);
                            break;
                        }
                        default:
                        {
                            say(formatsFor('token'));
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

                        say(removed
                            ? `🗑️ *Removed from whitelist*\n🆔 \`${target}\``
                            : `❔ That chat was not whitelisted.\n🆔 \`${target}\``);
                    }
                    else if (action === 'list' || action === 'l')
                    {
                        const rows = await listWhitelist();

                        say(rows.length > 0
                            ? `✅ *Whitelisted Groups*\n${rows.map((r, i) => `${i + 1}. \`${r.jid}\``).join('\n')}`
                            : '📭 No groups are whitelisted yet.');
                    }
                    else
                    {
                        const added: boolean = await addWhitelist(chatId, userId);

                        say(added
                            ? `✅ *Auto-scan enabled for this chat!*\n🆔 \`${chatId}\`\n\n_QR codes sent here will now be scanned automatically._`
                            : `ℹ️ This chat is already whitelisted.\n🆔 \`${chatId}\``);
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
                                say(`\`${params[1] ?? userId}\` not found!`);
                                break;
                            }

                            await ctx.react("⏳");
                            await say('🔎 Comparing timetables across all registered students...');

                            const result = await findIsolatedSessions(docId, await labelFor(docId));

                            if ('error' in result)
                            {
                                await ctx.replyText(`❌ ${result.error}`);
                                await ctx.react("❌");
                                break;
                            }

                            await ctx.replyText(formatIsolated(result));
                            await ctx.react("✅");
                            break;
                        }
                        default:
                        {
                            say(formatsFor('isolated'));
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
                                say(`\`${params[1] ?? userId}\` not found!`);
                                break;
                            }

                            await ctx.react("⏳");

                            try
                            {
                                const slots = await slotsForDoc(docId);

                                if (slots === null || slots.length === 0)
                                {
                                    await ctx.replyText(slots === null
                                        ? '❌ Could not load this student\'s attendance.'
                                        : '📭 No attendance history yet - a timetable cannot be drawn.');
                                    await ctx.react("❌");
                                    break;
                                }

                                const label: string = await labelFor(docId);
                                const courses: number = new Set(slots.map(s => s.courseCode)).size;

                                const png: Buffer = await renderTimetablePng(
                                    slots,
                                    `Timetable - ${label}`,
                                    `${slots.length} sessions · ${courses} courses`
                                );

                                await ctx.reply({
                                    image: png,
                                    caption: `🗓️ *Timetable - \`${label}\`*\n${slots.length} weekly sessions across ${courses} courses.`,
                                    mimetype: 'image/png'
                                });
                                await ctx.react("✅");
                            }
                            catch (err: any)
                            {
                                console.error('!test visualise error:', err);
                                await ctx.replyText(`❌ Failed to render timetable: ${err?.message ?? err}`);
                                await ctx.react("❌");
                            }
                            break;
                        }
                        default:
                        {
                            say(formatsFor('visualise'));
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
                        say('📭 No QR contributions recorded yet.');
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

                    say(
                        `🏆 *QR CONTRIBUTION RANKING*\n_Who supplies the QR codes everyone scans._\n\n` +
                        `${lines.join('\n')}\n\n` +
                        `📊 ${total} QR${total === 1 ? '' : 's'} contributed by ${rows.length} student${rows.length === 1 ? '' : 's'}.`
                    );
                    break;
                }
                default:
                {
                    say('Subcommand not found!');
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
            say(`Subcommand not found! Try \`${cmd('test help')}\`.`);
        }
    }
}

const command: Command = {
    name: 'test',
    description: 'Manage hi-hive credentials, whitelists, timetables and rankings',
    usage: `${T} <subcommand> [args...]`,
    usageHint: allFormats(),
    // Bare `!test` shows your own stored info, so no arguments are required
    requiresArgs: false,
    handler: handleTest
};

export default command;