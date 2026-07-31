/**
 * index.ts - relasma/src/github/index.ts
 *
 * /webhook (/gh) - create and manage GitHub webhooks that notify a chat.
 *
 * The webhook registry stays on Firestore: the payload URL is a Vercel relay
 * that has to be reachable from the internet, which a Postgres database on a
 * phone behind CGNAT is not. That is the one sanctioned cloud dependency; every
 * other piece of state is local.
 *
 * Delivery goes through the shared outbox, so a push notification that arrives
 * while Telegram is unreachable is queued rather than lost.
 */

import { cmd, feature, type Ctx } from "../lib/command.js";
import {
    createWebhook, listWebhooks, deleteWebhook, updateWebhook,
    SUPPORTED_EVENTS, type WebhookConfig,
} from "../../../shared/webhook/github-webhook.js";
import { setSetting, getSetting } from "../../../shared/db/user-store.js";

const TRANSPORT = "telegram" as const;

function publicUrl(token: string): string {
    const base = (process.env["VERCEL_WEBHOOK_URL"] ?? "").replace(/\/$/, "");
    if (!base) return "(VERCEL_WEBHOOK_URL is not set)";
    return `${base}/api/github/${token}`;
}

/** Parse "push, issues" into a validated event list. */
function parseEvents(raw: string): { events: string[]; invalid: string[] } {
    const parts = raw.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (parts.includes("all")) return { events: ["all"], invalid: [] };

    const valid: string[] = [];
    const invalid: string[] = [];
    for (const p of parts) {
        if ((SUPPORTED_EVENTS as readonly string[]).includes(p)) valid.push(p);
        else invalid.push(p);
    }
    return { events: valid, invalid };
}

function setupInstructions(cfg: WebhookConfig): string {
    return [
        "✅ Webhook created!",
        "",
        "🔗 Payload URL:",
        publicUrl(cfg.token),
        "",
        "🔑 Secret:",
        cfg.secret,
        "",
        "📋 GitHub setup:",
        "1. Repo → Settings → Webhooks → Add webhook",
        "2. Paste the Payload URL above",
        "3. Content type: application/json",
        "4. Paste the Secret above",
        `5. Events: ${cfg.events.includes("all") ? "Send me everything" : `Let me select → ${cfg.events.join(", ")}`}`,
        "6. Click Add webhook",
        "",
        `📢 Notifying: ${cfg.targetJid}`,
        `🆔 ${cfg.token.slice(0, 8)}`,
        "",
        "Keep the secret private - it's what stops other people spamming your webhook.",
    ].join("\n");
}

const webhook = cmd("webhook", {
    aliases: ["gh", "github"],
    description: "Create & manage GitHub webhooks that notify this chat",
    args: "new [events] | list | events <id> <list> | target <id> | delete <id>",
    usageHint:
        "🪝 GitHub webhook manager\n\n" +
        "• /webhook new [events] - notify this chat\n" +
        "• /webhook new <chat_id> [events] - notify another chat\n" +
        "• /webhook list\n" +
        "• /webhook events <id> <list>\n" +
        "• /webhook target <id> [chat_id]\n" +
        "• /webhook delete <id>\n\n" +
        `Events: ${SUPPORTED_EVENTS.join(", ")}, or "all". Defaults to push.\n\n` +
        "Example: /webhook new push,issues",
}, async (ctx: Ctx) => {
    const owner = String(ctx.userId);
    const here = String(ctx.chatId);

    const resolveOwned = async (prefix: string): Promise<WebhookConfig | null> => {
        const hooks = await listWebhooks(owner);
        return hooks.find(h => h.token.startsWith(prefix)) ?? null;
    };

    if (!ctx.hasArgs || ctx.sub === "help") {
        await ctx.reply(
            "🪝 GitHub webhook manager\n\n" +
            "• /webhook new [events]\n• /webhook list\n• /webhook events <id> <list>\n" +
            "• /webhook target <id> [chat_id]\n• /webhook delete <id>\n\n" +
            `Events: ${SUPPORTED_EVENTS.join(", ")}, or "all".`
        );
        return;
    }

    if (ctx.sub === "new") {
        let target = here;
        let eventArgs = ctx.args.slice(1);

        // A leading numeric argument is a chat id, not an event name
        if (eventArgs[0] && /^-?\d+$/.test(eventArgs[0])) {
            target = eventArgs[0];
            eventArgs = eventArgs.slice(1);
        }

        const parsed = parseEvents(eventArgs.join(" "));
        if (parsed.invalid.length > 0) {
            await ctx.reply(
                `❌ Unknown event(s): ${parsed.invalid.join(", ")}\n` +
                `Valid: ${SUPPORTED_EVENTS.join(", ")}, or "all"`
            );
            return;
        }

        const cfg = await createWebhook(owner, target, parsed.events.length ? parsed.events : ["push"]);
        // Record the transport so the queue consumer knows which bot delivers it
        await updateWebhook(cfg.token, owner, { transport: TRANSPORT } as never);
        await ctx.reply(setupInstructions(cfg));
        return;
    }

    if (ctx.sub === "list") {
        const hooks = await listWebhooks(owner);
        if (hooks.length === 0) {
            await ctx.reply("📭 You have no webhooks. Create one with /webhook new.");
            return;
        }
        await ctx.reply(
            "🪝 Your webhooks:\n\n" +
            hooks.map(h =>
                `🆔 ${h.token.slice(0, 8)}${h.active ? "" : " (disabled)"}\n` +
                `   📦 ${h.repoName ?? "not connected yet"}\n` +
                `   📢 ${h.targetJid}\n` +
                `   🔔 ${h.events.join(", ")}`
            ).join("\n\n")
        );
        return;
    }

    if (!["events", "target", "delete"].includes(ctx.sub)) {
        await ctx.reply(`Unknown subcommand: ${ctx.sub}. Try /webhook help.`);
        return;
    }

    const idPrefix = ctx.arg(1);
    if (!idPrefix) {
        await ctx.reply(`Usage: /webhook ${ctx.sub} <id> ...`);
        return;
    }

    const hook = await resolveOwned(idPrefix);
    if (!hook) {
        await ctx.reply(`❌ No webhook ${idPrefix} found.`);
        return;
    }
    const shortId = hook.token.slice(0, 8);

    if (ctx.sub === "delete") {
        await deleteWebhook(hook.token, owner);
        await ctx.reply(`🗑️ Deleted webhook ${shortId} (${hook.repoName ?? "unconnected"}).`);
        return;
    }

    if (ctx.sub === "events") {
        const eventStr = ctx.rest(2);
        if (!eventStr) {
            await ctx.reply(`Usage: /webhook events ${idPrefix} push,issues`);
            return;
        }
        const parsed = parseEvents(eventStr);
        if (parsed.invalid.length > 0) {
            await ctx.reply(`❌ Unknown event(s): ${parsed.invalid.join(", ")}`);
            return;
        }
        const events = parsed.events.length ? parsed.events : ["push"];
        await updateWebhook(hook.token, owner, { events });
        await ctx.reply(`✅ Webhook ${shortId} now notifies: ${events.join(", ")}`);
        return;
    }

    const newTarget = ctx.arg(2) ?? here;
    await updateWebhook(hook.token, owner, { targetJid: newTarget });
    await ctx.reply(`✅ Webhook ${shortId} now notifies: ${newTarget}`);
});

/**
 * /report - point the legacy push-notification relay at this chat.
 *
 * api/github.ts posts here for repos wired up before the per-webhook system
 * existed. The chat id used to live in a Firestore document; it is a row in
 * bot_settings now, alongside everything else.
 */
const report = cmd("report", {
    description: "Send GitHub push notifications for the legacy relay to this chat",
    hidden: true,
}, async (ctx: Ctx) => {
    await setSetting("github_report_chat", { transport: TRANSPORT, chatId: ctx.chatId });
    const saved = await getSetting<{ chatId: number }>("github_report_chat");
    await ctx.reply(`✅ GitHub reports will be sent here.\n🆔 ${saved?.chatId}`);
});

export default feature("github", [webhook, report]);
