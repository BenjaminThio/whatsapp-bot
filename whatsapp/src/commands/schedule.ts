import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import {
    dueReminders, pendingForChat, pendingCount, markFired,
    insertReminder, insertMany, newId, type ScheduleRow,
} from "../../../shared/lib/schedules-db.js";
import { Command, CommandContext } from "./_types.js";
import { parseDateTime, formatDateTime } from "../../../shared/utils/datetime.js";
import { queueText } from "../lib/outbox.js";
import { cmd } from "../config/prefixes.js";

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
Escalation intensity levels — pick one with --escalate=<level>.
Each is a list of how long BEFORE the deadline a ping fires. Only milestones
still in the future at creation time get scheduled, so a near deadline auto-skips
the far pings. You fully control these — add/remove rows to taste.

  light      — minimal nagging, just the essentials
  balanced   — sensible default for most deadlines (exams, assignments)
  aggressive — frequent pings, for things you absolutely cannot miss
*/
type Milestone = { offset: number; label: string };

const ESCALATION_LEVELS: Record<string, Milestone[]> = {
    light: [
        { offset: 1 * 24 * 3_600_000, label: "1 day left"  },
        { offset: 3 * 3_600_000,      label: "3 hours left" },
        { offset: 1 * 3_600_000,      label: "1 hour left"  },
        { offset: 0,                  label: "deadline"     },
    ],
    balanced: [
        { offset: 7 * 24 * 3_600_000, label: "1 week left"   },
        { offset: 1 * 24 * 3_600_000, label: "1 day left"    },
        { offset: 12 * 3_600_000,     label: "12 hours left" },
        { offset: 3 * 3_600_000,      label: "3 hours left"  },
        { offset: 1 * 3_600_000,      label: "1 hour left"   },
        { offset: 0,                  label: "deadline"      },
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
        { offset: 0,                  label: "deadline"       },
    ],
};

const DEFAULT_LEVEL = "balanced";
// An escalating reminder can create at most this many docs (longest level)
const MAX_ESCALATION_DOCS = Math.max(...Object.values(ESCALATION_LEVELS).map(l => l.length));

/*
"auto" level — adapts the cadence to how far away the deadline is.

A full ladder of candidate offsets (1 month → 30 min → deadline). For a given
runway we keep only offsets smaller than 60% of the total time, so the first
ping is never too early and the cadence naturally densifies toward the deadline.

  3-month project → month, 2 weeks, week, 3 days, day, 12h, 3h, 1h, 30m, due
  3-day task      → day, 12h, 3h, 1h, 30m, due
  4-hour task     → 1h, 30m, due
  20-min task     → due only
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
    { offset: 0,                   label: "deadline"        },
];

// How small a ping's offset must be relative to the runway to be included.
// 0.6 → the first ping fires once ~40% of the runway has elapsed.
const AUTO_RUNWAY_FACTOR = 0.6;

/**
 * Compute auto milestones for a deadline `runwayMs` away.
 * Always returns at least the deadline itself.
 */
function computeAutoMilestones(runwayMs: number): Milestone[] {
    const picked = AUTO_LADDER.filter(m => m.offset === 0 || m.offset < runwayMs * AUTO_RUNWAY_FACTOR);
    return picked.length > 0 ? picked : [{ offset: 0, label: "deadline" }];
}

// Valid level names for the flag (the fixed ones plus "auto")
const VALID_LEVELS = [...Object.keys(ESCALATION_LEVELS), "auto"];

// Reminder shape used throughout this file. Matches ScheduleRow from schedules-db,
// but groupId/deadlineAt/milestoneLabel may be null for plain one-shot reminders.
type ScheduleDoc = ScheduleRow;

// IDs that already have an in-memory timer armed, to prevent double-firing
const armed = new Set<string>();

async function fireReminder(id: string, data: ScheduleDoc, overdueMs = 0) {
    /*
    Order matters here.

    This used to call markFired() FIRST and then sock.sendMessage(). If the
    socket was down — a reconnect lasting a few seconds is enough — the send
    threw, the catch just logged it, and the reminder stayed marked as fired.
    It was then never delivered and never retried. Silently losing the whole
    point of the feature.

    Now the message goes into the durable outbox, which cannot fail for
    connection reasons, and only then is the reminder marked fired. The outbox
    retries delivery until it lands, so a disconnect delays a reminder instead
    of destroying it.
    */
    try {
        const overdueNote = overdueMs > 60_000
            ? `\n\n_⚠️ This reminder is ${Math.round(overdueMs / 60_000)} min overdue (bot was offline)._`
            : "";

        let text: string;
        if (data.groupId && data.deadlineAt) {
            // Escalating reminder — show urgency + exact time remaining to deadline
            // Labels are lead-time based now, so decide "due" purely by the clock
            const isDue = data.deadlineAt - Date.now() <= 60_000;
            const header = isDue ? "🚨 *DUE NOW!*" : "⏰ *Deadline Reminder*";
            const remaining = humanRemaining(data.deadlineAt - Date.now());
            const countdown = isDue
                ? ""
                : `\n⏳ *${data.milestoneLabel}* — deadline in ${remaining}`;
            text =
                `${header}\n\n📌 ${data.activity}\n` +
                `🎯 Deadline: ${formatDateTime(data.deadlineAt)}${countdown}${overdueNote}`;
        } else {
            // Plain one-shot reminder (unchanged behaviour)
            text = `⏰ *Reminder!*\n\n📌 ${data.activity}\n🕐 Scheduled for: ${formatDateTime(data.fireAt)}${overdueNote}`;
        }

        // Durable: survives a closed socket, a crash, or a restart.
        // priority 1 — reminders are time-critical, they jump the queue.
        await queueText(data.jid, text, { priority: 1 });

        // Only now is it safe to consider this reminder discharged.
        await markFired(id);

        console.log(`⏰ Fired reminder ${id}: "${data.activity}"${data.milestoneLabel ? ` [${data.milestoneLabel}]` : ""}`);
    } catch (err) {
        console.error(`⏰ Failed to fire reminder ${id}:`, err);
    } finally {
        armed.delete(id);
    }
}


/*
Label a ping by how far it is from the moment the reminder is CREATED — not by
how far it is before the deadline. So a 12-hour reminder created now produces
"9 hours left", "11 hours left", "12 hours left" for pings at +9h, +11h, +12h.
The final deadline ping uses the same format (no "Now / due").
*/
function leadTimeLabel(msFromNow: number): string {
    const mins = Math.max(0, Math.round(msFromNow / 60_000));

    if (mins < 60) {
        return `${mins} minute${mins === 1 ? "" : "s"} left`;
    }

    const hours = Math.round(mins / 60);
    if (hours < 48) {
        return `${hours} hour${hours === 1 ? "" : "s"} left`;
    }

    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} left`;
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

/*
Call once from index.ts when the connection opens.

The socket is deliberately not captured: every send goes through the outbox,
which reads the live socket at delivery time. A reconnect used to leave this
service holding a dead socket.
*/
export function startScheduleService(_sockIgnored?: any) {
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
                    void fireReminder(data.id, data, -delay);
                } else {
                    setTimeout(() => void fireReminder(data.id, data), delay);
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
async function listSchedules(ctx: CommandContext) {
    const all = await pendingForChat(ctx.chatId);

    if (all.length === 0) {
        await ctx.replyText("📭 No pending reminders in this chat.");
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
            text: `• \`${it.id.slice(0, 6)}\` — ${formatDateTime(it.fireAt)}\n  📌 ${it.activity}`,
        });
    }

    // Escalation groups — collapse into a single entry showing the next ping
    for (const [groupId, docs] of groups) {
        docs.sort((a: ScheduleWithId, b: ScheduleWithId) => a.fireAt - b.fireAt);
        const next = docs[0];
        const deadline = next.deadlineAt ?? next.fireAt;
        const remainingPings = docs.length;
        entries.push({
            sortAt: deadline,
            text:
                `• \`${groupId.slice(0, 6)}\` 🎯 *escalating* — deadline ${formatDateTime(deadline)}\n` +
                `  📌 ${next.activity}\n` +
                `  ⏳ next ping: ${formatDateTime(next.fireAt)} (${remainingPings} ping${remainingPings === 1 ? "" : "s"} left)`,
        });
    }

    entries.sort((a, b) => a.sortAt - b.sortAt);

    const lines = ["⏰ *Pending reminders:*\n", ...entries.map(e => e.text)];
    lines.push(`\n_Cancel with \`${cmd("schedule cancel")} <id>\`_`);
    await ctx.replyText(lines.join("\n"));
}

// Subcommand: cancel
async function cancelSchedule(ctx: CommandContext, idPrefix: string) {
    type ScheduleWithId = ScheduleRow;
    const docs = await pendingForChat(ctx.chatId);

    // Match either a group (by groupId prefix) or a single doc (by doc id prefix)
    const groupMatches = docs.filter((d: ScheduleWithId) => d.groupId && d.groupId.startsWith(idPrefix));
    const docMatch = docs.find((d: ScheduleWithId) => d.id.startsWith(idPrefix));

    if (groupMatches.length > 0) {
        // Cancel every remaining milestone in the escalation group
        for (const d of groupMatches) {
            await markFired(d.id);
            armed.delete(d.id);
        }
        await ctx.replyText(
            `🗑️ Cancelled escalating reminder \`${idPrefix}\` ` +
            `(${groupMatches.length} pending ping${groupMatches.length === 1 ? "" : "s"})\n` +
            `📌 ${groupMatches[0].activity}`
        );
        return;
    }

    if (docMatch) {
        await markFired(docMatch.id);
        armed.delete(docMatch.id);
        await ctx.replyText(`🗑️ Cancelled reminder \`${docMatch.id.slice(0, 6)}\`\n📌 ${docMatch.activity}`);
        return;
    }

    await ctx.replyText(
        `❌ No pending reminder found with ID \`${idPrefix}\`. ` +
        `Use \`${cmd("schedule list")}\` to see IDs.`
    );
}

// Main handler
async function handleSchedule(_sock: WASocket, msg: WAMessage, _text: string, ctx: CommandContext) {
    // Subcommands first - they don't take the escalation flag
    if (ctx.sub === "list") {
        await listSchedules(ctx);
        return;
    }
    if (ctx.sub === "cancel") {
        if (!ctx.arg(1)) {
            await ctx.replyText(`⚠️ *Usage:* \`${cmd("schedule cancel")} <id>\``);
            return;
        }
        await cancelSchedule(ctx, ctx.arg(1)!);
        return;
    }

    /*
    Detect the escalation flag and optional level:
      --escalate            -> balanced (default)
      --escalate=light      -> light
      -e=light / -e         -> same, short form
    */
    let escalate = false;
    let escalateLevel = DEFAULT_LEVEL;
    let tokens = [...ctx.args];

    const flagMatch = tokens[0]?.match(/^(--escalate|-e)(?:=(\w+))?$/i);
    if (flagMatch) {
        escalate = true;
        const requested = (flagMatch[2] ?? "").toLowerCase();
        if (requested && VALID_LEVELS.includes(requested)) {
            escalateLevel = requested;
        } else if (requested) {
            await ctx.replyText(
                `❌ Unknown escalation level: \`${requested}\`\n\n` +
                `Valid levels: ${VALID_LEVELS.map(l => `\`${l}\``).join(", ")}\n` +
                `Example: \`${cmd("schedule")} --escalate=auto 30/09/2026 09:00 final project\``
            );
            return;
        }
        tokens = tokens.slice(1);
    }

    if (tokens.length === 0) {
        await ctx.sendUsage();
        return;
    }

    // Parse the leading datetime
    const parsed = parseDateTime(tokens);
    if (!parsed) {
        await ctx.replyText(
            `❌ Couldn't understand the date/time: \`${tokens.slice(0, 2).join(" ")}\`\n\n` +
            "Try formats like `25/12/2026 14:30`, `tomorrow 9am`, `in 45m`, or `18:00`."
        );
        return;
    }

    const activity = tokens.slice(parsed.consumed).join(" ").trim();
    if (!activity) {
        await ctx.replyText(
            `⚠️ Please include what the reminder is for: \`${cmd("schedule")} <datetime> <activity>\``
        );
        return;
    }

    const now = Date.now();
    if (parsed.epochMs <= now) {
        await ctx.replyText(`❌ That time is in the past: ${formatDateTime(parsed.epochMs)}`);
        return;
    }
    if (parsed.epochMs > now + MAX_FUTURE_MS) {
        await ctx.replyText("❌ Reminders can be at most 1 year in the future.");
        return;
    }

    // Cap pending reminders per chat (count groups as 1 toward the cap visually,
    // but each doc still counts — so check against the raw doc count + what we'd add)
    const pendingTotal = await pendingCount(ctx.chatId);

    // ── Escalating reminder: expand into one doc per future milestone ─────────
    if (escalate) {
        const deadline = parsed.epochMs;

        // "auto" computes offsets from the runway; fixed levels use their array
        const offsets = escalateLevel === "auto"
            ? computeAutoMilestones(deadline - now)
            : ESCALATION_LEVELS[escalateLevel];

        // Build the list of milestone fire-times that are still in the future
        const milestones = offsets
            .map(m => {
                const fireAt = deadline - m.offset;
                // Label by lead time from NOW, not by distance before the deadline
                return { fireAt, label: leadTimeLabel(fireAt - now) };
            })
            .filter(m => m.fireAt > now);   // skip milestones already in the past

        // Always guarantee at least the deadline itself fires
        if (milestones.length === 0) {
            milestones.push({ fireAt: deadline, label: leadTimeLabel(deadline - now) });
        }

        if (pendingTotal + milestones.length > MAX_PER_CHAT) {
            await ctx.replyText(
                `❌ This escalating reminder needs ${milestones.length} slots but the chat ` +
                `is near the ${MAX_PER_CHAT}-reminder cap. Cancel some first.`
            );
            return;
        }

        // Shared group id = the id of the FIRST milestone row
        const groupId = newId();

        const rows: ScheduleRow[] = milestones.map((m, i) => ({
            id:             i === 0 ? groupId : newId(),
            jid:            ctx.chatId,
            activity,
            fireAt:         m.fireAt,
            requester:      ctx.userId,
            fired:          false,
            groupId,
            deadlineAt:     deadline,
            milestoneLabel: m.label,
        }));
        await insertMany(rows);

        const pingTimes = milestones
            .map(m => `   • ${formatDateTime(m.fireAt)} _(${m.label})_`)
            .join("\n");

        await ctx.replyText(
            `✅ *Escalating reminder set!* _(${escalateLevel})_\n\n` +
            `📌 ${activity}\n` +
            `🎯 Deadline: ${formatDateTime(deadline)}\n` +
            `🔔 ${milestones.length} ping${milestones.length === 1 ? "" : "s"} scheduled:\n${pingTimes}\n\n` +
            `🆔 \`${groupId.slice(0, 6)}\``
        );
        return;
    }

    // ── Plain one-shot reminder ──────────────────────────────────────────────
    if (pendingTotal >= MAX_PER_CHAT) {
        await ctx.replyText(`❌ This chat already has ${MAX_PER_CHAT} pending reminders. Cancel some first.`);
        return;
    }

    const newReminderId = newId();
    await insertReminder({
        id:             newReminderId,
        jid:            ctx.chatId,
        activity,
        fireAt:         parsed.epochMs,
        requester:      ctx.userId,
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

    await ctx.replyText(
        `✅ *Reminder set!*\n\n` +
        `📌 ${activity}\n` +
        `🕐 ${formatDateTime(parsed.epochMs)}\n` +
        `⏳ In about ${inHuman}\n` +
        `🆔 \`${newReminderId.slice(0, 6)}\``
    );
}

const command: Command = {
    name: "schedule",
    aliases: ["remind", "timer"],
    description: "Set a precise one-shot reminder, or an escalating one with --escalate",
    usage: `${cmd("schedule")} [--escalate] <datetime> <activity>`,
    usageHint:
        `⚠️ *Usage:* \`${cmd("schedule")} <datetime> <activity>\`\n\n` +
        "*Examples:*\n" +
        `• \`${cmd("schedule")} 25/12/2026 14:30 buy dinner\`\n` +
        `• \`${cmd("schedule")} tomorrow 9am call dentist\`\n` +
        `• \`${cmd("schedule")} in 45m check the oven\`\n` +
        `• \`${cmd("schedule")} 18:00 gym\`\n\n` +
        "*Escalating* (more frequent pings as the deadline nears):\n" +
        `• \`${cmd("schedule")} --escalate 30/06/2026 09:00 final exam\`\n` +
        "• Levels: `=light` · `=balanced` · `=aggressive` · `=auto`\n" +
        "• `=auto` adapts the cadence to how far away the deadline is\n\n" +
        `*Other:* \`${cmd("schedule list")}\` · \`${cmd("schedule cancel")} <id>\``,
    requiresArgs: true,
    handler: handleSchedule,
};

export default command;