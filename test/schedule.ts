import { WAMessage } from "@whiskeysockets/baileys";
import { FieldValue } from "firebase-admin/firestore";
import db from "../firebase.js";
import { Command } from "./_types.js";
import { parseDateTime, formatDateTime } from "../utils/datetime.js";

/*
!schedule - precise one-shot reminders.
  !schedule 25/12/2026 14:30 buy christmas dinner
  !schedule tomorrow 9am call the dentist
  !schedule in 45m take the cake out of the oven
  !schedule 18:00 gym
  !schedule list
  !schedule cancel <id>

Precision design: a Firestore poll every 30s picks up jobs due within the
next window, and each one gets an exact setTimeout - so reminders fire
within ~1s of the target instead of "whenever the next minute tick is".
Jobs persist in Firestore, so they survive restarts; anything missed while
the bot was offline fires immediately on startup with an overdue marker.
*/

const COLLECTION = "schedules";
const POLL_INTERVAL_MS = 30_000;
// Arm exact timers for anything due within the next poll window (+ small overlap)
const ARM_WINDOW_MS = POLL_INTERVAL_MS + 5_000;
const MAX_PER_CHAT = 25;
const MAX_FUTURE_MS = 366 * 24 * 3_600_000;   // 1 year ahead

interface ScheduleDoc {
    jid: string;
    activity: string;
    fireAt: number;        // epoch ms
    requester: string;
    fired: boolean;
    createdAt?: unknown;
}

// IDs that already have an in-memory timer armed, to prevent double-firing
const armed = new Set<string>();

async function fireReminder(sock: any, id: string, data: ScheduleDoc, overdueMs = 0) {
    try {
        // Mark fired FIRST so a crash mid-send can't cause a double fire on restart
        await db.collection(COLLECTION).doc(id).update({ fired: true });

        const overdueNote = overdueMs > 60_000
            ? `\n\n_⚠️ This reminder is ${Math.round(overdueMs / 60_000)} min overdue (bot was offline)._`
            : "";

        await sock.sendMessage(data.jid, {
            text: `⏰ *Reminder!*\n\n📌 ${data.activity}\n🕐 Scheduled for: ${formatDateTime(data.fireAt)}${overdueNote}`
        });
        console.log(`⏰ Fired reminder ${id}: "${data.activity}"`);
    } catch (err) {
        console.error(`⏰ Failed to fire reminder ${id}:`, err);
    } finally {
        armed.delete(id);
    }
}

// Call once from index.ts when the connection opens (like startBirthdayScheduler).
export function startScheduleService(sock: any) {
    console.log("⏰ Schedule service started.");

    const poll = async () => {
        try {
            const now = Date.now();
            // Everything unfired that is due within the arming window (or overdue)
            const snapshot = await db.collection(COLLECTION)
                .where("fired", "==", false)
                .where("fireAt", "<=", now + ARM_WINDOW_MS)
                .get();

            for (const doc of snapshot.docs) {
                if (armed.has(doc.id)) continue;
                const data = doc.data() as ScheduleDoc;
                armed.add(doc.id);

                const delay = data.fireAt - Date.now();
                if (delay <= 0) {
                    // Overdue (missed while offline, or just hit) - fire now
                    void fireReminder(sock, doc.id, data, -delay);
                } else {
                    setTimeout(() => void fireReminder(sock, doc.id, data), delay);
                }
            }
        } catch (err) {
            console.error("⏰ Schedule poll error:", err);
        }
    };

    void poll(); // immediate pass picks up missed jobs
    setInterval(poll, POLL_INTERVAL_MS);
}

// Subcommand: list
async function listSchedules(sock: any, msg: WAMessage) {
    const snapshot = await db.collection(COLLECTION)
        .where("jid", "==", msg.key.remoteJid)
        .where("fired", "==", false)
        .get();

    if (snapshot.empty) {
        await sock.sendMessage(msg.key.remoteJid!, { text: "📭 No pending reminders in this chat." }, { quoted: msg });
        return;
    }

    const items = snapshot.docs
        .map(d => ({ id: d.id, ...(d.data() as ScheduleDoc) }))
        .sort((a, b) => a.fireAt - b.fireAt);

    const lines = ["⏰ *Pending reminders:*\n"];
    for (const it of items) {
        lines.push(`• \`${it.id.slice(0, 6)}\` — ${formatDateTime(it.fireAt)}\n  📌 ${it.activity}`);
    }
    lines.push("\n_Cancel with `!schedule cancel <id>`_");
    await sock.sendMessage(msg.key.remoteJid!, { text: lines.join("\n") }, { quoted: msg });
}

// Subcommand: cancel
async function cancelSchedule(sock: any, msg: WAMessage, idPrefix: string) {
    const snapshot = await db.collection(COLLECTION)
        .where("jid", "==", msg.key.remoteJid)
        .where("fired", "==", false)
        .get();

    const match = snapshot.docs.find(d => d.id.startsWith(idPrefix));
    if (!match) {
        await sock.sendMessage(msg.key.remoteJid!, {
            text: `❌ No pending reminder found with ID \`${idPrefix}\`. Use \`!schedule list\` to see IDs.`
        }, { quoted: msg });
        return;
    }

    await db.collection(COLLECTION).doc(match.id).update({ fired: true });
    armed.delete(match.id);   // disarm if a timer was pending (timer will no-op on update conflict)
    const data = match.data() as ScheduleDoc;
    await sock.sendMessage(msg.key.remoteJid!, {
        text: `🗑️ Cancelled reminder \`${match.id.slice(0, 6)}\`\n📌 ${data.activity}`
    }, { quoted: msg });
}

// Main handler
async function handleSchedule(sock: any, msg: WAMessage, text: string) {
    if (!msg.key.remoteJid) return;

    const raw = text.slice("!schedule ".length).trim();
    if (!raw) {
        await sock.sendMessage(msg.key.remoteJid, {
            text:
                "⚠️ Usage: `!schedule <datetime> <activity>`\n\n" +
                "*Examples:*\n" +
                "• `!schedule 25/12/2026 14:30 buy dinner`\n" +
                "• `!schedule tomorrow 9am call dentist`\n" +
                "• `!schedule in 45m check the oven`\n" +
                "• `!schedule 18:00 gym`\n\n" +
                "*Other:* `!schedule list` · `!schedule cancel <id>`"
        }, { quoted: msg });
        return;
    }

    const tokens = raw.split(/\s+/);

    // Subcommands
    if (tokens[0].toLowerCase() === "list") {
        await listSchedules(sock, msg);
        return;
    }
    if (tokens[0].toLowerCase() === "cancel") {
        if (!tokens[1]) {
            await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Usage: `!schedule cancel <id>`" }, { quoted: msg });
            return;
        }
        await cancelSchedule(sock, msg, tokens[1]);
        return;
    }

    // Parse the leading datetime
    const parsed = parseDateTime(tokens);
    if (!parsed) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ Couldn't understand the date/time: \`${tokens.slice(0, 2).join(" ")}\`\n\nTry formats like \`25/12/2026 14:30\`, \`tomorrow 9am\`, \`in 45m\`, or \`18:00\`.`
        }, { quoted: msg });
        return;
    }

    const activity = tokens.slice(parsed.consumed).join(" ").trim();
    if (!activity) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "⚠️ Please include what the reminder is for: `!schedule <datetime> <activity>`"
        }, { quoted: msg });
        return;
    }

    const now = Date.now();
    if (parsed.epochMs <= now) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ That time is in the past: ${formatDateTime(parsed.epochMs)}`
        }, { quoted: msg });
        return;
    }
    if (parsed.epochMs > now + MAX_FUTURE_MS) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: "❌ Reminders can be at most 1 year in the future."
        }, { quoted: msg });
        return;
    }

    // Cap pending reminders per chat
    const pending = await db.collection(COLLECTION)
        .where("jid", "==", msg.key.remoteJid)
        .where("fired", "==", false)
        .get();
    if (pending.size >= MAX_PER_CHAT) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ This chat already has ${MAX_PER_CHAT} pending reminders. Cancel some first.`
        }, { quoted: msg });
        return;
    }

    const docRef = await db.collection(COLLECTION).add({
        jid: msg.key.remoteJid,
        activity,
        fireAt: parsed.epochMs,
        requester: msg.key.participant || msg.key.remoteJid,
        fired: false,
        createdAt: FieldValue.serverTimestamp(),
    } satisfies ScheduleDoc & { createdAt: unknown });

    const inMs = parsed.epochMs - now;
    const inHuman = inMs < 3_600_000
        ? `${Math.round(inMs / 60_000)} min`
        : inMs < 24 * 3_600_000
            ? `${(inMs / 3_600_000).toFixed(1)} hours`
            : `${(inMs / (24 * 3_600_000)).toFixed(1)} days`;

    await sock.sendMessage(msg.key.remoteJid, {
        text:
            `✅ *Reminder set!*\n\n` +
            `📌 ${activity}\n` +
            `🕐 ${formatDateTime(parsed.epochMs)}\n` +
            `⏳ In about ${inHuman}\n` +
            `🆔 \`${docRef.id.slice(0, 6)}\``
    }, { quoted: msg });
}

const command: Command = {
    name: "schedule",
    aliases: ["remind", "timer"],
    description: "Set a precise one-shot reminder",
    usage: "!schedule <datetime> <activity>",
    requiresArgs: true,
    handler: handleSchedule,
};

export default command;