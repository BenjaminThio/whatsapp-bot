/**
 * index.ts - relasma/src/pixelforge/index.ts
 *
 * Loader for the native chess board renderer.
 *
 * The addon composites the 12 piece sprites onto a pre-drawn board and hands
 * back an encoded image. Everything expensive happens in C++; this file only
 * resolves the binary, initialises it once, and degrades gracefully when it
 * hasn't been built for this platform.
 *
 * Build:
 *   cd src/pixelforge
 *   npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release
 */

import { Composer, InputFile } from "grammy";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Position, Piece } from "../chess/index.js";

const forgeModule = new Composer();
const require = createRequire(import.meta.url);

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SPRITE_DIR = path.join(HERE, "sprites");

interface InitResult {
    ok: boolean;
    loaded: number;
    missing: number[];
    boardPx: number;
}

interface ChessEngine {
    init(spriteDir: string, options?: {
        squarePx?: number;
        light?: [number, number, number];
        dark?: [number, number, number];
        format?: "png" | "jpeg";
        quality?: number;
        compression?: number;
    }): InitResult;
    render(pieces: string[]): Buffer;
}

/*
Candidate locations. Single-config generators (Ninja, Unix Makefiles) and
multi-config ones (Visual Studio) historically disagreed about where the .node
lands; the CMakeLists now pins build/Release, but an older build may still be
sitting in one of the others.
*/
const CANDIDATES = [
    "./build/Release/App.node",
    "./build/App.node",
    "./build/Debug/App.node",
];

function findAddon(): string | null {
    for (const rel of CANDIDATES) {
        const full = path.join(HERE, rel);
        if (existsSync(full)) return full;
    }
    return null;
}

/**
 * Check the addon is safe to load, in a process we can afford to lose.
 *
 * A native addon built against the wrong ABI segfaults the moment require()
 * maps it - it does not throw, so no try/catch here can save the bot. Loading
 * it in a throwaway child first turns "the whole bot dies with a crash dump"
 * into one warning line and a missing /chess.
 *
 * Costs one short-lived process at startup, and only when the addon exists.
 */
function probeAddon(addonPath: string): { usable: boolean; detail: string } {
    const probe = path.join(HERE, "probe.mjs");
    if (!existsSync(probe)) return { usable: true, detail: "probe script missing - loading unchecked" };

    const result = spawnSync(process.execPath, [probe, addonPath, SPRITE_DIR], {
        encoding: "utf-8",
        timeout: 30_000,
        windowsHide: true,
    });

    if (result.status === 0) {
        return { usable: true, detail: (result.stdout ?? "").trim() };
    }

    // A signal, or a status outside 0/1, means it crashed rather than declined
    const how = result.signal
        ? `killed by ${result.signal}`
        : result.status === 1
            ? (result.stderr ?? "").trim().split("\n")[0] || "initialisation failed"
            : `crashed (exit ${result.status})`;

    return { usable: false, detail: how };
}

let engine: ChessEngine | null = null;
let ready = false;

const addonPath = findAddon();

if (addonPath === null) {
    console.warn(
        "♟️ Chess renderer not built - /chess will be unavailable.\n" +
        "   Build it with:  cd src/pixelforge && npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release"
    );
} else {
    const probe = probeAddon(addonPath);

    if (!probe.usable) {
        console.error(
            `♟️ Chess addon at ${path.basename(addonPath)} is not loadable here: ${probe.detail}\n` +
            "   Skipping it so the rest of the bot can start. Rebuild it for this platform with:\n" +
            "   cd src/pixelforge && npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release"
        );
    } else {
        try {
            engine = require(addonPath) as ChessEngine;

            /*
            JPEG rather than PNG: Telegram re-encodes every photo to JPEG
            anyway, so a lossless PNG costs roughly twice the render time to
            produce something the recipient never receives.
            */
            const info = engine.init(SPRITE_DIR, { format: "jpeg", quality: 92 });
            ready = info.loaded > 0;

            if (!info.ok) {
                console.warn(`♟️ Chess sprites incomplete - missing ids: ${info.missing.join(", ")}`);
            }
            if (!ready) {
                console.error(`♟️ No chess sprites loaded from ${SPRITE_DIR} - /chess will not render.`);
            } else {
                console.log(`♟️ Chess renderer ready (${info.boardPx}px board, ${info.loaded} sprites).`);
            }
        } catch (err) {
            engine = null;
            console.error("♟️ Chess renderer failed to initialise:", err);
        }
    }
}

/** Is the native renderer usable? `/chess` checks this before offering a game. */
export const isRendererReady = (): boolean => ready;

/**
 * Render a board to an encoded image.
 *
 * Kept async so callers can `await` it and so this can move to a worker later
 * without touching them, but the work itself is synchronous - it is a handful
 * of milliseconds, well under the cost of the Telegram upload that follows.
 */
export async function generateImage(input: Record<Position, Piece>): Promise<Buffer> {
    if (engine === null || !ready) {
        throw new Error("The chess renderer is not available on this host - see the startup log.");
    }

    /*
    The addon parses "<file>,<rank>:<spriteId>". Object.entries already gives
    "file,rank" as the key, so this is a concat rather than a re-format.
    */
    const placements: string[] = [];
    for (const key in input) {
        placements.push(`${key}:${input[key as Position]}`);
    }

    return engine.render(placements);
}

forgeModule.command("forge", async (ctx) => {
    if (!ready) {
        await ctx.reply("♟️ The native renderer is not built on this host.");
        return;
    }

    const started = performance.now();
    const image = await generateImage({ "0,0": 0 } as Record<Position, Piece>);
    const ms = performance.now() - started;

    await ctx.replyWithPhoto(new InputFile(image, "board.jpg"), {
        caption: `Rendered in ${ms.toFixed(2)} ms (${(image.length / 1024).toFixed(1)} KB)`,
    });
});

export default forgeModule;
