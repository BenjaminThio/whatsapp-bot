/**
 * modules.ts - relasma/src/modules.ts
 *
 * The one list of feature modules.
 *
 * There used to be two ways to find them, and they had already drifted:
 * local.ts scanned the src/ directory at runtime, while api/production.ts
 * hand-listed eight of them - so anything added after that file was written
 * simply did not exist in webhook mode.
 *
 * Both entry points now load from here. Each entry is a thunk with a static
 * import specifier, which keeps it bundler-friendly for Vercel while still
 * letting a single failing module be caught and skipped rather than taking the
 * whole bot down with it.
 *
 * Adding a feature is one line.
 */

import type { Composer, Context } from "grammy";

export interface FeatureModule {
    name: string;
    load: () => Promise<{ default?: Composer<Context> }>;
    /**
     * Needs something the host may not have - a compiled native addon, a
     * service account. Failure is logged quietly rather than as an error.
     */
    optional?: boolean;
}

export const FEATURE_MODULES: FeatureModule[] = [
    // Ported from the WhatsApp bot
    { name: "help", load: () => import("./help/index.js") },
    { name: "hi-hive", load: () => import("./hi-hive/index.js") },
    { name: "ai", load: () => import("./ai/index.js") },
    { name: "tools", load: () => import("./tools/index.js") },
    { name: "reminder", load: () => import("./reminder/index.js") },
    { name: "github", load: () => import("./github/index.js"), optional: true },

    // Shared with the WhatsApp bot
    { name: "birthday-reminder", load: () => import("./birthday-reminder/index.js") },
    { name: "weather", load: () => import("./weather/index.js") },
    { name: "voice", load: () => import("./voice/index.js") },
    { name: "music", load: () => import("./music/index.js") },
    { name: "emojipedia", load: () => import("./emojipedia/index.js") },

    // Telegram-exclusive
    { name: "shop", load: () => import("./shop/index.js") },
    { name: "snake", load: () => import("./snake/index.js") },
    { name: "sokoban", load: () => import("./sokoban/index.js") },
    { name: "tic-tac-toe", load: () => import("./tic-tac-toe/index.js") },
    { name: "calculator", load: () => import("./calculator/index.js") },
    // Needs src/pixelforge/build/Release/App.node, which isn't built everywhere
    { name: "chess", load: () => import("./chess/index.js"), optional: true },
    { name: "delete", load: () => import("./delete/index.js") },
    { name: "test", load: () => import("./test/index.js") },
];

export interface LoadResult {
    loaded: number;
    failed: string[];
}

/**
 * Register every module on a bot.
 *
 * One broken feature is reported and skipped; it must never stop the rest of
 * the bot from starting.
 */
export async function registerModules(
    use: (composer: Composer<Context>) => void
): Promise<LoadResult> {
    const failed: string[] = [];
    let loaded = 0;

    for (const mod of FEATURE_MODULES) {
        try {
            const imported = await mod.load();

            if (!imported.default) {
                console.warn(`⚠️ Skipped ${mod.name}: no default-exported Composer.`);
                failed.push(mod.name);
                continue;
            }

            use(imported.default);
            loaded++;
        } catch (err) {
            failed.push(mod.name);
            const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);

            if (mod.optional) {
                console.warn(`⚠️ ${mod.name} unavailable (optional): ${detail}`);
            } else {
                console.error(`❌ Failed to load ${mod.name}: ${detail}`);
            }
        }
    }

    return { loaded, failed };
}
