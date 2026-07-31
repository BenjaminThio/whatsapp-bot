/**
 * command-context.ts - src/lib/command-context.ts
 *
 * The object every command handler receives, in the spirit of grammY's `ctx`.
 *
 * Baileys is unopinionated: it hands you a raw protobuf and wishes you luck. So
 * every handler was re-deriving the same four things by hand -
 *
 *     const args = text.slice("!schedule ".length).trim();
 *
 * - which breaks the moment someone types `!schedule` with no trailing space,
 * uses an alias, uses a different prefix, or puts the command in a caption.
 *
 * The dispatcher now parses once and passes the result down:
 *
 *     ctx.match          -> "25/12/2026 14:30 buy dinner"
 *     ctx.args           -> ["25/12/2026", "14:30", "buy", "dinner"]
 *     ctx.arg(0)         -> "25/12/2026"
 *     ctx.rest(2)        -> "buy dinner"
 *     ctx.sub            -> "25/12/2026" lowercased, for subcommand switches
 *     ctx.quotedArgs     -> respects "quoted phrases"
 *
 * Replies go through the outbox, so nothing a command says can be lost to a
 * disconnect.
 */

import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import type { Command } from "../commands/_types.js";
import { resolveIds } from "./jid.js";
import { splitArgs, parseQuotedArgs, quotedBody } from "./wa-text.js";
import { queueMessage, queueReply, reactNow, type QueueOpts } from "./outbox.js";

export interface CommandContext {
    sock: WASocket;
    msg: WAMessage;
    /** Full original message text, prefix and all. */
    text: string;

    chatId: string;
    /** The individual who sent it (participant in groups, chat jid otherwise). */
    userId: string;
    isGroup: boolean;

    command: Command;
    /** The prefix actually typed - "!" or "/" or whatever is configured. */
    prefix: string;
    /** The trigger actually typed; may be an alias rather than command.name. */
    invoked: string;

    /** Everything after the command word, trimmed. grammY's ctx.match. */
    match: string;
    /** `match` split on whitespace. */
    args: string[];
    /** `match` split shell-style, keeping "quoted phrases" intact. */
    quotedArgs: string[];
    /** args[0] lowercased, for subcommand dispatch. Empty string when absent. */
    sub: string;
    /** Was anything typed after the command? */
    hasArgs: boolean;

    /** The message being replied to, if any. */
    quoted: any | null;

    arg(index: number): string | undefined;
    /** args from `index` onward, rejoined with single spaces. */
    rest(index: number): string;

    send(content: any, opts?: QueueOpts): Promise<any | undefined>;
    sendText(text: string, opts?: QueueOpts): Promise<any | undefined>;
    /** Same as send, but quoting the user's message. */
    reply(content: any, opts?: QueueOpts): Promise<any | undefined>;
    replyText(text: string, opts?: QueueOpts): Promise<any | undefined>;
    react(emoji: string): Promise<void>;
    /** Reply with the command's usage line, optionally prefixed by a reason. */
    sendUsage(reason?: string): Promise<void>;
}

/**
 * Pull the argument string out of the raw text for an already-matched command.
 *
 * Handles the cases the hand-rolled `.slice()` calls did not: no trailing space,
 * several spaces, a newline right after the command, aliases of any length, and
 * leading whitespace before the prefix (matchCommand accepts that, so the slice
 * has to start from the same trimmed position or it eats real characters).
 */
export function extractMatch(text: string, prefix: string, invoked: string): string {
    const body = text.trimStart();
    return body.slice(prefix.length + invoked.length).trim();
}

export function buildContext(params: {
    sock: WASocket;
    msg: WAMessage;
    text: string;
    command: Command;
    prefix: string;
    invoked: string;
}): CommandContext | null {
    const ids = resolveIds(params.msg);
    if (!ids) return null;

    const match = extractMatch(params.text, params.prefix, params.invoked);
    const args = splitArgs(match);

    const ctx: CommandContext = {
        sock: params.sock,
        msg: params.msg,
        text: params.text,

        chatId: ids.chatId,
        userId: ids.userId,
        isGroup: ids.isGroup,

        command: params.command,
        prefix: params.prefix,
        invoked: params.invoked,

        match,
        args,
        quotedArgs: parseQuotedArgs(match),
        sub: (args[0] ?? "").toLowerCase(),
        hasArgs: match.length > 0,

        quoted: quotedBody(params.msg),

        arg: (index: number) => args[index],
        rest: (index: number) => args.slice(index).join(" "),

        send: (content, opts) => queueMessage(ids.chatId, content, opts),
        sendText: (text, opts) => queueMessage(ids.chatId, { text }, opts),
        reply: (content, opts) => queueReply(ids.chatId, content, params.msg, opts),
        replyText: (text, opts) => queueReply(ids.chatId, { text }, params.msg, opts),
        react: (emoji) => reactNow(ids.chatId, emoji, params.msg.key),

        sendUsage: async (reason?: string) => {
            const hint = params.command.usageHint ?? `⚠️ *Usage:* \`${params.command.usage}\``;
            await queueReply(
                ids.chatId,
                { text: reason ? `${reason}\n\n${hint}` : hint },
                params.msg
            );
        },
    };

    return ctx;
}
