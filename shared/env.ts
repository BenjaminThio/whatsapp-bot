/**
 * env.ts - shared/env.ts
 *
 * Loads shared/.env into process.env, WITHOUT overwriting anything already set.
 *
 * Both bots need the same API keys - the AI providers, the UTAR endpoints, the
 * AES material, OpenWeather, the Postgres connection. Keeping a copy in each
 * bot's .env means rotating a key is a two-file job that gets done once and
 * forgotten in the other, which is exactly the drift the shared folder exists
 * to stop.
 *
 * Precedence, highest first:
 *   1. the real environment (export FOO=... , or Termux's own)
 *   2. the bot's own .env, which Bun loads from the working directory
 *   3. shared/.env, filled in here
 *
 * So a bot can still override any shared value locally, and bot-specific keys
 * (BOT_TOKEN, the Baileys pairing number) stay where they belong.
 *
 * Import this FIRST, before anything that reads process.env at module scope.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SHARED_ENV = path.join(HERE, ".env");

/**
 * Minimal .env parser.
 *
 * Deliberately not a dependency: it handles KEY=VALUE, comments, blank lines,
 * surrounding quotes and inline `export`, which is everything these files use.
 */
function parse(text: string): Record<string, string> {
    const out: Record<string, string> = {};

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;

        const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
        const eq = withoutExport.indexOf("=");
        if (eq === -1) continue;

        const key = withoutExport.slice(0, eq).trim();
        if (!key) continue;

        let value = withoutExport.slice(eq + 1).trim();

        // Strip one matching pair of surrounding quotes, keeping inner ones
        if (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
             (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }

        out[key] = value;
    }

    return out;
}

let loaded = false;

/**
 * Fill in any shared variable this process doesn't already have.
 * Returns the names it supplied, for the startup log.
 */
export function loadSharedEnv(): string[] {
    if (loaded) return [];
    loaded = true;

    if (!existsSync(SHARED_ENV)) return [];

    let applied: string[];
    try {
        const vars = parse(readFileSync(SHARED_ENV, "utf-8"));
        applied = [];

        for (const [key, value] of Object.entries(vars)) {
            // Never clobber: the bot's own .env and the real environment win
            if (process.env[key] !== undefined && process.env[key] !== "") continue;
            process.env[key] = value;
            applied.push(key);
        }
    } catch (err) {
        console.warn("⚙️ Could not read shared/.env:", err instanceof Error ? err.message : err);
        return [];
    }

    if (applied.length > 0) {
        console.log(`⚙️ Loaded ${applied.length} shared env var(s): ${applied.join(", ")}`);
    }
    return applied;
}

/** Warn about anything a feature needs but nobody has set. */
export function reportMissingEnv(required: Record<string, string>): void {
    const missing = Object.entries(required).filter(([key]) => !process.env[key]);
    if (missing.length === 0) return;

    console.warn("⚠️ Some features will not work - missing environment variables:");
    for (const [key, why] of missing) console.warn(`   ${key.padEnd(32)} ${why}`);
}

// Applied on import, so a bare `import "../../shared/env.js"` is enough.
loadSharedEnv();
