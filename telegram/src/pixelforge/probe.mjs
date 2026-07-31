/**
 * probe.mjs - relasma/src/test-cpp/probe.mjs
 *
 * Loads the chess addon in a THROWAWAY process and exercises it once.
 *
 * A broken native addon does not throw - it segfaults the whole process the
 * moment require() maps it, and no try/catch in JavaScript can stop that. The
 * bot would die at startup with a raw crash dump and no indication of which
 * module was at fault.
 *
 * So the addon is loaded here first. If this process exits 0, the addon is safe
 * to load for real; if it dies, the bot logs the problem and runs without
 * /chess.
 *
 *   <runtime> probe.mjs <addonPath> <spriteDir>
 *
 * Exit codes: 0 usable, 1 loaded but unusable, anything else (or a signal) a
 * hard crash.
 */

const [addonPath, spriteDir] = process.argv.slice(2);

if (!addonPath || !spriteDir) {
    console.error("usage: probe.mjs <addonPath> <spriteDir>");
    process.exit(1);
}

try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);

    const engine = require(addonPath);

    if (typeof engine.init !== "function" || typeof engine.render !== "function") {
        console.error("addon does not export init/render");
        process.exit(1);
    }

    const info = engine.init(spriteDir, { format: "jpeg", quality: 92 });

    // Actually render: a segfault in the compositor only shows up here
    const image = engine.render(["0,0:0", "7,7:11"]);

    if (!image || image.length === 0) {
        console.error("render produced no output");
        process.exit(1);
    }

    process.stdout.write(JSON.stringify({
        ok: !!info.ok,
        loaded: info.loaded ?? 0,
        missing: info.missing ?? [],
        boardPx: info.boardPx ?? 0,
        bytes: image.length,
    }));
    process.exit(0);
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
