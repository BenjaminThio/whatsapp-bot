import { WAMessage, WASocket } from "@whiskeysockets/baileys";

export interface Command {
    // Primary command name (e.g. "play" - invoked as "!play")
    name: string;

    // Optional alternate names ("p" for "play", etc.)
    aliases?: string[];

    // Brief description shown in !help
    description: string;

    // Usage hint shown in !help (e.g. "!play <song name or URL>")
    usage: string;

    // Whether the command requires text after the keyword (e.g. !play needs a query)
    requiresArgs?: boolean;

    // The actual handler.
    // `text` is the full original message text including the "!command " prefix -
    // existing handlers all do their own slicing, so we keep that for compatibility.
    handler: (sock: WASocket, msg: WAMessage, text: string) => Promise<void> | void;
}

// Helper to check if a piece of text is invoking this command.
// Returns true if `text` starts with "!name" or "!alias" followed by space-or-end.
export function matchesCommand(text: string, cmd: Command): boolean {
    const lower = text.toLowerCase();
    const candidates = [cmd.name, ...(cmd.aliases ?? [])];
    for (const candidate of candidates) {
        const trigger = `!${candidate.toLowerCase()}`;
        if (lower === trigger) return true;
        if (lower.startsWith(trigger + " ")) return true;
    }
    return false;
}