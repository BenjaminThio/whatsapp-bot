import { WAMessage } from "@whiskeysockets/baileys";
import { birthdaysOnDate, saveBirthday, setRemindYear } from "../lib/birthday-db.js";
import { Command } from "./_types.js";
import { parseFlexibleDate, formatDate, toDayMonthKey } from "../utils/date.js";

// Scheduler - runs every minute and fires birthday wishes
export async function startBirthdayScheduler(sock: any) {
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
                const docId = record.docId;

                // Skip if already wished this year
                if (record.remindYear === currentYear) continue;

                // Build a nice message - include age if we have a birth year
                let ageLine = "";
                if (typeof record.birthYear === "number") {
                    const age = currentYear - record.birthYear;
                    ageLine = `\n🎁 Turning *${age}* today!`;
                }

                console.log(`🎉 Firebase Match! Wishing ${record.name} a happy birthday.`);

                await sock.sendMessage(record.jid, {
                    text: `🎂🎈 *CLOUD BIRTHDAY REMINDER* 🎈🎂\n\nToday is *${record.name}*'s special day!${ageLine}\n\nLet's wish them an amazing day ahead! 🎉✨`
                });

                await setRemindYear(docId, currentYear);
            }
        } catch (err) {
            console.error("Error running Firebase schedule check:", err);
        }
    }, 1000 * 60);
}

// !birthday command
async function handleBirthday(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    // Strip the "!birthday " prefix and split into [dateToken, ...nameTokens]
    const args = text.slice("!birthday ".length).trim().split(/\s+/);
    const rawDate = args[0];
    const targetName = args.slice(1).join(" ");

    if (!rawDate || !targetName) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Usage: `!birthday <date> <name>`\nDate accepts: `09/03/2005`, `9-3-2005`, `9.3.2005`, or `09/03` (no year)"
        }, { quoted: msg });
        return;
    }

    const parsed = parseFlexibleDate(rawDate);
    if (!parsed) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Invalid date: \`${rawDate}\`\nTry formats like \`09/03/2005\`, \`9-3-2005\`, or \`09/03\`.`
        }, { quoted: msg });
        return;
    }

    try {
        const docId = `${msg.key.remoteJid}_${targetName}`.replace(/\s+/g, '_');

        await saveBirthday({
            docId,
            name: targetName,
            date: toDayMonthKey(parsed),         // "DD/MM" - used by scheduler match
            birthYear: parsed.year ?? null,      // null if user omitted year
            jid: msg.key.remoteJid,
        });

        const yearNote = parsed.year !== null
            ? `\n🎂 *Year:* ${parsed.year}`
            : "\n💡 *Tip:* Include a year to track age!";

        await sock.sendMessage(msg.key.remoteJid, {
            text: `✅ *Birthday Saved!*\n👤 *Name:* ${targetName}\n📅 *Date:* ${formatDate(parsed)}${yearNote}`
        }, { quoted: msg });

    } catch (error) {
        console.error("Firebase error:", error);
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Failed to save birthday. Check the server logs."
        }, { quoted: msg });
    }
}

const command: Command = {
    name: "birthday",
    aliases: ["bday"],
    description: "Save a birthday reminder",
    usage: "!birthday <date> <name>",
    requiresArgs: true,
    handler: handleBirthday,
};

export default command;