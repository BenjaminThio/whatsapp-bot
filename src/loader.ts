import { readdirSync } from "node:fs";
import path from "node:path";
import { Command, matchesCommand } from "./commands/_types.js";

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

    for (const file of files) {
        const modulePath = path.join(dir, file);
        try {
            const mod = await import(modulePath);
            const cmd: Command | undefined = mod.default;

            if (!cmd || typeof cmd.handler !== "function" || typeof cmd.name !== "string") {
                console.warn(`⚠️ Skipped ${file}: no valid default-exported Command.`);
                continue;
            }

            // Detect duplicate names/aliases across files - they'd cause ambiguous routing
            const allTriggers = [cmd.name, ...(cmd.aliases ?? [])];
            for (const existing of registry) {
                const existingTriggers = [existing.name, ...(existing.aliases ?? [])];
                const clash = allTriggers.find(t => existingTriggers.includes(t));
                if (clash) {
                    console.error(`❌ Duplicate command trigger "${clash}" in ${file} (already used by "${existing.name}"). Skipping.`);
                    continue;
                }
            }

            registry.push(cmd);
            console.log(`✅ Loaded command: !${cmd.name}${cmd.aliases?.length ? ` (aliases: ${cmd.aliases.map(a => "!" + a).join(", ")})` : ""}`);
        } catch (err) {
            console.error(`❌ Failed to load ${file}:`, err);
        }
    }

    console.log(`📦 Total commands loaded: ${registry.length}`);
}

/*
Look up a command for a given message text.
Returns the matched command or null.
*/
export function findCommand(text: string): Command | null {
    if (!text || !text.startsWith("!")) return null;
    for (const cmd of registry) {
        if (matchesCommand(text, cmd)) return cmd;
    }
    return null;
}

export function getAllCommands(): Command[] {
    return [...registry];
}