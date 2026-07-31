import { readdirSync } from "node:fs";
import path from "node:path";
import { Command, CommandMatch, matchCommand, triggersOf } from "./commands/_types.js";
import { commandPrefixes, primaryPrefix } from "./config/prefixes.js";

const registry: Command[] = [];

/*
Load every .ts/.js file in /commands except internal ones (prefixed with _).
Each file must `export default` a Command object.
*/
export async function loadCommands() {
    const dir = path.join(import.meta.dir, "commands");
    const files = readdirSync(dir).filter(f =>
        (f.endsWith(".ts") || f.endsWith(".js")) && !f.startsWith("_")
    );

    // One flat map of trigger -> owning command, so clashes are caught properly.
    const claimed = new Map<string, string>();

    for (const file of files) {
        const modulePath = path.join(dir, file);
        try {
            const mod = await import(modulePath);
            const cmd: Command | undefined = mod.default;

            if (!cmd || typeof cmd.handler !== "function" || typeof cmd.name !== "string") {
                console.warn(`⚠️ Skipped ${file}: no valid default-exported Command.`);
                continue;
            }

            /*
            Duplicate detection used to `continue` the INNER loop, which did
            nothing - the clashing command was registered anyway and routing
            silently depended on file order.

            A clashing NAME is fatal for that file. A clashing ALIAS only costs
            the alias: dropping a whole command because it shares a shorthand
            with another would be a much worse outcome than losing the shorthand.
            */
            const name = cmd.name.toLowerCase();
            if (claimed.has(name)) {
                console.error(`❌ Duplicate command name "${name}" in ${file} (owned by "${claimed.get(name)}"). Skipping.`);
                continue;
            }
            claimed.set(name, cmd.name);

            const keptAliases: string[] = [];
            for (const alias of cmd.aliases ?? []) {
                const key = alias.toLowerCase();
                if (claimed.has(key)) {
                    console.warn(`⚠️ Alias "${key}" of ${cmd.name} is already used by "${claimed.get(key)}" - dropping it.`);
                    continue;
                }
                claimed.set(key, cmd.name);
                keptAliases.push(alias);
            }
            cmd.aliases = keptAliases;

            registry.push(cmd);

            const aliasNote = cmd.aliases?.length
                ? ` (aliases: ${cmd.aliases.map(a => primaryPrefix() + a).join(", ")})`
                : "";
            console.log(`✅ Loaded command: ${primaryPrefix()}${cmd.name}${aliasNote}`);
        } catch (err) {
            console.error(`❌ Failed to load ${file}:`, err);
        }
    }

    console.log(`📦 Total commands loaded: ${registry.length}`);
    console.log(`🔣 Accepted prefixes: ${commandPrefixes().map(p => `"${p}"`).join(" ")}`);
}

/**
 * Resolve a message to a command, together with the prefix and trigger that were
 * actually typed. Returns null when the text isn't a command.
 */
export function parseCommand(text: string): CommandMatch | null {
    if (!text) return null;
    for (const cmd of registry) {
        const hit = matchCommand(text, cmd);
        if (hit) return hit;
    }
    return null;
}

/** Look up a command for a given message text. */
export function findCommand(text: string): Command | null {
    return parseCommand(text)?.command ?? null;
}

/** Find a command by name or alias, without any prefix involved. */
export function commandByName(name: string): Command | null {
    const wanted = name.toLowerCase();
    return registry.find(c => triggersOf(c).includes(wanted)) ?? null;
}

export function getAllCommands(): Command[] {
    return [...registry];
}

/** Commands worth showing in !help. */
export function getVisibleCommands(): Command[] {
    return registry.filter(c => !c.hidden);
}
