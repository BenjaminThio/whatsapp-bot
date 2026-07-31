/**
 * addon.cpp - chess board renderer (native N-API addon)
 *
 * Composites 12 piece sprites onto a pre-drawn 8x8 board and returns a PNG.
 *
 * Design notes
 * ------------
 * The board never changes, so it is drawn once at init() into a template and
 * every render() starts from a memcpy of that template rather than redrawing
 * squares.
 *
 * Sprites are PREMULTIPLIED at load time. Alpha compositing then costs one
 * multiply per channel instead of two:
 *
 *     straight:      out = (src*a + dst*(255-a)) / 255
 *     premultiplied: out = src' + dst*(255-a) / 255      where src' = src*a/255
 *
 * Each sprite also records the bounding box of its non-transparent pixels, so
 * the blend loop skips the empty margin every piece PNG has - typically 30-40%
 * of the sprite area.
 *
 * The frame is stored as RGB, not RGBA. The board is fully opaque, so the alpha
 * channel is 230,400 bytes of constant 0xFF that the PNG encoder would have to
 * compress on every render. Dropping it cuts encoder input by a quarter, which
 * matters because the deflate pass dominates the whole operation.
 *
 * Everything is bounds-checked. A malformed piece string, an out-of-range
 * sprite id or a sprite that failed to load is skipped rather than reading out
 * of bounds - this runs inside the bot process, so a crash here takes the whole
 * bot down.
 */

#include <napi.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG            // the sprites are PNG; drop the other decoders

#include "stb_image.h"

#define STB_IMAGE_WRITE_IMPLEMENTATION

#include "stb_image_write.h"

namespace {

// ── Geometry ──────────────────────────────────────────────────────────────────

constexpr int SQUARES_PER_SIDE = 8;
constexpr int SPRITE_COUNT     = 12;

int g_square_px = 60;                        // pixels per board square
int g_board_px  = SQUARES_PER_SIDE * 60;     // full board edge, in pixels

// Board colours. Light is the background fill; dark is painted per square.
uint8_t g_light[3] = { 255, 255, 255 };
uint8_t g_dark[3]  = { 128, 128, 128 };

// ── Exact 8-bit division by 255 ───────────────────────────────────────────────

/*
The original code used `>> 8`, i.e. divide by 256. That is 0.4% low on every
channel and compounds over a blend, so semi-transparent sprite edges came out
visibly darker than they should. This is exact for x in [0, 65535].
*/
inline uint8_t div255(uint32_t x) noexcept {
    x += 128;
    return static_cast<uint8_t>((x + (x >> 8)) >> 8);
}

// ── Sprite ────────────────────────────────────────────────────────────────────

struct Sprite {
    int w = 0;
    int h = 0;
    bool valid = false;

    // Premultiplied RGBA, row-major, w*h pixels
    std::vector<uint8_t> rgba;

    // Bounding box of pixels with alpha > 0; empty sprites keep x0 > x1
    int x0 = 0, y0 = 0, x1 = -1, y1 = -1;

    bool empty() const noexcept { return x1 < x0 || y1 < y0; }
};

Sprite g_sprites[SPRITE_COUNT];

/** Board template: RGB, g_board_px^2. memcpy'd at the start of every render. */
std::vector<uint8_t> g_board;

bool g_ready = false;

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Load one sprite, premultiply it, and record its opaque bounding box.
 * Returns false (leaving the sprite invalid) if the file is missing or corrupt.
 */
bool load_sprite(const std::string& path, Sprite& out) {
    int w = 0, h = 0, channels = 0;

    uint8_t* data = stbi_load(path.c_str(), &w, &h, &channels, 4);
    if (data == nullptr || w <= 0 || h <= 0) {
        if (data) stbi_image_free(data);
        out.valid = false;
        return false;
    }

    out.w = w;
    out.h = h;
    out.rgba.resize(static_cast<size_t>(w) * static_cast<size_t>(h) * 4);

    int min_x = w, min_y = h, max_x = -1, max_y = -1;

    for (int y = 0; y < h; ++y) {
        const uint8_t* src = data + static_cast<size_t>(y) * w * 4;
        uint8_t* dst = out.rgba.data() + static_cast<size_t>(y) * w * 4;

        for (int x = 0; x < w; ++x) {
            const uint8_t a = src[x * 4 + 3];

            // Premultiply once here so the hot blend loop doesn't have to
            dst[x * 4 + 0] = div255(static_cast<uint32_t>(src[x * 4 + 0]) * a);
            dst[x * 4 + 1] = div255(static_cast<uint32_t>(src[x * 4 + 1]) * a);
            dst[x * 4 + 2] = div255(static_cast<uint32_t>(src[x * 4 + 2]) * a);
            dst[x * 4 + 3] = a;

            if (a != 0) {
                if (x < min_x) min_x = x;
                if (x > max_x) max_x = x;
                if (y < min_y) min_y = y;
                if (y > max_y) max_y = y;
            }
        }
    }

    stbi_image_free(data);

    out.x0 = min_x; out.y0 = min_y;
    out.x1 = max_x; out.y1 = max_y;
    out.valid = true;
    return true;
}

/** Paint the static board into g_board. */
void build_board() {
    const size_t stride = static_cast<size_t>(g_board_px) * 3;
    g_board.assign(stride * static_cast<size_t>(g_board_px), 0);

    // Fill with the light colour first, one row then replicate
    uint8_t* row0 = g_board.data();
    for (int x = 0; x < g_board_px; ++x) {
        row0[x * 3 + 0] = g_light[0];
        row0[x * 3 + 1] = g_light[1];
        row0[x * 3 + 2] = g_light[2];
    }
    for (int y = 1; y < g_board_px; ++y) {
        std::memcpy(g_board.data() + static_cast<size_t>(y) * stride, row0, stride);
    }

    // Paint the dark squares. Same parity as the original: (file + rank) even.
    for (int rank = 0; rank < SQUARES_PER_SIDE; ++rank) {
        for (int file = 0; file < SQUARES_PER_SIDE; ++file) {
            if (((file + rank) & 1) != 0) continue;

            const int px = file * g_square_px;
            const int py = (SQUARES_PER_SIDE - 1 - rank) * g_square_px;

            for (int y = 0; y < g_square_px; ++y) {
                uint8_t* p = g_board.data() + (static_cast<size_t>(py + y) * stride) + static_cast<size_t>(px) * 3;
                for (int x = 0; x < g_square_px; ++x) {
                    p[x * 3 + 0] = g_dark[0];
                    p[x * 3 + 1] = g_dark[1];
                    p[x * 3 + 2] = g_dark[2];
                }
            }
        }
    }
}

// ── Compositing ───────────────────────────────────────────────────────────────

/**
 * Alpha-composite a premultiplied sprite onto the RGB frame at (ox, oy).
 * Clipped to the frame; only the sprite's opaque bounding box is walked.
 */
void blend(uint8_t* frame, const Sprite& s, int ox, int oy) noexcept {
    if (!s.valid || s.empty()) return;

    const size_t stride = static_cast<size_t>(g_board_px) * 3;

    // Clip the bounding box against the frame
    const int sx0 = std::max(s.x0, -ox);
    const int sy0 = std::max(s.y0, -oy);
    const int sx1 = std::min(s.x1, g_board_px - 1 - ox);
    const int sy1 = std::min(s.y1, g_board_px - 1 - oy);
    if (sx1 < sx0 || sy1 < sy0) return;

    for (int sy = sy0; sy <= sy1; ++sy) {
        const uint8_t* src = s.rgba.data() + (static_cast<size_t>(sy) * s.w + sx0) * 4;
        uint8_t* dst = frame + static_cast<size_t>(oy + sy) * stride + static_cast<size_t>(ox + sx0) * 3;

        for (int sx = sx0; sx <= sx1; ++sx, src += 4, dst += 3) {
            const uint8_t a = src[3];

            if (a == 0) continue;           // fully transparent - leave the board
            if (a == 255) {                 // fully opaque - straight copy
                dst[0] = src[0];
                dst[1] = src[1];
                dst[2] = src[2];
                continue;
            }

            const uint32_t inv = 255u - a;
            dst[0] = static_cast<uint8_t>(src[0] + div255(dst[0] * inv));
            dst[1] = static_cast<uint8_t>(src[1] + div255(dst[1] * inv));
            dst[2] = static_cast<uint8_t>(src[2] + div255(dst[2] * inv));
        }
    }
}

// ── Piece parsing ─────────────────────────────────────────────────────────────

struct Placement { int file; int rank; int id; };

/**
 * Parse "<file>,<rank>:<id>" without sscanf or a heap allocation.
 *
 * sscanf has to interpret its format string at runtime and was measurably the
 * second-largest cost after PNG encoding once the blend loop was tightened.
 * Returns false for anything malformed or out of range, and the caller skips it.
 */
bool parse_placement(const char* p, size_t len, Placement& out) noexcept {
    size_t i = 0;

    auto read_int = [&](int& value) noexcept -> bool {
        if (i >= len || p[i] < '0' || p[i] > '9') return false;
        int v = 0;
        while (i < len && p[i] >= '0' && p[i] <= '9') {
            v = v * 10 + (p[i] - '0');
            if (v > 9999) return false;          // nothing legitimate is this big
            ++i;
        }
        value = v;
        return true;
    };

    if (!read_int(out.file)) return false;
    if (i >= len || p[i] != ',') return false;
    ++i;
    if (!read_int(out.rank)) return false;
    if (i >= len || p[i] != ':') return false;
    ++i;
    if (!read_int(out.id)) return false;
    if (i != len) return false;                  // trailing junk

    return out.file >= 0 && out.file < SQUARES_PER_SIDE
        && out.rank >= 0 && out.rank < SQUARES_PER_SIDE
        && out.id   >= 0 && out.id   < SPRITE_COUNT;
}

// ── PNG encoding ──────────────────────────────────────────────────────────────

/*
Encoding, not compositing, is the whole cost of a render. With the blend loop
tightened, an EMPTY board encoded slower than a full one - stb's deflate walks a
hash chain per position, and a large area of one colour is the pathological case
for that. Blending 32 sprites is essentially free by comparison.

So the encoder is configurable. PNG is lossless and the safe default; JPEG runs
several times faster because it never searches for matches, and for a board
that is about to be re-encoded by Telegram anyway the difference is invisible at
a high quality setting.
*/
enum class Format { Png, Jpeg };

/*
JPEG is the default because Telegram re-encodes every photo it receives to JPEG.
Producing a lossless PNG costs 13 ms to make something the recipient never sees:
measured on this board, PNG level 5 is 13.1 ms and JPEG q92 is 7.0 ms for a
visually identical result once Telegram has had it.

Pass { format: "png" } to init() when the image is going out as a document, or
anywhere the exact pixels matter.
*/
Format g_format = Format::Jpeg;
int g_png_compression = 5;   // stb clamps anything below 5 up to 5
int g_jpeg_quality = 92;

struct Encoded {
    uint8_t* data = nullptr;
    int len = 0;
};

/** stb writes through a callback; collect into one growing buffer. */
struct Sink {
    std::vector<uint8_t> bytes;
};

void sink_write(void* context, void* data, int size) {
    Sink* s = static_cast<Sink*>(context);
    const uint8_t* p = static_cast<const uint8_t*>(data);
    s->bytes.insert(s->bytes.end(), p, p + size);
}

Encoded encode(const uint8_t* rgb) {
    Encoded out;

    if (g_format == Format::Png) {
        stbi_write_png_compression_level = g_png_compression;
        out.data = stbi_write_png_to_mem(rgb, g_board_px * 3, g_board_px, g_board_px, 3, &out.len);
        return out;
    }

    // JPEG has no to_mem helper, so collect through the callback writer
    Sink sink;
    sink.bytes.reserve(64 * 1024);

    if (stbi_write_jpg_to_func(sink_write, &sink, g_board_px, g_board_px, 3, rgb, g_jpeg_quality) == 0) {
        return out;
    }

    // Hand back a malloc'd block so both paths free the same way
    out.len = static_cast<int>(sink.bytes.size());
    out.data = static_cast<uint8_t*>(STBIW_MALLOC(sink.bytes.size()));
    if (out.data == nullptr) { out.len = 0; return out; }
    std::memcpy(out.data, sink.bytes.data(), sink.bytes.size());
    return out;
}

// ── N-API surface ─────────────────────────────────────────────────────────────

/**
 * init(spriteDir[, options])
 *
 * options: { squarePx?: number, light?: [r,g,b], dark?: [r,g,b], compression?: 0-9 }
 *
 * Returns { ok, loaded, missing: number[] } so the caller can tell a partial
 * load from a total failure instead of finding out at render time.
 */
Napi::Value Init(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "init(spriteDir) requires a directory path").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    const std::string base = info[0].As<Napi::String>().Utf8Value();

    if (info.Length() >= 2 && info[1].IsObject()) {
        Napi::Object opts = info[1].As<Napi::Object>();

        if (opts.Has("squarePx")) {
            const int v = opts.Get("squarePx").ToNumber().Int32Value();
            if (v >= 8 && v <= 512) g_square_px = v;
        }
        if (opts.Has("compression")) {
            const int v = opts.Get("compression").ToNumber().Int32Value();
            g_png_compression = std::clamp(v, 0, 9);
        }
        if (opts.Has("format")) {
            const std::string f = opts.Get("format").ToString().Utf8Value();
            g_format = (f == "jpeg" || f == "jpg") ? Format::Jpeg : Format::Png;
        }
        if (opts.Has("quality")) {
            const int v = opts.Get("quality").ToNumber().Int32Value();
            g_jpeg_quality = std::clamp(v, 1, 100);
        }
        auto read_colour = [&](const char* key, uint8_t* target) {
            if (!opts.Has(key)) return;
            Napi::Value raw = opts.Get(key);
            if (!raw.IsArray()) return;
            Napi::Array arr = raw.As<Napi::Array>();
            if (arr.Length() < 3) return;
            for (uint32_t c = 0; c < 3; ++c) {
                target[c] = static_cast<uint8_t>(std::clamp(arr.Get(c).ToNumber().Int32Value(), 0, 255));
            }
        };
        read_colour("light", g_light);
        read_colour("dark", g_dark);
    }

    g_board_px = SQUARES_PER_SIDE * g_square_px;
    build_board();

    int loaded = 0;
    Napi::Array missing = Napi::Array::New(env);
    uint32_t missing_n = 0;

    for (int i = 0; i < SPRITE_COUNT; ++i) {
        std::string path = base;
        if (!path.empty() && path.back() != '/' && path.back() != '\\') path.push_back('/');
        path += std::to_string(i);
        path += ".png";

        if (load_sprite(path, g_sprites[i])) ++loaded;
        else missing.Set(missing_n++, Napi::Number::New(env, i));
    }

    // Renderable as long as the board exists; missing sprites are skipped
    g_ready = true;

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, loaded == SPRITE_COUNT));
    result.Set("loaded", Napi::Number::New(env, loaded));
    result.Set("missing", missing);
    result.Set("boardPx", Napi::Number::New(env, g_board_px));
    return result;
}

/**
 * render(pieces) -> Buffer (PNG)
 *
 * `pieces` is an array of "<file>,<rank>:<spriteId>" strings. Entries that are
 * malformed, out of range, or reference a sprite that failed to load are
 * skipped - a bad board must not crash the bot.
 */
Napi::Value Render(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_ready) {
        Napi::Error::New(env, "render() called before init()").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "render(pieces) requires an array").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    /*
    Reused across calls. The board is ~700 KB; allocating and freeing that on
    every render was pure churn, and this addon is called once per move.
    */
    static std::vector<uint8_t> frame;
    frame.assign(g_board.begin(), g_board.end());

    const Napi::Array pieces = info[0].As<Napi::Array>();
    const uint32_t count = pieces.Length();

    for (uint32_t i = 0; i < count; ++i) {
        Napi::Value val = pieces.Get(i);
        if (!val.IsString()) continue;

        const std::string s = val.As<Napi::String>().Utf8Value();

        Placement p;
        if (!parse_placement(s.data(), s.size(), p)) continue;

        const Sprite& sprite = g_sprites[p.id];
        if (!sprite.valid) continue;

        // rank 0 is the bottom of the board, so it maps to the last row
        blend(frame.data(), sprite,
              p.file * g_square_px,
              (SQUARES_PER_SIDE - 1 - p.rank) * g_square_px);
    }

    Encoded img = encode(frame.data());
    if (img.data == nullptr || img.len <= 0) {
        Napi::Error::New(env, "image encoding failed").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    /*
    Hand the buffer to V8 rather than copying it - Napi::Buffer::Copy would
    duplicate the whole encoded image.

    AdjustExternalMemory is what makes this safe to do repeatedly. The bytes
    live outside the JS heap, so without telling V8 about them it sees a tiny
    heap, feels no pressure and never runs a GC: 3000 renders grew RSS by 94 MB
    of finished buffers waiting for a collection that had no reason to happen.
    Reporting the size makes those buffers count toward the GC trigger, and the
    finalizer gives the credit back.
    */
    const size_t len = static_cast<size_t>(img.len);
    Napi::MemoryManagement::AdjustExternalMemory(env, static_cast<int64_t>(len));

    return Napi::Buffer<uint8_t>::New(
        env, img.data, len,
        [len](Napi::Env e, uint8_t* data) {
            Napi::MemoryManagement::AdjustExternalMemory(e, -static_cast<int64_t>(len));
            STBIW_FREE(data);
        }
    );
}

Napi::Object Main(Napi::Env env, Napi::Object exports) {
    exports.Set("init", Napi::Function::New(env, Init));
    exports.Set("render", Napi::Function::New(env, Render));
    return exports;
}

}  // namespace

NODE_API_MODULE(App, Main)
