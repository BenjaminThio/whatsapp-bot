import { WAMessage } from "@whiskeysockets/baileys";
import {
    dueReminders, pendingForChat, pendingCount, markFired,
    insertReminder, insertMany, newId, type ScheduleRow,
} from "../lib/schedules-db.js";
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

/*
Escalation intensity levels - pick one with --escalate=<level>.
Each is a list of how long BEFORE the deadline a ping fires. Only milestones
still in the future at creation time get scheduled, so a near deadline auto-skips
the far pings. You fully control these - add/remove rows to taste.

  light      - minimal nagging, just the essentials
  balanced   - sensible default for most deadlines (exams, assignments)
  aggressive - frequent pings, for things you absolutely cannot miss
*/
type Milestone = { offset: number; label: string };

const ESCALATION_LEVELS: Record<string, Milestone[]> = {
    light: [
        { offset: 1 * 24 * 3_600_000, label: "1 day left"  },
        { offset: 3 * 3_600_000,      label: "3 hours left" },
        { offset: 1 * 3_600_000,      label: "1 hour left"  },
        { offset: 0,                  label: "Now / due"    },
    ],
    balanced: [
        { offset: 7 * 24 * 3_600_000, label: "1 week left"   },
        { offset: 1 * 24 * 3_600_000, label: "1 day left"    },
        { offset: 12 * 3_600_000,     label: "12 hours left" },
        { offset: 3 * 3_600_000,      label: "3 hours left"  },
        { offset: 1 * 3_600_000,      label: "1 hour left"   },
        { offset: 0,                  label: "Now / due"     },
    ],
    aggressive: [
        { offset: 7 * 24 * 3_600_000, label: "1 week left"    },
        { offset: 3 * 24 * 3_600_000, label: "3 days left"    },
        { offset: 1 * 24 * 3_600_000, label: "1 day left"     },
        { offset: 12 * 3_600_000,     label: "12 hours left"  },
        { offset: 6 * 3_600_000,      label: "6 hours left"   },
        { offset: 3 * 3_600_000,      label: "3 hours left"   },
        { offset: 1 * 3_600_000,      label: "1 hour left"    },
        { offset: 30 * 60_000,        label: "30 minutes left" },
        { offset: 0,                  label: "Now / due"      },
    ],
};

const DEFAULT_LEVEL = "balanced";
// An escalating reminder can create at most this many docs (longest level)
const MAX_ESCALATION_DOCS = Math.max(...Object.values(ESCALATION_LEVELS).map(l => l.length));

/*
"auto" level - adapts the cadence to how far away the deadline is.

A full ladder of candidate offsets (1 month => 30 min => deadline). For a given
runway we keep only offsets smaller than 60% of the total time, so the first
ping is never too early and the cadence naturally densifies toward the deadline.

  3-month project => month, 2 weeks, week, 3 days, day, 12h, 3h, 1h, 30m, due
  3-day task      => day, 12h, 3h, 1h, 30m, due
  4-hour task     => 1h, 30m, due
  20-min task     => due only
*/
const AUTO_LADDER: Milestone[] = [
    { offset: 30 * 24 * 3_600_000, label: "1 month left"    },
    { offset: 14 * 24 * 3_600_000, label: "2 weeks left"    },
    { offset: 7 * 24 * 3_600_000,  label: "1 week left"     },
    { offset: 3 * 24 * 3_600_000,  label: "3 days left"     },
    { offset: 1 * 24 * 3_600_000,  label: "1 day left"      },
    { offset: 12 * 3_600_000,      label: "12 hours left"   },
    { offset: 3 * 3_600_000,       label: "3 hours left"    },
    { offset: 1 * 3_600_000,       label: "1 hour left"     },
    { offset: 30 * 60_000,         label: "30 minutes left" },
    { offset: 0,                   label: "Now / due"       },
];

// How small a ping's offset must be relative to the runway to be included.
// 0.6 => the first ping fires once ~40% of the runway has elapsed.
const AUTO_RUNWAY_FACTOR = 0.6;

/**
 * Compute auto milestones for a deadline `runwayMs` away.
 * Always returns at least the deadline itself.
 */
function computeAutoMilestones(runwayMs: number): Milestone[] {
    const picked = AUTO_LADDER.filter(m => m.offset === 0 || m.offset < runwayMs * AUTO_RUNWAY_FACTOR);
    return picked.length > 0 ? picked : [{ offset: 0, label: "Now / due" }];
}

// Valid level names for the flag (the fixed ones plus "auto")
const VALID_LEVELS = [...Object.keys(ESCALATION_LEVELS), "auto"];

// Reminder shape used throughout this file. Matches ScheduleRow from schedules-db,
// but groupId/deadlineAt/milestoneLabel may be null for plain one-shot reminders.
type ScheduleDoc = ScheduleRow;

// IDs that already have an in-memory timer armed, to prevent double-firing
const armed = new Set<string>();

async function fireReminder(sock: any, id: string, data: ScheduleDoc, overdueMs = 0) {
    try {
        // Mark fired FIRST so a crash mid-send can't cause a double fire on restart
        await markFired(id);

        const overdueNote = overdueMs > 60_000
            ? `\n\n_⚠️ This reminder is ${Math.round(overdueMs / 60_000)} min overdue (bot was offline)._`
            : "";

        let text: string;
        if (data.groupId && data.deadlineAt) {
            // Escalating reminder - show urgency + exact time remaining to deadline
            const isDue = data.milestoneLabel === "Now / due" || data.deadlineAt - Date.now() <= 60_000;
            const header = isDue ? "🚨 *DUE NOW!*" : "⏰ *Deadline Reminder*";
            const remaining = humanRemaining(data.deadlineAt - Date.now());
            const countdown = isDue
                ? ""
                : `\n⏳ *${data.milestoneLabel}* - deadline in ${remaining}`;
            text =
                `${header}\n\n📌 ${data.activity}\n` +
                `🎯 Deadline: ${formatDateTime(data.deadlineAt)}${countdown}${overdueNote}`;
        } else {
            // Plain one-shot reminder (unchanged behaviour)
            text = `⏰ *Reminder!*\n\n📌 ${data.activity}\n🕐 Scheduled for: ${formatDateTime(data.fireAt)}${overdueNote}`;
        }

        await sock.sendMessage(data.jid, { text });
        console.log(`⏰ Fired reminder ${id}: "${data.activity}"${data.milestoneLabel ? ` [${data.milestoneLabel}]` : ""}`);
    } catch (err) {
        console.error(`⏰ Failed to fire reminder ${id}:`, err);
    } finally {
        armed.delete(id);
    }
}

// Human-readable "time remaining" for escalation countdowns
function humanRemaining(ms: number): string {
    if (ms <= 0) return "now";
    const days = Math.floor(ms / (24 * 3_600_000));
    const hours = Math.floor((ms % (24 * 3_600_000)) / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// Call once from index.ts when the connection opens (like startBirthdayScheduler).
export function startScheduleService(sock: any) {
    console.log("⏰ Schedule service started.");

    const poll = async () => {
        try {
            const now = Date.now();
            // Everything unfired that is due within the arming window (or overdue)
            const due = await dueReminders(now + ARM_WINDOW_MS);

            for (const data of due) {
                if (armed.has(data.id)) continue;
                armed.add(data.id);

                const delay = data.fireAt - Date.now();
                if (delay <= 0) {
                    // Overdue (missed while offline, or just hit) - fire now
                    void fireReminder(sock, data.id, data, -delay);
                } else {
                    setTimeout(() => void fireReminder(sock, data.id, data), delay);
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
    const all = await pendingForChat(msg.key.remoteJid!);

    if (all.length === 0) {
        await sock.sendMessage(msg.key.remoteJid!, { text: "📭 No pending reminders in this chat." }, { quoted: msg });
        return;
    }

    type ScheduleWithId = ScheduleRow;

    // Split into plain one-shots and escalation groups
    const oneShots = all.filter((it: ScheduleWithId) => !it.groupId);
    const groups = new Map<string, ScheduleWithId[]>();
    for (const it of all) {
        if (!it.groupId) continue;
        const arr = groups.get(it.groupId) ?? [];
        arr.push(it);
        groups.set(it.groupId, arr);
    }

    const entries: { sortAt: number; text: string }[] = [];

    // One-shot reminders
    for (const it of oneShots) {
        entries.push({
            sortAt: it.fireAt,
            text: `• \`${it.id.slice(0, 6)}\` - ${formatDateTime(it.fireAt)}\n  📌 ${it.activity}`,
        });
    }

    // Escalation groups - collapse into a single entry showing the next ping
    for (const [groupId, docs] of groups) {
        docs.sort((a: ScheduleWithId, b: ScheduleWithId) => a.fireAt - b.fireAt);
        const next = docs[0];
        const deadline = next.deadlineAt ?? next.fireAt;
        const remainingPings = docs.length;
        entries.push({
            sortAt: deadline,
            text:
                `• \`${groupId.slice(0, 6)}\` 🎯 *escalating* - deadline ${formatDateTime(deadline)}\n` +
                `  📌 ${next.activity}\n` +
                `  ⏳ next ping: ${formatDateTime(next.fireAt)} (${remainingPings} ping${remainingPings === 1 ? "" : "s"} left)`,
        });
    }

    entries.sort((a, b) => a.sortAt - b.sortAt);

    const lines = ["⏰ *Pending reminders:*\n", ...entries.map(e => e.text)];
    lines.push("\n_Cancel with `!schedule cancel <id>`_");
    await sock.sendMessage(msg.key.remoteJid!, { text: lines.join("\n") }, { quoted: msg });
}

// Subcommand: cancel
async function cancelSchedule(sock: any, msg: WAMessage, idPrefix: string) {
    type ScheduleWithId = ScheduleRow;
    const docs = await pendingForChat(msg.key.remoteJid!);

    // Match either a group (by groupId prefix) or a single doc (by doc id prefix)
    const groupMatches = docs.filter((d: ScheduleWithId) => d.groupId && d.groupId.startsWith(idPrefix));
    const docMatch = docs.find((d: ScheduleWithId) => d.id.startsWith(idPrefix));

    if (groupMatches.length > 0) {
        // Cancel every remaining milestone in the escalation group
        for (const d of groupMatches) {
            await markFired(d.id);
            armed.delete(d.id);
        }
        await sock.sendMessage(msg.key.remoteJid!, {
            text:
                `🗑️ Cancelled escalating reminder \`${idPrefix}\` ` +
                `(${groupMatches.length} pending ping${groupMatches.length === 1 ? "" : "s"})\n` +
                `📌 ${groupMatches[0].activity}`
        }, { quoted: msg });
        return;
    }

    if (docMatch) {
        await markFired(docMatch.id);
        armed.delete(docMatch.id);
        await sock.sendMessage(msg.key.remoteJid!, {
            text: `🗑️ Cancelled reminder \`${docMatch.id.slice(0, 6)}\`\n📌 ${docMatch.activity}`
        }, { quoted: msg });
        return;
    }

    await sock.sendMessage(msg.key.remoteJid!, {
        text: `❌ No pending reminder found with ID \`${idPrefix}\`. Use \`!schedule list\` to see IDs.`
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
                "*Escalating* (more frequent pings as the deadline nears):\n" +
                "• `!schedule --escalate 30/06/2026 09:00 final exam`\n" +
                "• Levels: `=light` · `=balanced` · `=aggressive` · `=auto`\n" +
                "• `=auto` adapts the cadence to how far away the deadline is\n\n" +
                "*Other:* `!schedule list` · `!schedule cancel <id>`"
        }, { quoted: msg });
        return;
    }

    // Detect the escalation flag and optional level:
    //   --escalate            => balanced (default)
    //   --escalate=light      => light
    //   --escalate=aggressive => aggressive
    //   -e=light / -e         => same, short form
    let escalate = false;
    let escalateLevel = DEFAULT_LEVEL;
    let working = raw;
    const flagMatch = working.match(/^(--escalate|-e)(=(\w+))?\s+/i);
    if (flagMatch) {
        escalate = true;
        const requested = (flagMatch[3] ?? "").toLowerCase();
        if (requested && VALID_LEVELS.includes(requested)) {
            escalateLevel = requested;
        } else if (requested) {
            // Unknown level - tell the user the valid options
            await sock.sendMessage(msg.key.remoteJid, {
                text:
                    `❌ Unknown escalation level: \`${requested}\`\n\n` +
                    `Valid levels: ${VALID_LEVELS.map(l => `\`${l}\``).join(", ")}\n` +
                    `Example: \`!schedule --escalate=auto 30/09/2026 09:00 final project\``
            }, { quoted: msg });
            return;
        }
        working = working.slice(flagMatch[0].length).trim();
    }

    const tokens = working.split(/\s+/);

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

    // Cap pending reminders per chat (count groups as 1 toward the cap visually,
    // but each doc still counts - so check against the raw doc count + what we'd add)
    const pendingTotal = await pendingCount(msg.key.remoteJid);

    // Escalating reminder: expand into one doc per future milestone
    if (escalate) {
        const deadline = parsed.epochMs;

        // "auto" computes offsets from the runway; fixed levels use their array
        const offsets = escalateLevel === "auto"
            ? computeAutoMilestones(deadline - now)
            : ESCALATION_LEVELS[escalateLevel];

        // Build the list of milestone fire-times that are still in the future
        const milestones = offsets
            .map(m => ({ fireAt: deadline - m.offset, label: m.label }))
            .filter(m => m.fireAt > now);   // skip milestones already in the past

        // Always guarantee at least the deadline itself fires
        if (milestones.length === 0) {
            milestones.push({ fireAt: deadline, label: "Now / due" });
        }

        if (pendingTotal + milestones.length > MAX_PER_CHAT) {
            await sock.sendMessage(msg.key.remoteJid, {
                text:
                    `❌ This escalating reminder needs ${milestones.length} slots but the chat ` +
                    `is near the ${MAX_PER_CHAT}-reminder cap. Cancel some first.`
            }, { quoted: msg });
            return;
        }

        // Shared group id = the id of the FIRST milestone row
        const groupId = newId();
        const requester = msg.key.participant || msg.key.remoteJid;

        const rows: ScheduleRow[] = milestones.map((m, i) => ({
            id:             i === 0 ? groupId : newId(),
            jid:            msg.key.remoteJid!,
            activity,
            fireAt:         m.fireAt,
            requester,
            fired:          false,
            groupId,
            deadlineAt:     deadline,
            milestoneLabel: m.label,
        }));
        await insertMany(rows);

        const pingTimes = milestones
            .map(m => `   • ${formatDateTime(m.fireAt)} _(${m.label})_`)
            .join("\n");

        await sock.sendMessage(msg.key.remoteJid, {
            text:
                `✅ *Escalating reminder set!* _(${escalateLevel})_\n\n` +
                `📌 ${activity}\n` +
                `🎯 Deadline: ${formatDateTime(deadline)}\n` +
                `🔔 ${milestones.length} ping${milestones.length === 1 ? "" : "s"} scheduled:\n${pingTimes}\n\n` +
                `🆔 \`${groupId.slice(0, 6)}\``
        }, { quoted: msg });
        return;
    }

    // Plain one-shot reminder (unchanged)
    if (pendingTotal >= MAX_PER_CHAT) {
        await sock.sendMessage(msg.key.remoteJid, {
            text: `❌ This chat already has ${MAX_PER_CHAT} pending reminders. Cancel some first.`
        }, { quoted: msg });
        return;
    }

    const newReminderId = newId();
    await insertReminder({
        id:             newReminderId,
        jid:            msg.key.remoteJid,
        activity,
        fireAt:         parsed.epochMs,
        requester:      msg.key.participant || msg.key.remoteJid,
        fired:          false,
        groupId:        null,
        deadlineAt:     null,
        milestoneLabel: null,
    });

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
            `🆔 \`${newReminderId.slice(0, 6)}\``
    }, { quoted: msg });
}

const command: Command = {
    name: "schedule",
    aliases: ["remind", "timer"],
    description: "Set a precise one-shot reminder, or an escalating one with --escalate",
    usage: "!schedule [--escalate] <datetime> <activity>",
    requiresArgs: true,
    handler: handleSchedule,
};

export default command;