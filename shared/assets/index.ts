/**
 * index.ts - shared/assets/index.ts
 *
 * Where the engine binaries and data files live.
 *
 * The Python engines, their compiled Windows counterparts, the Wiktionary index
 * and the emoji dataset used to sit inside the WhatsApp bot. Both bots run the same
 * ones now, so there is a single copy to build and update.
 *
 * Override the location with ASSETS_DIR when the assets are kept elsewhere -
 * useful on Termux where the compiled binaries differ from the Windows ones.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** Root of the assets tree. */
export const ASSETS_DIR = process.env["ASSETS_DIR"]
    ? path.resolve(process.env["ASSETS_DIR"])
    : HERE;

export const ENGINES_DIR = path.join(ASSETS_DIR, "engines");
export const DICT_DIR = path.join(ASSETS_DIR, "dict");
export const DATA_DIR = path.join(ASSETS_DIR, "data");

/**
 * Resolve a helper script, plus the path a compiled Windows binary would live
 * at if one existed.
 *
 * No .exe files ship any more. They were PyInstaller bundles - 546 MB in total,
 * each embedding its own copy of the Python runtime - and they were also
 * SLOWER than the plain script, because a self-extracting bundle unpacks itself
 * on every single run: gTTS took 5.9 s through the .exe versus 1.1 s through
 * the shared venv. Termux never used them at all.
 *
 * The winExe path is still returned so runHelper() will pick up a binary if you
 * ever build one, but the normal path everywhere is now the .py through
 * resolvePython().
 */
export function engine(name: string): { winExe: string; pyScript: string } {
    return {
        winExe: path.join(ENGINES_DIR, `${name}.exe`),
        pyScript: path.join(ENGINES_DIR, `${name}.py`),
    };
}

/** The dict_lookup binary for this platform. */
export function dictBinary(): string {
    return path.join(DICT_DIR, process.platform === "win32" ? "dict_lookup.exe" : "dict_lookup");
}

/** Absolute path to a file under assets/data. */
export function dataFile(name: string): string {
    return path.join(DATA_DIR, name);
}

/** Report anything missing, so a broken install fails loudly at startup. */
export function checkAssets(): { ok: boolean; missing: string[] } {
    const wanted = [
        path.join(DICT_DIR, "dict.dat"),
        path.join(DICT_DIR, "dict.idx"),
        dataFile("emoji.jsonl"),
    ];
    const missing = wanted.filter(p => !existsSync(p));
    return { ok: missing.length === 0, missing };
}
