/**
 * prefixes.ts - src/config/prefixes.ts
 *
 * Command prefixes are configurable. Set COMMAND_PREFIXES in .env to a
 * comma-separated list; the FIRST entry is the "primary" one used whenever the
 * bot has to print a command back to the user.
 *
 *   COMMAND_PREFIXES="!,/"      -> !scan and /scan both work, help shows !scan
 *   COMMAND_PREFIXES="/,!"      -> both still work, help shows /scan
 *   COMMAND_PREFIXES="."        -> only .scan
 */

const DEFAULT_PREFIXES = ["!", "/"];

function readConfigured(): string[] {
    const raw = process.env["COMMAND_PREFIXES"];
    if (!raw) return DEFAULT_PREFIXES;

    const parsed = raw
        .split(",")
        .map(p => p.trim())
        .filter(Boolean);

    return parsed.length > 0 ? parsed : DEFAULT_PREFIXES;
}

const CONFIGURED = readConfigured();

// Longest first, so a "!!" prefix is never shadowed by a "!" one.
const MATCH_ORDER = [...CONFIGURED].sort((a, b) => b.length - a.length);

/** Every accepted prefix, in the order they were configured. */
export function commandPrefixes(): string[] {
    return [...CONFIGURED];
}

/** The prefix the bot uses when it writes a command out (help, usage hints). */
export function primaryPrefix(): string {
    return CONFIGURED[0];
}

/**
 * Build a displayable command string with the primary prefix.
 *   cmd("scan attendance")  ->  "!scan attendance"
 */
export function cmd(rest: string = ""): string {
    return primaryPrefix() + rest;
}

/**
 * Split a leading prefix off a message.
 * Returns null when the text doesn't start with any configured prefix.
 */
export function splitPrefix(text: string): { prefix: string; rest: string } | null {
    for (const prefix of MATCH_ORDER) {
        if (text.startsWith(prefix)) {
            return { prefix, rest: text.slice(prefix.length) };
        }
    }
    return null;
}

/** Does this token look like `<prefix><word>` for the given word? */
export function isPrefixedWord(token: string, word: string): boolean {
    const split = splitPrefix(token);
    if (!split) return false;
    return split.rest.toLowerCase() === word.toLowerCase();
}
