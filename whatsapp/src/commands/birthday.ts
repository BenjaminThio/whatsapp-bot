import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { birthdaysOnDate, saveBirthday, setRemindYear } from "../../../shared/lib/birthday-db.js";
import { Command, CommandContext } from "./_types.js";
import { parseFlexibleDate, formatDate, toDayMonthKey } from "../../../shared/utils/date.js";
import { cmd } from "../config/prefixes.js";
import { queueText } from "../lib/outbox.js";

// Scheduler - runs every minute and fires birthday wishes
export async function startBirthdayScheduler(_sock?: any) {
    console.log("⏰ Cloud Birthday Scheduler (Year-Lock Edition) initialized.");

    setInterval(async () => {
        try {
            const today = new Date();
            const day = String(today.getDate()).padStart(2, '0');
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const currentYear = today.getFullYear();
            const todayKey = `${day}/${month}`;

            const records = await birthdaysOnDate(todayKey);
            if (records.length === 0) return;

            for (const record of records) {
                // Skip if already wished this year
                if (record.remindYear === currentYear) continue;

                // Include age when we have a birth year
                let ageLine = "";
                if (typeof record.birthYear === "number") {
                    const age = currentYear - record.birthYear;
                    ageLine = `\n🎁 Turning *${age}* today!`;
                }

                console.log(`🎉 Birthday match! Wishing ${record.name}.`);

                /*
                Durable send, then mark. If the socket is down at midnight the
                wish is queued rather than thrown away - and because the year
                lock is only written afterwards, a failure here means it gets
                another try on the next tick instead of being lost for a year.
                */
                await queueText(
                    record.jid,
                    `🎂🎈 *CLOUD BIRTHDAY REMINDER* 🎈🎂\n\nToday is *${record.name}*'s special day!${ageLine}\n\nLet's wish them an amazing day ahead! 🎉✨`,
                    { priority: 2 }
                );

                await setRemindYear(record.docId, currentYear);
            }
        } catch (err) {
            console.error("Error running birthday schedule check:", err);
        }
    }, 1000 * 60);
}

async function handleBirthday(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
    const rawDate = ctx.arg(0);
    const targetName = ctx.rest(1);

    if (!rawDate || !targetName) {
        await ctx.sendUsage();
        return;
    }

    const parsed = parseFlexibleDate(rawDate);
    if (!parsed) {
        await ctx.replyText(
            `❌ Invalid date: \`${rawDate}\`\n` +
            "Try formats like `09/03/2005`, `9-3-2005`, or `09/03`."
        );
        return;
    }

    try {
        const docId = `${ctx.chatId}_${targetName}`.replace(/\s+/g, '_');

        await saveBirthday({
            docId,
            name: targetName,
            date: toDayMonthKey(parsed),         // "DD/MM" - used by scheduler match
            birthYear: parsed.year ?? null,      // null if user omitted year
            jid: ctx.chatId,
        });

        const yearNote = parsed.year !== null
            ? `\n🎂 *Year:* ${parsed.year}`
            : "\n💡 *Tip:* Include a year to track age!";

        await ctx.replyText(
            `✅ *Birthday Saved!*\n👤 *Name:* ${targetName}\n📅 *Date:* ${formatDate(parsed)}${yearNote}`
        );

    } catch (error) {
        console.error("Birthday save error:", error);
        await ctx.replyText("❌ Failed to save birthday. Check the server logs.");
    }
}

const command: Command = {
    name: "birthday",
    aliases: ["bday"],
    description: "Save a birthday reminder",
    usage: `${cmd("birthday")} <date> <name>`,
    usageHint:
        `⚠️ *Usage:* \`${cmd("birthday")} <date> <name>\`\n` +
        "Date accepts: `09/03/2005`, `9-3-2005`, `9.3.2005`, or `09/03` (no year)",
    requiresArgs: true,
    handler: handleBirthday,
};

export default command;
