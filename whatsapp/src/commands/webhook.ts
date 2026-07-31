/**
 * Telegram BotFather-style command to create and manage GitHub webhooks.
 *
 *   !webhook new [events]        - create a webhook; notify THIS chat
 *   !webhook new <jid> [events]  - create; notify a specific group jid
 *   !webhook list                - list your webhooks
 *   !webhook events <id> <list>  - change which events a webhook notifies
 *   !webhook target <id> [jid]   - change target chat (defaults to current)
 *   !webhook delete <id>         - delete a webhook
 *   !webhook help                - show GitHub setup instructions
 *
 * `events` is a comma/space list from: push, pull_request, issues, release,
 * star, fork - or `all`. Defaults to `push` if omitted.
 */

import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import {
  createWebhook, listWebhooks, deleteWebhook, updateWebhook,
  SUPPORTED_EVENTS, WebhookConfig,
} from "../../../shared/webhook/github-webhook.js";
import { cmd } from "../config/prefixes.js";

const JID_PATTERN = /@(g\.us|s\.whatsapp\.net|lid)$/;

function publicUrl(token: string): string {
  // Points to the Vercel relay, NOT the bot. Vercel verifies the HMAC and queues
  // the event to Firestore; the bot consumes the queue. This URL never changes.
  const base = (process.env["VERCEL_WEBHOOK_URL"] ?? "").replace(/\/$/, "");
  if (!base) return "(VERCEL_WEBHOOK_URL is not set)";
  return `${base}/api/github/${token}`;
}

// Parse an events list like "push, issues" => ["push","issues"]; validate.
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
    `✅ *Webhook created!*`,
    ``,
    `*🔗 Payload URL:*`,
    `${publicUrl(cfg.token)}`,
    ``,
    `*🔑 Secret:*`,
    `\`${cfg.secret}\``,
    ``,
    `*📋 GitHub setup:*`,
    `1. Repo => Settings => Webhooks => Add webhook`,
    `2. Paste the *Payload URL* above`,
    `3. Content type: \`application/json\``,
    `4. Paste the *Secret* above`,
    `5. Choose events: ${cfg.events.includes("all") ? "_Send me everything_" : "_Let me select_ => " + cfg.events.join(", ")}`,
    `6. Click *Add webhook*`,
    ``,
    `📢 Notifying: ${cfg.targetJid === "" ? "this chat" : cfg.targetJid}`,
    `🆔 \`${cfg.token.slice(0, 8)}\``,
    ``,
    `_Keep the secret private - it's what stops other people from spamming your webhook._`,
  ].join("\n");
}

async function handleWebhook(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
  const jid = ctx.chatId;
  const ownerJid = ctx.userId;

  /** Resolve a webhook the caller owns, by id prefix. */
  const resolveOwned = async (prefix: string): Promise<WebhookConfig | null> => {
    const hooks = await listWebhooks(ownerJid);
    return hooks.find(h => h.token.startsWith(prefix)) ?? null;
  };

  // help / setup
  if (!ctx.sub || ctx.sub === "help") {
    await ctx.sendUsage();
    return;
  }

  // new
  if (ctx.sub === "new") {
    // Args after "new": optional <jid> then optional <events>
    let targetJid = jid;                 // default: current chat
    let eventArgs = ctx.args.slice(1);

    if (eventArgs[0] && JID_PATTERN.test(eventArgs[0])) {
      targetJid = eventArgs[0];
      eventArgs = eventArgs.slice(1);
    }

    const parsed = parseEvents(eventArgs.join(" "));
    if (parsed.invalid.length) {
      await ctx.replyText(
        `❌ Unknown event(s): ${parsed.invalid.join(", ")}\n` +
        `Valid: ${SUPPORTED_EVENTS.join(", ")}, or \`all\``
      );
      return;
    }
    const events = parsed.events.length ? parsed.events : ["push"];

    const cfg = await createWebhook(ownerJid, targetJid, events);
    await ctx.replyText(setupInstructions(cfg));
    return;
  }

  // list
  if (ctx.sub === "list") {
    const hooks = await listWebhooks(ownerJid);
    if (hooks.length === 0) {
      await ctx.replyText(`📭 You have no webhooks. Create one with \`${cmd("webhook new")}\`.`);
      return;
    }
    const lines = ["🪝 *Your webhooks:*\n"];
    for (const h of hooks) {
      lines.push(
        `🆔 \`${h.token.slice(0, 8)}\`${h.active ? "" : " _(disabled)_"}\n` +
        `   📦 ${h.repoName ?? "_not connected yet_"}\n` +
        `   📢 ${h.targetJid}\n` +
        `   🔔 ${h.events.join(", ")}`
      );
    }
    lines.push(`\n_Manage with \`${cmd("webhook")} events/target/delete <id>\`_`);
    await ctx.replyText(lines.join("\n"));
    return;
  }

  // Everything below needs an id prefix to resolve a webhook
  if (!["events", "target", "delete"].includes(ctx.sub)) {
    await ctx.replyText(`❓ Unknown subcommand \`${ctx.sub}\`. Try \`${cmd("webhook help")}\`.`);
    return;
  }

  const idPrefix = ctx.arg(1);
  if (!idPrefix) {
    await ctx.replyText(`⚠️ *Usage:* \`${cmd("webhook")} ${ctx.sub} <id> ...\``);
    return;
  }

  const hook = await resolveOwned(idPrefix);
  if (!hook) {
    await ctx.replyText(`❌ No webhook \`${idPrefix}\` found.`);
    return;
  }
  const shortId = hook.token.slice(0, 8);

  if (ctx.sub === "delete") {
    await deleteWebhook(hook.token, ownerJid);
    await ctx.replyText(`🗑️ Deleted webhook \`${shortId}\` (${hook.repoName ?? "unconnected"}).`);
    return;
  }

  if (ctx.sub === "events") {
    const eventStr = ctx.rest(2);
    if (!eventStr) {
      await ctx.replyText(`⚠️ *Usage:* \`${cmd("webhook events")} ${idPrefix} push,issues\``);
      return;
    }
    const parsed = parseEvents(eventStr);
    if (parsed.invalid.length) {
      await ctx.replyText(`❌ Unknown event(s): ${parsed.invalid.join(", ")}`);
      return;
    }
    const events = parsed.events.length ? parsed.events : ["push"];
    await updateWebhook(hook.token, ownerJid, { events });
    await ctx.replyText(`✅ Webhook \`${shortId}\` now notifies: ${events.join(", ")}`);
    return;
  }

  // target
  const newTarget = ctx.arg(2) ?? jid;   // default to current chat
  await updateWebhook(hook.token, ownerJid, { targetJid: newTarget });
  await ctx.replyText(`✅ Webhook \`${shortId}\` now notifies: ${newTarget}`);
}

const command: Command = {
  name: "webhook",
  aliases: ["gh", "github"],
  description: "Create & manage GitHub webhooks that notify a WhatsApp chat",
  usage: `${cmd("webhook")} new [events] | list | events <id> <list> | target <id> [jid] | delete <id>`,
  usageHint:
    "🪝 *GitHub Webhook Manager*\n\n" +
    `• \`${cmd("webhook new")} [events]\` - notify *this* chat\n` +
    `• \`${cmd("webhook new")} <group_jid> [events]\` - notify a specific group\n` +
    `• \`${cmd("webhook list")}\` - your webhooks\n` +
    `• \`${cmd("webhook events")} <id> <list>\` - change events\n` +
    `• \`${cmd("webhook target")} <id> [jid]\` - change target chat\n` +
    `• \`${cmd("webhook delete")} <id>\` - remove a webhook\n\n` +
    `*Events:* ${SUPPORTED_EVENTS.join(", ")}, or \`all\`\n` +
    "_Default is `push` if you don't specify._\n\n" +
    `*Example:* \`${cmd("webhook new")} push,issues\``,
  requiresArgs: false,
  handler: handleWebhook,
};

export default command;