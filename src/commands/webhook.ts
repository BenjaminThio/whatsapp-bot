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

import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import {
  createWebhook, listWebhooks, deleteWebhook, updateWebhook, getWebhook,
  SUPPORTED_EVENTS, WebhookConfig,
} from "../lib/webhook/github-webhook.js";

function publicUrl(token: string): string {
  // Points to the Vercel relay, NOT the bot. Vercel verifies the HMAC and queues
  // the event to Firestore; the bot consumes the queue. This URL never changes.
  const base = (process.env["VERCEL_WEBHOOK_URL"]!).replace(/\/$/, "");
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

async function handleWebhook(sock: any, msg: WAMessage, text: string) {
  if (!msg.key.remoteJid) return;
  const jid = msg.key.remoteJid;
  const ownerJid = msg.key.participant || jid;

  const args = text.slice("!webhook".length).trim();
  const tokens = args.split(/\s+/).filter(Boolean);
  const sub = (tokens[0] ?? "").toLowerCase();

  // help / setup
  if (!sub || sub === "help") {
    await sock.sendMessage(jid, {
      text:
        "🪝 *GitHub Webhook Manager*\n\n" +
        "• `!webhook new [events]` - notify *this* chat\n" +
        "• `!webhook new <group_jid> [events]` - notify a specific group\n" +
        "• `!webhook list` - your webhooks\n" +
        "• `!webhook events <id> <list>` - change events\n" +
        "• `!webhook target <id> [jid]` - change target chat\n" +
        "• `!webhook delete <id>` - remove a webhook\n\n" +
        `*Events:* ${SUPPORTED_EVENTS.join(", ")}, or \`all\`\n` +
        "_Default is `push` if you don't specify._\n\n" +
        "*Example:* `!webhook new push,issues`",
    }, { quoted: msg });
    return;
  }

  // new
  if (sub === "new") {
    // Args after "new": optional <jid> then optional <events>
    let targetJid = jid; // default: current chat
    let eventArgs = tokens.slice(1);

    // If the first arg looks like a jid, use it as the target
    if (eventArgs[0] && /@(g\.us|s\.whatsapp\.net|lid)$/.test(eventArgs[0])) {
      targetJid = eventArgs[0];
      eventArgs = eventArgs.slice(1);
    }

    const eventStr = eventArgs.join(" ").trim();
    let events: string[] = ["push"]; // default
    if (eventStr) {
      const parsed = parseEvents(eventStr);
      if (parsed.invalid.length) {
        await sock.sendMessage(jid, {
          text:
            `❌ Unknown event(s): ${parsed.invalid.join(", ")}\n` +
            `Valid: ${SUPPORTED_EVENTS.join(", ")}, or \`all\``,
        }, { quoted: msg });
        return;
      }
      events = parsed.events.length ? parsed.events : ["push"];
    }

    const cfg = await createWebhook(ownerJid, targetJid, events);
    await sock.sendMessage(jid, { text: setupInstructions(cfg) }, { quoted: msg });
    return;
  }

  // list
  if (sub === "list") {
    const hooks = await listWebhooks(ownerJid);
    if (hooks.length === 0) {
      await sock.sendMessage(jid, { text: "📭 You have no webhooks. Create one with `!webhook new`." }, { quoted: msg });
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
    lines.push("\n_Manage with `!webhook events/target/delete <id>`_");
    await sock.sendMessage(jid, { text: lines.join("\n") }, { quoted: msg });
    return;
  }

  // For the remaining subs we need an id prefix to resolve a webhook
  const idPrefix = tokens[1];
  if (["events", "target", "delete"].includes(sub) && !idPrefix) {
    await sock.sendMessage(jid, { text: `⚠️ Usage: \`!webhook ${sub} <id> ...\`` }, { quoted: msg });
    return;
  }

  async function resolveOwned(prefix: string): Promise<WebhookConfig | null> {
    const hooks = await listWebhooks(ownerJid);
    return hooks.find(h => h.token.startsWith(prefix)) ?? null;
  }

  // delete
  if (sub === "delete") {
    const hook = await resolveOwned(idPrefix);
    if (!hook) { await sock.sendMessage(jid, { text: `❌ No webhook \`${idPrefix}\` found.` }, { quoted: msg }); return; }
    await deleteWebhook(hook.token, ownerJid);
    await sock.sendMessage(jid, { text: `🗑️ Deleted webhook \`${hook.token.slice(0, 8)}\` (${hook.repoName ?? "unconnected"}).` }, { quoted: msg });
    return;
  }

  // events
  if (sub === "events") {
    const hook = await resolveOwned(idPrefix);
    if (!hook) { await sock.sendMessage(jid, { text: `❌ No webhook \`${idPrefix}\` found.` }, { quoted: msg }); return; }
    const eventStr = tokens.slice(2).join(" ").trim();
    if (!eventStr) { await sock.sendMessage(jid, { text: `⚠️ Usage: \`!webhook events ${idPrefix} push,issues\`` }, { quoted: msg }); return; }
    const parsed = parseEvents(eventStr);
    if (parsed.invalid.length) {
      await sock.sendMessage(jid, { text: `❌ Unknown event(s): ${parsed.invalid.join(", ")}` }, { quoted: msg });
      return;
    }
    const events = parsed.events.length ? parsed.events : ["push"];
    await updateWebhook(hook.token, ownerJid, { events });
    await sock.sendMessage(jid, { text: `✅ Webhook \`${hook.token.slice(0, 8)}\` now notifies: ${events.join(", ")}` }, { quoted: msg });
    return;
  }

  // target
  if (sub === "target") {
    const hook = await resolveOwned(idPrefix);
    if (!hook) { await sock.sendMessage(jid, { text: `❌ No webhook \`${idPrefix}\` found.` }, { quoted: msg }); return; }
    const newTarget = tokens[2] ?? jid;   // default to current chat
    await updateWebhook(hook.token, ownerJid, { targetJid: newTarget });
    await sock.sendMessage(jid, { text: `✅ Webhook \`${hook.token.slice(0, 8)}\` now notifies: ${newTarget}` }, { quoted: msg });
    return;
  }

  // Unknown subcommand
  await sock.sendMessage(jid, { text: `❓ Unknown subcommand \`${sub}\`. Try \`!webhook help\`.` }, { quoted: msg });
}

const command: Command = {
  name: "webhook",
  aliases: ["gh", "github"],
  description: "Create & manage GitHub webhooks that notify a WhatsApp chat",
  usage: "!webhook new [events] | list | events <id> <list> | target <id> [jid] | delete <id>",
  requiresArgs: false,
  handler: handleWebhook,
};

export default command;