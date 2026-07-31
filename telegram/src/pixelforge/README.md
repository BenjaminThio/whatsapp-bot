# Chess board renderer (native addon)

Composites the 12 piece sprites onto an 8x8 board and returns an encoded image.
Used by `/chess`.

## Building

```bash
cd src/test-cpp
npx cmake-js compile --CDCMAKE_BUILD_TYPE=Release
```

One `CMakeLists.txt` covers every host — it detects the compiler and CPU rather
than needing a file per platform:

| Host | Flags |
| --- | --- |
| Termux / Linux ARM64 | `-O3 -mcpu=native` + LTO |
| Linux x86-64 | `-O3 -march=native -mtune=native` + LTO |
| Windows MinGW | `-O3` generic + LTO |
| Windows MSVC | `/O2 /Oi /Ot /fp:fast` + LTO |

Exceptions and RTTI are off everywhere (`NAPI_DISABLE_CPP_EXCEPTIONS` is set, so
unwinding tables are dead weight). The output is always `build/Release/App.node`
regardless of generator.

The previous per-platform files are kept for reference as
`CMakeLists-linux-original.txt`, `CMakeLists1.txt`, `CMakeLists2.txt` and
`CMakeLists-MSVC.txt`.

## Performance

Measured on x86-64, full starting position (32 pieces), 300 iterations:

| Encoder | Time | Size |
| --- | --- | --- |
| JPEG q92 **(default)** | **5.8 ms** | 43 KB |
| JPEG q85 | 4.6 ms | 34 KB |
| PNG level 5 | 13.1 ms | 31 KB |
| PNG level 8 (stb default) | 18.2 ms | 31 KB |

Encoding is essentially the entire cost — compositing 32 sprites is free by
comparison. An *empty* board actually encoded slower than a full one under PNG,
because stb's deflate walks a hash chain per position and a large area of one
colour is the pathological case for that.

JPEG is the default because **Telegram re-encodes every photo it receives to
JPEG anyway**, so producing a lossless PNG spends double the time on something
the recipient never sees. Pass `{ format: "png" }` to `init()` when the image is
going out as a document.

## API

```ts
init(spriteDir, {
  squarePx?: number,          // default 60
  light?: [r, g, b],          // default 255,255,255
  dark?:  [r, g, b],          // default 128,128,128
  format?: "png" | "jpeg",    // default "jpeg"
  quality?: number,           // JPEG, 1-100, default 92
  compression?: number,       // PNG, 0-9, default 5
}) -> { ok, loaded, missing: number[], boardPx }

render(pieces: string[]) -> Buffer      // "<file>,<rank>:<spriteId>"
```

`render` skips anything malformed, out of range, or referencing a sprite that
failed to load. A bad board must never crash the bot.

## Crash safety

A native addon built against the wrong ABI **segfaults the process the moment
`require()` maps it** — it does not throw, so no `try`/`catch` can save the bot.

`index.ts` therefore loads the addon in a throwaway child process first
(`probe.mjs`). If that child crashes, the bot logs one line and starts without
`/chess` instead of dying. Costs one short-lived process at startup.

This is not hypothetical: a MinGW-built addon loads fine under Node on Windows
but segfaults Bun, which is the runtime the bot actually uses. Termux builds
with clang against the same libc Bun links, so the mismatch does not arise
there — but the guard means a bad build is a missing feature, not a dead bot.

## Implementation notes

Things worth knowing if you edit `src/addon.cpp`:

- **Sprites are premultiplied at load.** Compositing then costs one multiply per
  channel instead of two.
- **Each sprite records its opaque bounding box**, so the blend loop skips the
  transparent margin every piece PNG has.
- **The frame is RGB, not RGBA.** The board is opaque, so the alpha channel was
  230,400 bytes of constant `0xFF` for the encoder to compress every render.
- **The board is drawn once** into a template and `memcpy`'d per render.
- **`div255` is exact.** The original used `>> 8`, i.e. divide by 256, which is
  0.4% low on every channel and made semi-transparent sprite edges darker than
  they should be.
- **Buffers are handed to V8, not copied**, and their size is reported via
  `AdjustExternalMemory` — without that V8 sees a tiny heap, never feels
  pressure, and 3,000 renders accumulate ~95 MB of finished buffers waiting for
  a GC that has no reason to run.
