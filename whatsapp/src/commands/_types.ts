import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { commandPrefixes, splitPrefix } from "../config/prefixes.js";
import type { CommandContext } from "../lib/command-context.js";

export type { CommandContext };

export interface Command {
    // Primary command name (e.g. "play" - invoked as "!play")
    name: string;

    // Optional alternate names ("p" for "play", etc.)
    aliases?: string[];

    // Brief description shown in !help
    description: string;

    // Usage hint shown in !help. Build it with cmd() so it follows the
    // configured prefix: usage: `${cmd("play")} <song name or URL>`
    usage: string;

    /*
    Longer usage text sent when the command is invoked with no arguments but
    requiresArgs is set. Falls back to `usage` when absent - only worth setting
    when the command needs to explain formats or examples.
    */
    usageHint?: string;

    // Refuse to run with no arguments, replying with usageHint/usage instead.
    requiresArgs?: boolean;

    // Hide from !help (internal/debug commands)
    hidden?: boolean;

    /*
    The handler.

    `text` is the full original message text including the prefix and command
    word. `ctx` carries the parsed arguments and the outbox-backed reply helpers
    - prefer it over slicing `text` by hand.
    */
    handler: (
        sock: WASocket,
        msg: WAMessage,
        text: string,
        ctx: CommandContext
    ) => Promise<void> | void;
}

export interface CommandMatch {
    command: Command;
    /** The prefix actually typed. */
    prefix: string;
    /** The trigger actually typed - the name or one of the aliases. */
    invoked: string;
}

/** Every trigger a command answers to, lowercased. */
export function triggersOf(cmd: Command): string[] {
    return [cmd.name, ...(cmd.aliases ?? [])].map(t => t.toLowerCase());
}

/**
 * Does this text invoke this command?
 *
 * A trigger must be followed by whitespace or the end of the message, so
 * "!scanner" never fires "!scan". Longer triggers are tested first so an alias
 * that is a prefix of another name can't win by accident.
 */
export function matchCommand(text: string, cmd: Command): CommandMatch | null {
    const split = splitPrefix(text.trimStart());
    if (!split) return null;

    const rest = split.rest.toLowerCase();
    const triggers = triggersOf(cmd).sort((a, b) => b.length - a.length);

    for (const trigger of triggers) {
        if (!rest.startsWith(trigger)) continue;
        const next = rest.charAt(trigger.length);
        if (next === "" || /\s/.test(next)) {
            return { command: cmd, prefix: split.prefix, invoked: trigger };
        }
    }
    return null;
}

/** Kept for older call sites that only need a yes/no. */
export function matchesCommand(text: string, cmd: Command): boolean {
    return matchCommand(text, cmd) !== null;
}

/** Does this text start with any configured prefix at all? */
export function looksLikeCommand(text: string): boolean {
    return splitPrefix(text.trimStart()) !== null;
}

export { commandPrefixes };
