/**
 * command.ts - relasma/src/shared/command.ts
 *
 * The scaffolding every command module was repeating.
 *
 * Each feature used to open with the same four lines - build a Composer, check
 * `ctx.from`, bail if `ctx.match` is empty, print a usage string - and none of
 * them wrapped the handler, so one thrown error took down the update and grammY
 * retried it forever.
 *
 *     export default feature("weather", [
 *       cmd("weather", { args: "<city>" }, async (ctx) => { ... }),
 *     ]);
 */

import { Composer, Context, type CommandContext } from "grammy";

/** Everything a handler needs, already validated. */
export interface Ctx {
    /** The raw grammY context. */
    tg: CommandContext<Context>;
    /** Everything after the command word, trimmed. */
    match: string;
    /** `match` split on whitespace. */
    args: string[];
    /** args[0] lowercased, for subcommand switches. Empty string when absent. */
    sub: string;
    /** Was anything typed after the command? */
    hasArgs: boolean;
    chatId: number;
    userId: number;
    /** Display name of whoever sent it. */
    who: string;
    /**
     * User id of whoever wrote the message this one replies to.
     *
     * Lets a command act on "that person" without making anyone copy a numeric
     * id around. Undefined when the message is not a reply, or when the reply
     * target is a channel post with no author.
     */
    replyToUserId?: number;
    /** Display name for replyToUserId, when there is one. */
    replyToWho?: string;

    arg(index: number): string | undefined;
    /** args from `index` onward, rejoined with single spaces. */
    rest(index: number): string;

    reply(text: string, opts?: ReplyOpts): Promise<unknown>;
    /** Reply with HTML parsing, escaping anything you didn't mark up yourself. */
    html(text: string, opts?: ReplyOpts): Promise<unknown>;
    /** Send-and-forget status line, e.g. "Thinking...". Failure is ignored. */
    status(text: string): Promise<void>;
}

interface ReplyOpts {
    parse_mode?: "HTML" | "Markdown";
    disable_web_page_preview?: boolean;
    [key: string]: unknown;
}

export interface CommandSpec {
    /** Primary name, without the slash. */
    name: string;
    /** Alternate names. Telegram shows only the primary one in its menu. */
    aliases?: string[];
    /** One-line description for /help. */
    description: string;
    /** Argument summary for /help, e.g. "<city>". */
    args?: string;
    /** Longer help shown when the command needs arguments and got none. */
    usageHint?: string;
    /** Refuse to run with no arguments, replying with the usage instead. */
    requiresArgs?: boolean;
    /** Hide from /help. */
    hidden?: boolean;
    handler: (ctx: Ctx) => Promise<void>;
}

/** Registry so /help can describe everything without importing each module. */
const registry: CommandSpec[] = [];

export const allCommands = (): CommandSpec[] => [...registry];
export const visibleCommands = (): CommandSpec[] => registry.filter(c => !c.hidden);

/** Escape text that will be interpolated into an HTML-parsed message. */
export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `/name <args>` - the usage line shown in help and on a missing argument. */
export function usageLine(spec: CommandSpec): string {
    return `/${spec.name}${spec.args ? ` ${spec.args}` : ""}`;
}

function buildCtx(tg: CommandContext<Context>): Ctx | null {
    // A channel post has no `from`; nothing user-scoped can work without it.
    if (!tg.from) return null;

    const match = tg.match.trim();
    const args = match.length > 0 ? match.split(/\s+/) : [];

    const reply = async (text: string, opts: ReplyOpts = {}): Promise<unknown> =>
        tg.reply(text, opts);

    const replyFrom = tg.message?.reply_to_message?.from;

    return {
        tg,
        match,
        args,
        sub: (args[0] ?? "").toLowerCase(),
        hasArgs: match.length > 0,
        chatId: tg.chat.id,
        userId: tg.from.id,
        who: tg.from.username ?? tg.from.first_name ?? String(tg.from.id),
        ...(replyFrom ? { replyToUserId: replyFrom.id } : {}),
        ...(replyFrom ? { replyToWho: replyFrom.username ?? replyFrom.first_name ?? String(replyFrom.id) } : {}),

        arg: (i) => args[i],
        rest: (i) => args.slice(i).join(" "),

        reply,
        html: (text, opts = {}) => reply(text, { ...opts, parse_mode: "HTML" }),
        status: async (text) => {
            // Purely informational - if it fails the real work should still run
            try { await tg.reply(text); } catch { /* ignore */ }
        },
    };
}

/** Define one command. Register it with `feature()`. */
export function cmd(
    name: string,
    opts: Omit<CommandSpec, "name" | "handler">,
    handler: (ctx: Ctx) => Promise<void>
): CommandSpec {
    return { name, handler, ...opts };
}

/**
 * Turn a list of command specs into a grammY Composer.
 *
 * Every handler gets the same guarantees: a built context, the argument gate,
 * and a catch that reports the failure to the user instead of letting grammY
 * retry the update forever.
 */
export function feature(label: string, specs: CommandSpec[]): Composer<Context> {
    const composer = new Composer<Context>();

    for (const spec of specs) {
        registry.push(spec);

        const names = [spec.name, ...(spec.aliases ?? [])];

        composer.command(names, async (tg) => {
            const ctx = buildCtx(tg);
            if (!ctx) return;

            if (spec.requiresArgs && !ctx.hasArgs) {
                await ctx.reply(spec.usageHint ?? `Usage: ${usageLine(spec)}`);
                return;
            }

            try {
                await spec.handler(ctx);
            } catch (err) {
                console.error(`❌ /${spec.name} (${label}) failed:`, err);
                const detail = err instanceof Error ? err.message : String(err);
                await ctx
                    .reply(`❌ ${escapeHtml(detail).slice(0, 300)}`)
                    .catch(() => { /* the chat may be gone too */ });
            }
        });
    }

    return composer;
}

/**
 * Describe a command that predates this scaffold, so /help can list it.
 *
 * The games, the shop and a few older features register their handlers straight
 * on a Composer. Rewriting them was out of scope and unnecessary - they just
 * need an entry in the registry so the help output is complete rather than
 * silently missing half the bot.
 */
export function describeLegacy(specs: Omit<CommandSpec, "handler">[]): void {
    for (const spec of specs) {
        if (registry.some(c => c.name === spec.name)) continue;
        registry.push({ ...spec, handler: async () => { /* handled by its own Composer */ } });
    }
}
