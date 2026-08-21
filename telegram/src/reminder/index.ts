/**
 * index.ts - relasma/src/reminder/index.ts
 *
 * /schedule (/remind, /timer) - precise one-shot reminders, and escalating ones
 * that ping more often as a deadline approaches.
 *
 *   /schedule 25/12/2026 14:30 buy christmas dinner
 *   /schedule tomorrow 9am call the dentist
 *   /schedule in 45m take the cake out of the oven
 *   /schedule --escalate=auto 30/06/2026 09:00 final exam
 *   /schedule list
 *   /schedule cancel <id>
 *
 * Reminders live in the shared `schedules` table with a `transport` column, so
 * the Telegram poller only arms Telegram rows and the WhatsApp bot only arms
 * its own. Delivery goes through the outbox: a reminder that fires while
 * Telegram is unreachable is queued rather than lost.
 */

import {
    dueReminders, pendingForChat, pendingCount, markFired,
    insertReminder, insertMany, newId, type ScheduleRow,
} from "../../../shared/lib/schedules-db.js";
import { parseDateTime, formatDateTime } from "../../../shared/utils/datetime.js";
import { sendText } from "../../../shared/messaging/outbox.js";
import { cmd, feature, type Ctx } from "../lib/command.js";

const TRANSPORT = "telegram" as const;

const POLL_INTERVAL_MS = 30_000;
const ARM_WINDOW_MS = POLL_INTERVAL_MS + 5_000;
const MAX_PER_CHAT = 25;
const MAX_FUTURE_MS = 366 * 24 * 3_600_000;

type Milestone = { offset: number; label: string };

const ESCALATION_LEVELS: Record<string, Milestone[]> = {
    light: [
        { offset: 1 * 24 * 3_600_000, label: "1 day left" },
        { offset: 3 * 3_600_000, label: "3 hours left" },
        { offset: 1 * 3_600_000, label: "1 hour left" },
        { offset: 0, label: "deadline" },
    ],
    balanced: [
        { offset: 7 * 24 * 3_600_000, label: "1 week left" },
        { offset: 1 * 24 * 3_600_000, label: "1 day left" },
        { offset: 12 * 3_600_000, label: "12 hours left" },
        { offset: 3 * 3_600_000, label: "3 hours left" },
        { offset: 1 * 3_600_000, label: "1 hour left" },
        { offset: 0, label: "deadline" },
    ],
    aggressive: [
        { offset: 7 * 24 * 3_600_000, label: "1 week left" },
        { offset: 3 * 24 * 3_600_000, label: "3 days left" },
        { offset: 1 * 24 * 3_600_000, label: "1 day left" },
        { offset: 12 * 3_600_000, label: "12 hours left" },
        { offset: 6 * 3_600_000, label: "6 hours left" },
        { offset: 3 * 3_600_000, label: "3 hours left" },
        { offset: 1 * 3_600_000, label: "1 hour left" },
        { offset: 30 * 60_000, label: "30 minutes left" },
        { offset: 0, label: "deadline" },
    ],
};

const DEFAULT_LEVEL = "balanced";

/*
"auto" adapts the cadence to how far away the deadline is: keep only offsets
smaller than 60% of the runway, so the first ping is never too early and the
pings naturally densify toward the deadline.
*/
const AUTO_LADDER: Milestone[] = [
    { offset: 30 * 24 * 3_600_000, label: "1 month left" },
    { offset: 14 * 24 * 3_600_000, label: "2 weeks left" },
    { offset: 7 * 24 * 3_600_000, label: "1 week left" },
    { offset: 3 * 24 * 3_600_000, label: "3 days left" },
    { offset: 1 * 24 * 3_600_000, label: "1 day left" },
    { offset: 12 * 3_600_000, label: "12 hours left" },
    { offset: 3 * 3_600_000, label: "3 hours left" },
    { offset: 1 * 3_600_000, label: "1 hour left" },
    { offset: 30 * 60_000, label: "30 minutes left" },
    { offset: 0, label: "deadline" },
];
const AUTO_RUNWAY_FACTOR = 0.6;

const VALID_LEVELS = [...Object.keys(ESCALATION_LEVELS), "auto"];

const computeAutoMilestones = (runwayMs: number): Milestone[] => {
    const picked = AUTO_LADDER.filter(m => m.offset === 0 || m.offset < runwayMs * AUTO_RUNWAY_FACTOR);
    return picked.length > 0 ? picked : [{ offset: 0, label: "deadline" }];
};



function humanRemaining(ms: number): string {
    if (ms <= 0) return "now";
    const days = Math.floor(ms / (24 * 3_600_000));
    const hours = Math.floor((ms % (24 * 3_600_000)) / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// IDs that already have a timer armed, so a poll overlap can't double-fire
const armed = new Set<string>();

async function fireReminder(id: string, data: ScheduleRow, overdueMs = 0): Promise<void> {
    /*
    Order matters. The message goes into the durable outbox FIRST and only then
    is the reminder marked fired. Marking first means a send that fails during a
    reconnect leaves the reminder discharged but undelivered - silently losing
    the whole point of the feature.
    */
    try {
        const overdueNote = overdueMs > 60_000
            ? `\n\n⚠️ ${Math.round(overdueMs / 60_000)} min overdue (the bot was offline).`
            : "";

        let text: string;
        if (data.groupId && data.deadlineAt) {
            const isDue = data.deadlineAt - Date.now() <= 60_000;
            const header = isDue ? "🚨 DUE NOW!" : "⏰ Deadline reminder";
            const countdown = isDue
                ? ""
                : `\n⏳ ${data.milestoneLabel} - deadline in ${humanRemaining(data.deadlineAt - Date.now())}`;
            text = `${header}\n\n📌 ${data.activity}\n🎯 Deadline: ${formatDateTime(data.deadlineAt)}${countdown}${overdueNote}`;
        } else {
            text = `⏰ Reminder!\n\n📌 ${data.activity}\n🕐 Scheduled for: ${formatDateTime(data.fireAt)}${overdueNote}`;
        }

        // priority 1 - reminders are time-critical, they jump the queue
        await sendText(TRANSPORT, data.jid, text, { priority: 1 });
        await markFired(id);

        console.log(`⏰ Fired reminder ${id}: "${data.activity}"`);
    } catch (err) {
        console.error(`⏰ Failed to fire reminder ${id}:`, err);
    } finally {
        armed.delete(id);
    }
}

/** Poll for due reminders and arm an exact timer for each. */
export function startScheduleService(): void {
    console.log("⏰ Schedule service started (Telegram).");

    const poll = async (): Promise<void> => {
        try {
            const due = await dueReminders(Date.now() + ARM_WINDOW_MS, TRANSPORT);

            for (const data of due) {
                if (armed.has(data.id)) continue;
                armed.add(data.id);

                const delay = data.fireAt - Date.now();
                if (delay <= 0) void fireReminder(data.id, data, -delay);
                else setTimeout(() => void fireReminder(data.id, data), delay);
            }
        } catch (err) {
            console.error("⏰ Schedule poll error:", err);
        }
    };

    void poll();                      // immediate pass picks up anything missed
    setInterval(poll, POLL_INTERVAL_MS);
}

// ── Subcommands ───────────────────────────────────────────────────────────────

async function listSchedules(ctx: Ctx): Promise<void> {
    const all = await pendingForChat(String(ctx.chatId), TRANSPORT);
    if (all.length === 0) {
        await ctx.reply("📭 No pending reminders in this chat.");
        return;
    }

    const oneShots = all.filter(it => !it.groupId);
    const groups = new Map<string, ScheduleRow[]>();
    for (const it of all) {
        if (!it.groupId) continue;
        groups.set(it.groupId, [...(groups.get(it.groupId) ?? []), it]);
    }

    const entries: { sortAt: number; text: string }[] = oneShots.map(it => ({
        sortAt: it.fireAt,
        text: `• ${it.id.slice(0, 6)} - ${formatDateTime(it.fireAt)}\n  📌 ${it.activity}`,
    }));

    // An escalation group collapses to one line showing the next ping
    for (const [groupId, docs] of groups) {
        docs.sort((a, b) => a.fireAt - b.fireAt);
        const next = docs[0]!;
        entries.push({
            sortAt: next.deadlineAt ?? next.fireAt,
            text:
                `• ${groupId.slice(0, 6)} 🎯 escalating - deadline ${formatDateTime(next.deadlineAt ?? next.fireAt)}\n` +
                `  📌 ${next.activity}\n` +
                `  ⏳ next: ${formatDateTime(next.fireAt)} (${docs.length} ping${docs.length === 1 ? "" : "s"} left)`,
        });
    }

    entries.sort((a, b) => a.sortAt - b.sortAt);
    await ctx.reply(`⏰ Pending reminders:\n\n${entries.map(e => e.text).join("\n")}\n\nCancel with /schedule cancel <id>`);
}

async function cancelSchedule(ctx: Ctx, idPrefix: string): Promise<void> {
    const docs = await pendingForChat(String(ctx.chatId), TRANSPORT);

    const groupMatches = docs.filter(d => d.groupId && d.groupId.startsWith(idPrefix));
    if (groupMatches.length > 0) {
        for (const d of groupMatches) {
            await markFired(d.id);
            armed.delete(d.id);
        }
        await ctx.reply(
            `🗑️ Cancelled escalating reminder ${idPrefix} ` +
            `(${groupMatches.length} pending ping${groupMatches.length === 1 ? "" : "s"})\n📌 ${groupMatches[0]!.activity}`
        );
        return;
    }

    const docMatch = docs.find(d => d.id.startsWith(idPrefix));
    if (docMatch) {
        await markFired(docMatch.id);
        armed.delete(docMatch.id);
        await ctx.reply(`🗑️ Cancelled reminder ${docMatch.id.slice(0, 6)}\n📌 ${docMatch.activity}`);
        return;
    }

    await ctx.reply(`❌ No pending reminder with ID ${idPrefix}. Use /schedule list to see IDs.`);
}

const schedule = cmd("schedule", {
    aliases: ["remind", "timer"],
    description: "Set a precise reminder, or an escalating one with --escalate",
    args: "[--escalate] <datetime> <activity>",
    usageHint:
        "Usage: /schedule <datetime> <activity>\n\n" +
        "Examples:\n" +
        "• /schedule 25/12/2026 14:30 buy dinner\n" +
        "• /schedule tomorrow 9am call dentist\n" +
        "• /schedule in 45m check the oven\n" +
        "• /schedule 18:00 gym\n\n" +
        "Escalating (more pings as the deadline nears):\n" +
        "• /schedule --escalate 30/06/2026 09:00 final exam\n" +
        "• Levels: =light  =balanced  =aggressive  =auto\n\n" +
        "Other: /schedule list · /schedule cancel <id>",
    requiresArgs: true,
}, async (ctx: Ctx) => {
    if (ctx.sub === "list") { await listSchedules(ctx); return; }
    if (ctx.sub === "cancel") {
        if (!ctx.arg(1)) { await ctx.reply("Usage: /schedule cancel <id>"); return; }
        await cancelSchedule(ctx, ctx.arg(1)!);
        return;
    }

    let escalate = false;
    let level = DEFAULT_LEVEL;
    let tokens = [...ctx.args];

    const flag = tokens[0]?.match(/^(--escalate|-e)(?:=(\w+))?$/i);
    if (flag) {
        escalate = true;
        const requested = (flag[2] ?? "").toLowerCase();
        if (requested && !VALID_LEVELS.includes(requested)) {
            await ctx.reply(
                `❌ Unknown escalation level: ${requested}\n\nValid: ${VALID_LEVELS.join(", ")}\n` +
                `Example: /schedule --escalate=auto 30/09/2026 09:00 final project`
            );
            return;
        }
        if (requested) level = requested;
        tokens = tokens.slice(1);
    }

    if (tokens.length === 0) { await ctx.reply("Usage: /schedule <datetime> <activity>"); return; }

    const parsed = parseDateTime(tokens);
    if (!parsed) {
        await ctx.reply(
            `❌ Couldn't understand the date/time: ${tokens.slice(0, 2).join(" ")}\n\n` +
            "Try 25/12/2026 14:30, tomorrow 9am, in 45m, or 18:00."
        );
        return;
    }

    const activity = tokens.slice(parsed.consumed).join(" ").trim();
    if (!activity) { await ctx.reply("⚠️ Please say what the reminder is for."); return; }

    const now = Date.now();
    if (parsed.epochMs <= now) {
        await ctx.reply(`❌ That time is in the past: ${formatDateTime(parsed.epochMs)}`);
        return;
    }
    if (parsed.epochMs > now + MAX_FUTURE_MS) {
        await ctx.reply("❌ Reminders can be at most 1 year in the future.");
        return;
    }

    const pendingTotal = await pendingCount(String(ctx.chatId), TRANSPORT);

    if (escalate) {
        const deadline = parsed.epochMs;
        const offsets = level === "auto"
            ? computeAutoMilestones(deadline - now)
            : ESCALATION_LEVELS[level]!;

        /*
        Label each ping by how long is left when it fires - which is what the
        ladder's own labels already say.

        This used to label by `fireAt - now`, the gap between creating the
        reminder and the ping, while still wording it as "left". A deadline 7
        days and 1 hour out made the "1 hour left" ping announce "7 days left"
        next to a correct "deadline in 59m" countdown.
        */
        const milestones = offsets
            .map(m => ({ fireAt: deadline - m.offset, label: m.label }))
            .filter(m => m.fireAt > now);

        // Always guarantee the deadline itself fires
        if (milestones.length === 0) {
            milestones.push({ fireAt: deadline, label: "deadline" });
        }

        if (pendingTotal + milestones.length > MAX_PER_CHAT) {
            await ctx.reply(
                `❌ That needs ${milestones.length} slots but this chat is near the ${MAX_PER_CHAT} cap. Cancel some first.`
            );
            return;
        }

        const groupId = newId();
        await insertMany(milestones.map((m, i) => ({
            id: i === 0 ? groupId : newId(),
            jid: String(ctx.chatId),
            activity,
            fireAt: m.fireAt,
            requester: String(ctx.userId),
            fired: false,
            groupId,
            deadlineAt: deadline,
            milestoneLabel: m.label,
            transport: TRANSPORT,
        })));

        await ctx.reply(
            `✅ Escalating reminder set (${level})\n\n📌 ${activity}\n` +
            `🎯 Deadline: ${formatDateTime(deadline)}\n` +
            `🔔 ${milestones.length} ping${milestones.length === 1 ? "" : "s"}:\n` +
            milestones.map(m => `   • ${formatDateTime(m.fireAt)} (${m.label})`).join("\n") +
            `\n\n🆔 ${groupId.slice(0, 6)}`
        );
        return;
    }

    if (pendingTotal >= MAX_PER_CHAT) {
        await ctx.reply(`❌ This chat already has ${MAX_PER_CHAT} pending reminders. Cancel some first.`);
        return;
    }

    const id = newId();
    await insertReminder({
        id,
        jid: String(ctx.chatId),
        activity,
        fireAt: parsed.epochMs,
        requester: String(ctx.userId),
        fired: false,
        groupId: null,
        deadlineAt: null,
        milestoneLabel: null,
        transport: TRANSPORT,
    });

    const inMs = parsed.epochMs - now;
    const inHuman = inMs < 3_600_000
        ? `${Math.round(inMs / 60_000)} min`
        : inMs < 24 * 3_600_000
            ? `${(inMs / 3_600_000).toFixed(1)} hours`
            : `${(inMs / (24 * 3_600_000)).toFixed(1)} days`;

    await ctx.reply(
        `✅ Reminder set!\n\n📌 ${activity}\n🕐 ${formatDateTime(parsed.epochMs)}\n` +
        `⏳ In about ${inHuman}\n🆔 ${id.slice(0, 6)}`
    );
});

export default feature("reminder", [schedule]);
