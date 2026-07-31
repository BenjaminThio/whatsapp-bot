/**
 * text.ts - shared/lib/text.ts
 *
 * Platform-neutral text plumbing: argument splitting and truncation, used by
 * both bots' command layers.
 *
 * The Baileys-specific half (pulling the typed words out of a WhatsApp
 * protobuf) lives in whatsapp/src/lib/wa-text.ts, because it needs Baileys
 * types that the Telegram bot has no reason to install.
 */

/** Split on any run of whitespace, dropping empties. Newlines count as spaces. */
export function splitArgs(input: string): string[] {
    return input.trim().split(/\s+/).filter(Boolean);
}

/**
 * Shell-style argument split that keeps "quoted phrases" together.
 *
 *   'Q01 12345 "2025-01-20 09:00" 2'
 *     -> ["Q01", "12345", "2025-01-20 09:00", "2"]
 *
 * Both double and single quotes are accepted, and a backslash escapes the next
 * character so a literal quote can be passed through.
 */
export function parseQuotedArgs(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let escaped = false;
    let started = false;

    for (const ch of input) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === "\\") {
            escaped = true;
            started = true;
            continue;
        }
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            started = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (started) { args.push(current); current = ""; started = false; }
            continue;
        }
        current += ch;
        started = true;
    }

    if (started) args.push(current);
    return args;
}

/** Cut a string to `max` characters, appending `suffix` when it had to cut. */
export function truncate(input: string, max: number, suffix = "..."): string {
    if (input.length <= max) return input;
    return input.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/**
 * "hello world" -> "Hello World"
 *
 * Lived in telegram/utils/utils.ts, which was a one-function folder sitting
 * beside two stale copies of assets that had already moved to shared/assets.
 */
export const toTitleCase = (str: string): string =>
    str.split(" ")
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
