/**
 * index.ts - relasma/src/hi-hive/index.ts
 *
 * The UTAR attendance suite, ported from the WhatsApp bot:
 *
 *   /attendance [course]      - your attendance report
 *   /scan [raw_qr]            - submit a QR (from an image, or pasted)
 *   /decode [raw_qr]          - inspect a QR offline, no server call
 *   /genqr <type> <args...>   - build an encrypted attendance QR
 *   /refresh                  - re-login for a fresh sessionId
 *   /hihive <sub> [args...]   - manage credentials, whitelist, rankings
 *
 * Plus auto-scanning: any photo posted in a chat is checked for an attendance
 * QR. Caption it /ignore to opt an image out.
 *
 * Credentials live in the SAME hi_hive table as the WhatsApp bot, so an account
 * registered on either bot is scanned by both.
 */

import { InputFile } from "grammy";
import { Composer, Context } from "grammy";
import { cmd, feature, escapeHtml, type Ctx } from "../lib/command.js";
import { findImage, downloadMedia, formatBytes } from "../lib/media.js";
import { readQrCode, readQrCodes, isAttendanceQr, createQrImage, QR_SEPARATOR, VALID_QR_TYPES, type QrType } from "../../../shared/lib/qr.js";
import { scanQr, decryptData, generateEncryptedData } from "../../../shared/hi-hive/scan-qr.js";
import { getAttendance } from "../../../shared/hi-hive/get-attendance.js";
import { decodeQr } from "../../../shared/hi-hive/legacy/decode-qr.js";
import { loadCreds as loadLegacyCreds } from "../../../shared/hi-hive/legacy/creds.js";
import { aesEncrypt } from "../../../shared/hi-hive/legacy/crypto.js";
import { refreshToken } from "../../../shared/hi-hive/legacy/refresh-token.js";
import {
    addAnonymousCreds, deleteCreds, exists, getAnonymousDocIds,
    getRelatedDocIds, loadCreds, looseLoadCreds, saveCreds, getAllDocs,
    resolveDocId as resolveDocIdShared, resolveOwnDocId,
} from "../../../shared/hi-hive/creds.js";
import {
    addWhitelist, removeWhitelist, listWhitelist,
    enqueueBatch, newId as newBufferId,
} from "../../../shared/hi-hive/scan-buffer-db.js";
import { creditContribution, getLeaderboard, leaderLabel } from "../../../shared/hi-hive/contributions.js";
import { findIsolatedSessions, formatIsolated, slotsForDoc } from "../../../shared/hi-hive/timetable.js";
import {
    bindToExisting, bindNew, unbind, bindingsFor, formatBindings, parseBool,
} from "../../../shared/hi-hive/bind.js";
import { rememberIdentity, labelFor as rankLabel } from "../../../shared/hi-hive/identity.js";
import { noteSpoke } from "../../../shared/messaging/directory.js";
import { renderTimetablePng } from "../../../shared/hi-hive/visualise.js";
import { randomDelaySec, formatWaitingNoticeGrouped } from "../../../shared/hi-hive/scan-buffer.js";
import type { Destination } from "../../../shared/hi-hive/destinations.js";
import type { Creds, ScanQrResult, GetAttendanceResult, AttendanceCourse } from "../../../shared/hi-hive/types.js";
import { alreadyProcessed, react } from "../../../shared/messaging/outbox.js";
import { isScanIgnored } from "../lib/scan-ignore.js";
import { truncate } from "../../../shared/lib/text.js";
import { fetchImageBuffer } from "../../../shared/lib/http.js";

const TRANSPORT = "telegram" as const;
const MAX_TG_TEXT = 4000;

const ID_REGEX = /^\d{7}$/;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@1utar\.my$/i;

/*
The caller's own credentials doc.

Their Telegram user id is the doc id until they bind that id to an existing doc
- typically the one their WhatsApp account already uses. After that, both
platforms resolve to the same credentials and the same contribution count.
*/
const ownDocId = (ctx: Ctx): Promise<string> => resolveOwnDocId(String(ctx.userId));

// ── Formatting (shared shape with the WhatsApp bot, plain text for Telegram) ──

const EXPIRY_EMOJI: Record<string, string> = {
    in_window: "✅", too_early: "⏳", expired: "⚠️", unknown: "❓",
};

function formatScanResult(result: ScanQrResult): string {
    const lines: string[] = [];

    if (result.expiry) {
        lines.push(`${EXPIRY_EMOJI[result.expiry.verdict] ?? "❓"} Pre-check: ${result.expiry.reason}`, "");
    }

    if (result.ok) {
        lines.push(`✅ ${result.message}`);
        if (result.courseCode) lines.push(`📚 Course: ${result.courseCode}`);
        return lines.join("\n");
    }

    const HINTS: Record<string, [string, string?]> = {
        rejected: ["❌ Not Marked"],
        token_expired: ["🔐 Session Expired", "💡 Update your token, or run /refresh."],
        scanner_page: ["⏱️ Scanner Page Returned", "💡 GPS may be wrong, or the QR window has passed."],
        invalid_qr: ["❌ Invalid QR"],
        auth_error: ["🔐 Auth / Server Error", "💡 Check your student id and email with /hihive info."],
        network_error: ["🌐 Network Error"],
        unreadable: ["⚠️ Unreadable Response"],
    };

    const [title, hint] = HINTS[result.status] ?? [`⚠️ Unknown status: ${result.status}`];
    lines.push(title, result.message);
    if (hint) lines.push("", hint);
    return lines.join("\n");
}

const PCT_BAR_LEN = 10;

function pctBar(pct: number | null): string {
    if (pct === null) return "▒".repeat(PCT_BAR_LEN) + " -";
    const filled = Math.round((pct / 100) * PCT_BAR_LEN);
    const icon = pct >= 80 ? "✅" : pct >= 60 ? "⚠️" : "❌";
    return `${"█".repeat(filled)}${"░".repeat(PCT_BAR_LEN - filled)} ${pct}% ${icon}`;
}

const STATUS_EMOJI: Record<string, string> = { A: "✅", D: "❌", L: "🏖️", N: "➖" };

function formatCourse(c: AttendanceCourse): string {
    const att = c.attended === null ? "-" : c.attended.toFixed(1);
    const tot = c.total === null ? "-" : c.total.toFixed(1);
    const lines = [`\n📚 ${c.name ?? c.code ?? "?"}`, `   ${pctBar(c.percent)}  (${att}/${tot}h)`];

    for (const rec of c.records) {
        const who = rec.recordedByName ?? rec.recordedByEmail ?? "?";
        lines.push(`   ${STATUS_EMOJI[rec.status ?? ""] ?? "❓"} ${rec.classDatetime ?? "?"}  by ${who}`);
    }
    return lines.join("\n");
}

export function formatAttendance(result: GetAttendanceResult, courseFilter?: string): string {
    if (!result.ok) {
        return `❌ Attendance error\n${result.message}\n\n💡 Register with /hihive set <studentId> <email>.`;
    }
    if (result.no_record) {
        return `⚠️ No attendance record found.${courseFilter ? `\nNo courses matching ${courseFilter}.` : ""}`;
    }
    if (result.courses.length === 0 && result.message !== "OK") {
        return `📋 Attendance (raw - table parse failed)\n${"─".repeat(30)}\n${result.message}`;
    }

    const lines: string[] = [];
    const prof = result.profile;
    if (prof?.name || prof?.studentId) {
        lines.push(`👤 ${prof.name ?? "?"} (${prof.studentId ?? "?"})`);
        if (prof.session) lines.push(`📅 Session: ${prof.session}`);
    }
    lines.push("─".repeat(30));

    if (result.courses.length === 0) {
        lines.push(courseFilter ? `No course matching ${courseFilter}.` : "No course data available.");
        return lines.join("\n");
    }

    for (const c of result.courses) lines.push(formatCourse(c));

    if (!courseFilter && result.overallPercent !== null) {
        lines.push("\n" + "─".repeat(30), `📊 Overall: ${result.overallPercent}%`);
    }
    return lines.join("\n");
}

// ── Commands ──────────────────────────────────────────────────────────────────

/** Fetch and send one doc's report. Shared by /attendance and /hihive att. */
async function sendAttendanceReport(ctx: Ctx, docId: string, courseFilter?: string): Promise<void> {
    await ctx.status("⏳ Fetching your attendance...");

    const result = await getAttendance(docId, { courseCode: courseFilter });
    if (result === undefined) {
        await ctx.reply("Credentials are not set. Use /hihive set <studentId> <email>.");
        return;
    }

    await ctx.reply(truncate(formatAttendance(result, courseFilter), MAX_TG_TEXT, "\n\n…(truncated)"));
}

const attendance = cmd("attendance", {
    aliases: ["att"],
    description: "Fetch your UTAR attendance report",
    args: "[course_code]",
}, async (ctx: Ctx) => {
    await sendAttendanceReport(ctx, await ownDocId(ctx), ctx.match || undefined);
});

/** Pull a QR string out of the attached/replied image. Null after explaining why. */
async function qrFromImage(ctx: Ctx, notice: string): Promise<string | null> {
    const image = findImage(ctx.tg);
    if (!image) {
        await ctx.reply("⚠️ Send or reply to a QR image, or paste the raw QR string.");
        return null;
    }

    await ctx.status(notice);

    const buffer = await downloadMedia(image);
    const extracted = await readQrCode(buffer);

    if (!extracted) {
        await ctx.reply("❌ No QR code detected. Try sending the original file rather than a screenshot.");
        return null;
    }
    return extracted;
}

const scan = cmd("scan", {
    description: "Submit a QR code to mark attendance",
    args: "[raw_qr]",
    usageHint:
        "Usage:\n" +
        "• Reply to a QR image with /scan\n" +
        "• Paste a raw QR string: /scan Q01:*:abc123...",
}, async (ctx: Ctx) => {
    const rawQr = ctx.hasArgs ? ctx.match : await qrFromImage(ctx, "⏳ Reading QR from image...");
    if (!rawQr) return;

    if (!ctx.hasArgs) await ctx.status(`🔍 Extracted:\n${rawQr}\n\n⏳ Submitting...`);

    const result = await scanQr(await ownDocId(ctx), rawQr);
    if (result === undefined) {
        await ctx.reply("Credentials are not set. Use /hihive set <studentId> <email>.");
        return;
    }

    const text = formatScanResult(result);
    const imageUrl = (result as { imageUrl?: string }).imageUrl;
    const resultImage = imageUrl ? await fetchImageBuffer(imageUrl) : null;

    if (resultImage) {
        await ctx.tg.replyWithPhoto(new InputFile(resultImage, "result.png"), { caption: truncate(text, 1000) });
    } else {
        await ctx.reply(text);
    }
});

const decode = cmd("decode", {
    description: "Inspect a QR code offline - no server call",
    args: "[raw_qr]",
    usageHint:
        "Usage:\n" +
        "• Send/reply to a QR image with /decode\n" +
        "• Paste a raw QR string: /decode Q01:*:abc123...",
}, async (ctx: Ctx) => {
    const raw = ctx.hasArgs ? ctx.match : await qrFromImage(ctx, "⏳ Reading QR from image...");
    if (!raw) return;

    if (!isAttendanceQr(raw)) {
        await ctx.reply(
            `⚠️ That QR isn't an attendance QR.\n\n🔗 Content:\n${truncate(raw, 500)}\n\n` +
            `Expected one of: ${VALID_QR_TYPES.join(", ")} before ":*:"`
        );
        return;
    }

    const result = decodeQr(await ownDocId(ctx), raw);
    if (!result.ok) {
        await ctx.reply(`❌ Decode failed\n${result.error}`);
        return;
    }

    const d = result.decoded;
    const lines = [
        "🔍 Decoded QR (offline)",
        "─".repeat(30),
        `Type:     ${d.type}`,
        `Class ID: ${d.classId ?? "-"}`,
        "",
    ];

    if (d.type === "Q01" || d.type === "Q02") {
        lines.push(
            "📋 Class info",
            `• Course:    ${d.info.courseCode || "-"}`,
            `• Session:   ${d.info.sessionType || "-"}`,
            `• Group:     ${d.info.group || "-"}`,
            `• Date/Time: ${d.info.datetime || "-"}`,
            `• Hours:     ${d.info.hours || "-"}`,
        );
    } else if (d.type === "E01") {
        lines.push(
            "📋 Event info",
            `• Event: ${d.info.eventName || "-"}`,
            `• From:  ${d.info.from || "-"}`,
            `• To:    ${d.info.to || "-"}`,
            `• Venue: ${d.info.venue || "-"}`,
        );
    }

    const VERDICT: Record<string, string> = {
        in_window: "✅ LIKELY VALID", expired: "❌ LIKELY EXPIRED",
        too_early: "⏳ NOT OPEN YET", unknown: "❓ UNKNOWN",
    };
    lines.push(
        "", "─".repeat(30),
        `⏱️ Expiry: ${VERDICT[d.expiry.verdict] ?? d.expiry.verdict}`,
        d.expiry.reason,
        "(Prediction only - the server clock is the final authority)",
    );

    await ctx.reply(truncate(lines.join("\n"), MAX_TG_TEXT));
});

// Per-type argument shape - adding a QR type is a row here, not a new branch
const INFO_SEPARATOR = ":-:";
const SPECS: Record<QrType, { fields: string[]; labels: string[]; example: string }> = {
    Q01: {
        fields: ["courseCode", "sessionType", "group", "datetime", "hours"],
        labels: ["Course", "Session", "Group", "Date/Time", "Hours"],
        example: `/genqr Q01 12345 UECS2194 L G1 "2025-01-20 09:00" 2`,
    },
    Q02: {
        fields: ["courseCode", "sessionType", "group", "datetime", "hours"],
        labels: ["Course", "Session", "Group", "Date/Time", "Hours"],
        example: `/genqr Q02 12345 UECS2194 L G1 "2025-01-20 09:00" 2`,
    },
    E01: {
        fields: ["eventName", "from", "to", "venue"],
        labels: ["Event", "From", "To", "Venue"],
        example: `/genqr E01 99999 "Orientation" "2025-01-20 08:00" "2025-01-20 12:00" "Hall A"`,
    },
    CTR: { fields: [], labels: [], example: "/genqr CTR 12345" },
    LQR: { fields: [], labels: [], example: "/genqr LQR 12345" },
};

const genqr = cmd("genqr", {
    aliases: ["gqr", "createqr"],
    description: "Generate an encrypted attendance QR code image",
    args: "<Q01|Q02|E01|CTR|LQR> <classId> <args...>",
    usageHint:
        "Usage: /genqr <type> <args...>\n\n" +
        Object.values(SPECS).map(s => `• ${s.example}`).join("\n") +
        "\n\nWrap arguments containing spaces in double quotes.",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    // Shell-style split so "2025-01-20 09:00" stays one argument
    const { parseQuotedArgs } = await import("../../../shared/lib/text.js");
    const args = parseQuotedArgs(ctx.match);
    const typeRaw = (args[0] ?? "").toUpperCase();

    if (!(VALID_QR_TYPES as readonly string[]).includes(typeRaw)) {
        await ctx.reply(`❌ Unknown QR type: ${typeRaw}\nValid: ${VALID_QR_TYPES.join(", ")}`);
        return;
    }

    const type = typeRaw as QrType;
    const spec = SPECS[type];
    const rest = args.slice(1);

    if (rest.length < 1 + spec.fields.length) {
        await ctx.reply(`⚠️ Not enough arguments for ${type}\n\n${spec.example}`);
        return;
    }

    const classId = rest[0]!;
    const infoParts = spec.fields.map((_, i) => rest[i + 1]!);

    const creds = loadLegacyCreds();
    // Exactly reverses parseDecoded(): type:*::*::*::*:classId:*:<info>
    const plaintext = [type, "", "", "", classId, infoParts.join(INFO_SEPARATOR)].join(QR_SEPARATOR);
    const rawQrString = `${type}${QR_SEPARATOR}${aesEncrypt(plaintext, creds.aes_key, creds.aes_iv)}`;
    const image = await createQrImage(rawQrString);

    const caption = [
        "✅ Generated attendance QR",
        "",
        `Type: ${type}`,
        `Class ID: ${classId}`,
        ...spec.labels.map((l, i) => `${l}: ${infoParts[i]}`),
    ].join("\n");

    await ctx.tg.replyWithPhoto(new InputFile(image, "attendance-qr.png"), { caption: truncate(caption, 1000) });
    await ctx.reply(`🔐 Raw:\n${truncate(rawQrString, 3000)}`);
});

const refresh = cmd("refresh", {
    description: "Re-login for a fresh sessionId. ⚠️ Signs out the phone app.",
}, async (ctx: Ctx) => {
    const apiDomain = process.env["ATTENDANCE_QR_SCAN_API_DOMAIN"] ?? "";
    if (!apiDomain) {
        await ctx.reply("❌ ATTENDANCE_QR_SCAN_API_DOMAIN is not set in the environment.");
        return;
    }

    await ctx.status(
        "⚠️ Warning: refreshing will sign out the phone app.\nThe token usually stays the same.\n\n⏳ Logging in..."
    );

    const result = await refreshToken(apiDomain);
    if (!result.ok) {
        await ctx.reply(`❌ Refresh failed\n${result.message}`);
        return;
    }

    await ctx.reply(
        `✅ Session refreshed!\n\n🆔 New sessionId: ${result.newSessionId}\n` +
        (result.tokenChanged ? "🔄 Token changed" : "ℹ️ Token unchanged (expected)")
    );
});

// ── /hihive: credentials, whitelist, rankings ────────────────────────────────

const HIHIVE_FORMATS = [
    "/hihive                       - your stored info",
    "/hihive set <id> <email> [hidden]",
    "/hihive add <id> <email> [hidden]   - register someone else",
    "/hihive info [id]",
    "/hihive delete [id]",
    "/hihive list                  - anonymous docs you own",
    "/hihive att [id] [course]",
    "/hihive token [id]",
    "/hihive decrypt <token>",
    "/hihive whitelist [list|remove]",
    "/hihive isolated [id]",
    "/hihive visualise [id]",
    "/hihive rank",
];

const toBool = (s: string | undefined): boolean => s?.toLowerCase() === "true";

function credsProblems(id: string, email: string): string[] {
    const errs: string[] = [];
    if (!ID_REGEX.test(id)) errs.push("❌ Student ID must be exactly 7 digits.");
    if (!EMAIL_REGEX.test(email)) errs.push("❌ Email must look like thioziliang123@1utar.my");
    return errs;
}

/** Resolve a user-supplied id (doc id, student id or email) to a real doc id. */
/*
Resolve an id the user typed. Delegates to the shared resolver so an explicit
`bind` is honoured here exactly as it is on WhatsApp: exact doc, then alias,
then the loose student-id/email match.
*/
async function resolveDocId(input: string | undefined, fallback: string): Promise<string | undefined> {
    return resolveDocIdShared(input ?? fallback);
}

/** Masked display name for a doc. */
async function labelFor(docId: string): Promise<string> {
    const creds = await loadCreds(docId);
    if (!creds) return docId;
    return creds.hidden ? "*".repeat(creds.id.length) : creds.id;
}

const hihive = cmd("hihive", {
    aliases: ["hh"],
    description: "Manage attendance credentials, whitelist and rankings",
    args: "<subcommand> [args...]",
    usageHint: `Subcommands:\n${HIHIVE_FORMATS.join("\n")}`,
}, async (ctx: Ctx) => {
    const me = await ownDocId(ctx);

    /*
    Learn who this is from the update that is already here - grammY puts the
    sender's name on every one. No lookup, nothing sent, and it only touches a
    row that already exists.
    */
    void rememberIdentity(String(ctx.userId), ctx.who);
    /*
    Census. Telegram's Bot API has no way to list a group's members, so unlike
    WhatsApp there is no harvest to fall back on - seeing someone speak is the
    only evidence that ever arrives.
    */
    void noteSpoke(String(ctx.chatId), String(ctx.userId), 'telegram', ctx.who,
                   (ctx.tg.chat as any)?.title ?? null);
    const showInfo = (creds: Creds | undefined): string =>
        creds === undefined
            ? "No credentials stored. Register with /hihive set <studentId> <email>."
            : `👤 Personal info\n🫆 Student ID: ${creds.id}\n📧 UTAR email: ${creds.email}` +
              (creds.hidden ? "\n🙈 Hidden in reports" : "");

    switch (ctx.sub) {
        case "": {
            await ctx.reply(showInfo(await loadCreds(me)));
            return;
        }

        case "set":
        case "add": {
            const [id, email, hidden] = [ctx.arg(1), ctx.arg(2), ctx.arg(3)];
            if (!id || !email) {
                await ctx.reply(`Usage: /hihive ${ctx.sub} <studentId> <email> [hidden]`);
                return;
            }
            const errs = credsProblems(id, email);
            if (errs.length > 0) { await ctx.reply(errs.join("\n")); return; }

            if (ctx.sub === "add") {
                const ref = await addAnonymousCreds({ id, email, hidden: toBool(hidden), ownerId: me });
                await ctx.reply(`👤 Anonymous credentials added\n🫆 ${id}\n📧 ${email}\n🆔 Doc ID: ${ref.id}`);
            } else {
                await saveCreds(me, { id, email, hidden: toBool(hidden) });
                await ctx.reply(`✅ Saved\n🫆 ${id}\n📧 ${email}`);
            }
            return;
        }

        /*
        bind - attach someone else's account to credentials.

          /hihive bind <userId> <studentId> <email> [hidden]   create and bind
          /hihive bind <userId> <docRef>                       bind to existing
          /hihive bind list [id]                               who is bound
          /hihive bind remove <userId>                         unbind

        Reply to their message and the id can be left out entirely.
        */
        case "bind": {
            const first = ctx.arg(1);

            if (first === "list") {
                const { docId, aliases } = await bindingsFor(ctx.arg(2) ?? String(me));
                await ctx.reply(docId ? formatBindings(docId, aliases) : "No credentials found.");
                return;
            }

            if (first === "remove" || first === "rm" || first === "unbind") {
                const target = ctx.arg(2) ?? (ctx.replyToUserId ? String(ctx.replyToUserId) : undefined);
                if (!target) { await ctx.reply("Usage: /hihive bind remove <userId>"); return; }
                await ctx.reply((await unbind(target)).message);
                return;
            }

            // With a reply the target is implicit, so every argument shifts by one
            const replying = ctx.replyToUserId !== undefined;
            const target = replying ? String(ctx.replyToUserId) : first;
            const rest = replying ? [first, ctx.arg(2), ctx.arg(3)] : [ctx.arg(2), ctx.arg(3), ctx.arg(4)];

            if (!target) {
                await ctx.reply(
                    [
                        "Usage:",
                        "  /hihive bind <userId> <studentId> <email> [hidden]",
                        "  /hihive bind <userId> <docId | studentId | email>",
                        "",
                        "Reply to their message and drop the userId:",
                        "  /hihive bind <studentId> <email> [hidden]",
                        "  /hihive bind <docId | studentId | email>",
                        "",
                        "  /hihive bind list [id]",
                        "  /hihive bind remove <userId>",
                    ].join("\n")
                );
                return;
            }

            const result = rest[1]
                ? await bindNew(target, rest[0]!, rest[1]!, parseBool(rest[2]), "telegram", String(me), replying ? ctx.replyToWho : null)
                : await bindToExisting(target, rest[0] ?? "", "telegram", String(me), replying ? ctx.replyToWho : null);

            await ctx.reply(result.message);
            return;
        }

        case "info": {
            const creds = await looseLoadCreds(ctx.arg(1) ?? me);
            await ctx.reply(creds ? showInfo(creds) : `${ctx.arg(1)} not found.`);
            return;
        }

        case "delete":
        case "del": {
            const target = ctx.arg(1) ?? me;
            const deleted = await deleteCreds(target);
            await ctx.reply(deleted
                ? `🚮 Deleted\n🫆 ${deleted.id}\n📧 ${deleted.email}`
                : `${target} not found - nothing deleted.`);
            return;
        }

        case "list": {
            const owned = await getAnonymousDocIds(me);
            await ctx.reply(owned.length > 0
                ? `📁 Anonymous docs you own\n${owned.map((d, i) => `${i + 1}. ${d}`).join("\n")}`
                : "📭 No anonymous docs registered.");
            return;
        }

        case "att":
        case "attendance": {
            const docId = await resolveDocId(ctx.arg(1), me);
            if (!docId) { await ctx.reply(`${ctx.arg(1)} not found.`); return; }
            await sendAttendanceReport(ctx, docId, ctx.arg(2));
            return;
        }

        case "token":
        case "t": {
            const creds = await loadCreds(ctx.arg(1) ?? me);
            await ctx.reply(creds
                ? `🪙 Fresh token:\n${generateEncryptedData(creds.id, creds.email)}`
                : `${ctx.arg(1) ?? me} not found.`);
            return;
        }

        case "decrypt": {
            if (!ctx.arg(1)) { await ctx.reply("Usage: /hihive decrypt <token>"); return; }
            await ctx.reply(`Decrypted:\n${JSON.stringify(decryptData(ctx.arg(1)!))}`);
            return;
        }

        case "whitelist":
        case "wl": {
            const action = (ctx.arg(1) ?? "").toLowerCase();
            const chat = String(ctx.chatId);

            if (action === "remove" || action === "rm") {
                const target = ctx.arg(2) ?? chat;
                await ctx.reply(await removeWhitelist(target)
                    ? `🗑️ Removed from whitelist: ${target}`
                    : `❔ ${target} was not whitelisted.`);
            } else if (action === "list" || action === "l") {
                const rows = await listWhitelist();
                await ctx.reply(rows.length > 0
                    ? `✅ Whitelisted chats\n${rows.map((r, i) => `${i + 1}. ${r.jid}`).join("\n")}`
                    : "📭 No chats are whitelisted yet.");
            } else {
                await ctx.reply(await addWhitelist(chat, me)
                    ? `✅ Auto-scan reports enabled here\n🆔 ${chat}`
                    : `ℹ️ This chat is already whitelisted.`);
            }
            return;
        }

        case "isolated":
        case "iso": {
            const docId = await resolveDocId(ctx.arg(1), me);
            if (!docId) { await ctx.reply(`${ctx.arg(1)} not found.`); return; }

            await ctx.status("🔎 Comparing timetables across all registered students...");
            const result = await findIsolatedSessions(docId, await labelFor(docId));

            if ("error" in result) { await ctx.reply(`❌ ${result.error}`); return; }
            await ctx.reply(truncate(formatIsolated(result), MAX_TG_TEXT));
            return;
        }

        case "visualise":
        case "vis":
        case "v": {
            const docId = await resolveDocId(ctx.arg(1), me);
            if (!docId) { await ctx.reply(`${ctx.arg(1)} not found.`); return; }

            await ctx.status("🗓️ Rendering timetable...");
            const slots = await slotsForDoc(docId);

            if (slots === null) { await ctx.reply("❌ Could not load that student's attendance."); return; }
            if (slots.length === 0) { await ctx.reply("📭 No attendance history yet - nothing to draw."); return; }

            const label = await labelFor(docId);
            const courses = new Set(slots.map(s => s.courseCode)).size;
            const png = await renderTimetablePng(
                slots, `Timetable - ${label}`, `${slots.length} sessions · ${courses} courses`
            );

            await ctx.tg.replyWithPhoto(new InputFile(png, "timetable.png"), {
                caption: `🗓️ Timetable - ${label}\n${slots.length} weekly sessions across ${courses} courses.`,
            });
            return;
        }

        case "rank":
        case "ranks":
        case "leaderboard":
        case "lb": {
            // Registered and unregistered contributors, merged
            const rows = await getLeaderboard(25);
            if (rows.length === 0) { await ctx.reply("📭 No QR contributions recorded yet."); return; }

            const total = rows.reduce((sum, r) => sum + r.contributions, 0);
            const medal = (i: number): string => i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;

            await ctx.reply(
                "🏆 QR contribution ranking\n" +
                "Who supplies the QR codes everyone scans.\n\n" +
                rows.map((r, i) => {
                    const name = leaderLabel(r);
                    const tag = r.registered ? "" : " (guest)";
                    const share = ((r.contributions / total) * 100).toFixed(0);
                    return `${medal(i)} ${name}${tag} - ${r.contributions} QR${r.contributions === 1 ? "" : "s"} (${share}%)`;
                }).join("\n") +
                `\n\n📊 ${total} contributed by ${rows.length} student${rows.length === 1 ? "" : "s"}.`
            );
            return;
        }

        default:
            await ctx.reply(`Unknown subcommand: ${ctx.sub}\n\n${HIHIVE_FORMATS.join("\n")}`);
    }
});

// ── Auto-scan ─────────────────────────────────────────────────────────────────

const autoScan = new Composer<Context>();

/**
 * Every photo posted in a chat is checked for an attendance QR.
 *
 * Scanning is unconditional; the whitelist only decides whether the chat hears
 * back. Caption an image /ignore to opt it out entirely.
 */
autoScan.on("message:photo", async (tgCtx) => {
    try {
        const chatId = String(tgCtx.chat.id);
        const caption = tgCtx.message.caption ?? "";

        if (isScanIgnored(caption)) {
            console.log("[autoScan] caption asks to ignore this image - not scanning.");
            await react(TRANSPORT, chatId, "🤝", { id: tgCtx.message.message_id });
            return;
        }

        // A photo captioned with a command is that command's input, not a drop
        if (caption.trimStart().startsWith("/")) return;

        const image = findImage(tgCtx);
        if (!image) return;

        const buf = await downloadMedia(image);
        console.log(`[autoScan] downloaded ${formatBytes(buf.length)}`);

        const found = (await readQrCodes(buf)).filter(isAttendanceQr);
        if (found.length === 0) return;

        // Persistent guard: a restart must not re-scan a QR already handled
        if (await alreadyProcessed(TRANSPORT, tgCtx.message.message_id)) {
            console.log(`[autoScan] message ${tgCtx.message.message_id} already handled.`);
            return;
        }

        const accounts = Object.entries(await getAllDocs()) as [string, { id: string; hidden: boolean }][];
        if (accounts.length === 0) {
            await tgCtx.reply("📭 No accounts registered to scan.");
            return;
        }

        const qrEntries = found.map(raw => {
            const d = decodeQr(String(tgCtx.from.id), raw);
            return { raw, courseCode: d.ok ? d.decoded.info.courseCode ?? null : null };
        });

        const scannedBy = await labelFor(String(tgCtx.from.id));

        /*
        Credit regardless of registration - creditContribution routes it to
        hi_hive or to the contributors ledger. Same rule as the WhatsApp side.
        */
        try {
            await creditContribution(String(tgCtx.from.id), "telegram", {
                displayName: tgCtx.from.first_name ?? null,
                username: tgCtx.from.username ?? null,
            });
        } catch (e) {
            console.error("[autoScan] contribution credit failed:", e);
        }

        const destinations: Destination[] = [
            { chatId, status: "all", isOrigin: true, showDelay: true, transport: TRANSPORT },
        ];

        const batchId = newBufferId();
        const startedAt = Date.now();

        // One message = ONE batch, with a job per (account x QR) pair
        const jobs = accounts.flatMap(([doc, creds]) =>
            qrEntries.map(q => {
                const delaySec = randomDelaySec();
                return {
                    id: newBufferId(),
                    batchId,
                    docId: doc,
                    studentId: creds.id,
                    label: creds.hidden ? "*".repeat(creds.id.length) : creds.id,
                    rawQr: q.raw,
                    chatId,
                    quotedKey: null,
                    destinations,
                    originSilent: false,
                    scannedBy,
                    courseCode: q.courseCode,
                    dueAt: startedAt + Math.round(delaySec * 1000),
                    delaySec,
                };
            })
        ).sort((a, b) => a.dueAt - b.dueAt);

        await enqueueBatch(jobs.map(({ delaySec, ...row }) => row));

        await tgCtx.reply(formatWaitingNoticeGrouped(jobs));
        console.log(`[autoScan] queued batch ${batchId} (${jobs.length} job(s))`);
    } catch (err) {
        // Never let a bad photo take down the update pipeline
        console.error("[autoScan] failed:", err);
    }
});

const commands = feature("hi-hive", [attendance, scan, decode, genqr, refresh, hihive]);

const composer = new Composer<Context>();
composer.use(commands);
composer.use(autoScan);

export default composer;
export { escapeHtml };
