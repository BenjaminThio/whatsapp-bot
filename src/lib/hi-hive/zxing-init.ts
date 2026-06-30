/**
 * zxing-init.ts — src/lib/hi-hive/zxing-init.ts
 *
 * Fixes the "both async and sync fetching of the wasm failed" crash by loading
 * zxing-wasm's .wasm from the LOCAL node_modules copy instead of fetching from
 * a CDN at runtime.
 *
 * Cross-platform: walks up from the resolved module entry to the package root
 * using `path` (handles Windows backslashes AND posix slashes), then locates
 * dist/full/zxing_full.wasm.
 *
 * Usage:
 *   import { readBarcodes, writeBarcode } from "zxing-wasm/full";
 *   import { ensureZXingReady } from "<path>/zxing-init.js";
 *   ensureZXingReady();   // once before the first read/write
 */

import { prepareZXingModule } from "zxing-wasm/full";
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import path from "path";

let prepared = false;

/** Locate the full .wasm by walking up to the zxing-wasm package root. */
function localWasmPath(): string | null {
  const require = createRequire(import.meta.url);

  let entry: string | undefined;
  for (const sub of ["zxing-wasm/full", "zxing-wasm/reader", "zxing-wasm"]) {
    try { entry = require.resolve(sub); break; } catch { /* try next */ }
  }
  if (!entry) return null;

  // Walk up directories until we hit the package folder named "zxing-wasm".
  let dir = path.dirname(entry);
  for (let i = 0; i < 12; i++) {
    if (path.basename(dir) === "zxing-wasm") {
      const candidates = [
        path.join(dir, "dist", "full",   "zxing_full.wasm"),
        path.join(dir, "dist", "reader", "zxing_reader.wasm"),
        path.join(dir, "dist", "zxing_full.wasm"),
      ];
      const found = candidates.find(p => existsSync(p));
      if (found) return found;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;   // reached filesystem root
    dir = parent;
  }
  return null;
}

export function ensureZXingReady(): void {
  if (prepared) return;
  prepared = true;

  const wasmPath = localWasmPath();
  if (!wasmPath) {
    console.error("[zxing-init] Local wasm not found — leaving defaults (may fetch from CDN).");
    return;
  }

  let wasmBinary: Uint8Array;
  try {
    wasmBinary = readFileSync(wasmPath);
  } catch (e) {
    console.error("[zxing-init] Failed reading local wasm:", e);
    return;
  }

  prepareZXingModule({
    overrides: {
      wasmBinary,
      locateFile: (p: string, prefix: string) =>
        p.endsWith(".wasm") ? wasmPath : prefix + p,
    } as any,
    fireImmediately: false,
  });

  console.log(`[zxing-init] Using local wasm: ${wasmPath} (${wasmBinary.length} bytes)`);
}