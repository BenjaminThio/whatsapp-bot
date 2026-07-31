/*
 * dict_indexer.c - builds dict.dat + dict.idx from a Wiktionary XML dump.
 *
 * Usage:
 *     dict_indexer enwiktionary-latest-pages-articles.xml [out_dir]
 *
 * Streams the XML with a small state machine - no DOM, no libxml2.
 * Memory: ~peak(largest_entry) for parsing + (entry_count * 32) for the
 * in-memory slot table during build. Final table is written to disk.
 *
 * Compile:
 *   MSVC:  cl /O2 /W3 /TC dict_indexer.c
 *   MinGW: gcc -O2 -Wall -std=c11 -o dict_indexer.exe dict_indexer.c
 *   Linux: gcc -O2 -Wall -std=c11 -o dict_indexer dict_indexer.c
 */
#define _CRT_SECURE_NO_WARNINGS
#define _GNU_SOURCE  /* enables memmem on glibc */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

/* ---- Portable shims for non-standard functions ----
 * Must be defined BEFORE anything that uses them. */

/* MSVC doesn't expose strncasecmp; MinGW does. */
#ifdef _MSC_VER
#define strncasecmp _strnicmp
#endif

/* memmem is a GNU extension. glibc has it (with _GNU_SOURCE), but MSVC,
 * MinGW, and macOS libc don't. We provide a portable implementation under
 * a different name and #define memmem to use it on those platforms.
 *
 * We detect glibc explicitly - if you're not on glibc, you get the fallback. */
#if !defined(__GLIBC__)
static void *portable_memmem(const void *hay, size_t hlen,
                             const void *ndl, size_t nlen) {
    if (nlen == 0) return (void*)hay;
    if (hlen < nlen) return NULL;
    const unsigned char *h = (const unsigned char*)hay;
    const unsigned char first = *(const unsigned char*)ndl;
    const size_t scan_end = hlen - nlen;
    for (size_t i = 0; i <= scan_end; i++) {
        if (h[i] == first && memcmp(h + i, ndl, nlen) == 0) {
            return (void*)(h + i);
        }
    }
    return NULL;
}
#define memmem portable_memmem
#endif

#include "dict_common.h"
#include "wikitext.h"

/* ---- Streaming XML reader ---- */

#define READ_CHUNK (1 << 20)  /* 1 MB read buffer */

typedef struct {
    FILE *fp;
    char *buf;
    size_t buf_len;
    size_t buf_pos;
    int eof;
} XmlReader;

static int xml_open(XmlReader *r, const char *path) {
    r->fp = fopen(path, "rb");
    if (!r->fp) return 0;
    r->buf = (char*)malloc(READ_CHUNK);
    r->buf_len = 0;
    r->buf_pos = 0;
    r->eof = 0;
    return r->buf != NULL;
}

static void xml_close(XmlReader *r) {
    if (r->fp) fclose(r->fp);
    free(r->buf);
}

/* Refill buffer when low. Preserves unconsumed bytes. */
static void xml_refill(XmlReader *r) {
    if (r->eof) return;
    if (r->buf_pos < r->buf_len) {
        size_t remaining = r->buf_len - r->buf_pos;
        memmove(r->buf, r->buf + r->buf_pos, remaining);
        r->buf_len = remaining;
    } else {
        r->buf_len = 0;
    }
    r->buf_pos = 0;
    size_t want = READ_CHUNK - r->buf_len;
    if (want > 0) {
        size_t got = fread(r->buf + r->buf_len, 1, want, r->fp);
        r->buf_len += got;
        if (got < want) r->eof = 1;
    }
}

/* Find the next occurrence of `needle` in the stream. Returns 1 if found,
 * positioning buf_pos just past the needle. */
static int xml_find(XmlReader *r, const char *needle) {
    size_t nlen = strlen(needle);
    for (;;) {
        if (r->buf_len - r->buf_pos < nlen + 64) {
            xml_refill(r);
            if (r->buf_len - r->buf_pos < nlen) {
                return 0;  /* EOF without match */
            }
        }
        char *hit = (char*)memmem(r->buf + r->buf_pos, r->buf_len - r->buf_pos,
                                  needle, nlen);
        if (hit) {
            r->buf_pos = (size_t)(hit - r->buf) + nlen;
            return 1;
        }
        /* Not found in current window - advance, keeping a tail in case the
         * match straddles the boundary. */
        size_t advance = r->buf_len - r->buf_pos;
        if (advance > nlen) advance -= nlen;
        r->buf_pos += advance;
        xml_refill(r);
        if (r->eof && r->buf_len - r->buf_pos < nlen) return 0;
    }
}

/* Read content up to `end_tag` into out. Returns 1 if found. */
static int xml_read_until(XmlReader *r, const char *end_tag, StrBuf *out) {
    size_t tlen = strlen(end_tag);
    sb_init(out);
    for (;;) {
        if (r->buf_len - r->buf_pos < tlen + 64) {
            xml_refill(r);
            if (r->buf_len - r->buf_pos < tlen && r->eof) return 0;
        }
        char *hit = (char*)memmem(r->buf + r->buf_pos, r->buf_len - r->buf_pos,
                                  end_tag, tlen);
        if (hit) {
            size_t copy_len = (size_t)(hit - (r->buf + r->buf_pos));
            sb_append(out, r->buf + r->buf_pos, copy_len);
            r->buf_pos += copy_len + tlen;
            return 1;
        }
        /* Append most of buffer, keep a tail for boundary safety */
        size_t safe = r->buf_len - r->buf_pos;
        if (safe > tlen) safe -= tlen;
        sb_append(out, r->buf + r->buf_pos, safe);
        r->buf_pos += safe;
        xml_refill(r);
        if (r->eof && r->buf_len - r->buf_pos < tlen) {
            /* Append remaining and return failure */
            sb_append(out, r->buf + r->buf_pos, r->buf_len - r->buf_pos);
            r->buf_pos = r->buf_len;
            return 0;
        }
    }
}

/* ---- XML entity decoder (for &amp; &lt; &gt; &quot; &#NN;) ---- */

static void decode_entities(StrBuf *sb) {
    if (!sb->data) return;
    size_t w = 0;
    for (size_t r = 0; r < sb->len; ) {
        if (sb->data[r] == '&') {
            if (r + 4 < sb->len && memcmp(sb->data + r, "&amp;", 5) == 0)   { sb->data[w++] = '&'; r += 5; continue; }
            if (r + 3 < sb->len && memcmp(sb->data + r, "&lt;", 4) == 0)    { sb->data[w++] = '<'; r += 4; continue; }
            if (r + 3 < sb->len && memcmp(sb->data + r, "&gt;", 4) == 0)    { sb->data[w++] = '>'; r += 4; continue; }
            if (r + 5 < sb->len && memcmp(sb->data + r, "&quot;", 6) == 0)  { sb->data[w++] = '"'; r += 6; continue; }
            if (r + 5 < sb->len && memcmp(sb->data + r, "&apos;", 6) == 0)  { sb->data[w++] = '\''; r += 6; continue; }
            /* numeric &#NN; - skip silently for now */
        }
        sb->data[w++] = sb->data[r++];
    }
    sb->len = w;
    if (sb->data) sb->data[w] = '\0';
}

/* ---- In-memory growable slot table during build ---- */

typedef struct {
    DictSlot *slots;
    uint64_t count;
    uint64_t cap;
} SlotList;

static void slotlist_init(SlotList *sl) {
    sl->cap = 1024;
    sl->slots = (DictSlot*)malloc(sl->cap * sizeof(DictSlot));
    sl->count = 0;
}

static void slotlist_push(SlotList *sl, DictSlot s) {
    if (sl->count >= sl->cap) {
        sl->cap *= 2;
        sl->slots = (DictSlot*)realloc(sl->slots, sl->cap * sizeof(DictSlot));
        if (!sl->slots) { fprintf(stderr, "OOM expanding slot list\n"); exit(3); }
    }
    sl->slots[sl->count++] = s;
}

/* ---- Skip non-content namespaces ---- */

static int is_skippable_title(const char *title, size_t len) {
    /* MediaWiki namespaces we don't want as dictionary entries */
    static const char *skip[] = {
        "Wiktionary:", "Template:", "Category:", "File:", "Help:", "User:",
        "MediaWiki:", "Module:", "Appendix:", "Index:", "Reconstruction:",
        "Citations:", "Rhymes:", "Sign gloss:", "Thread:", "Concordance:",
        "Talk:", "User talk:", "Wiktionary talk:", "Template talk:",
        "Category talk:", "File talk:", "Help talk:", "MediaWiki talk:",
        "Module talk:", "Appendix talk:", "Index talk:", "Reconstruction talk:",
        "Citations talk:", "Rhymes talk:", "Sign gloss talk:",
        NULL
    };
    for (int i = 0; skip[i]; i++) {
        size_t plen = strlen(skip[i]);
        if (len >= plen && memcmp(title, skip[i], plen) == 0) return 1;
    }
    return 0;
}

/* ---- Main ---- */

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "Usage: %s <enwiktionary.xml> [out_dir]\n", argv[0]);
        return 1;
    }
    const char *xml_path = argv[1];
    const char *out_dir = (argc >= 3) ? argv[2] : ".";

    char dat_path[1024], idx_path[1024];
    snprintf(dat_path, sizeof(dat_path), "%s/dict.dat", out_dir);
    snprintf(idx_path, sizeof(idx_path), "%s/dict.idx", out_dir);

    XmlReader r;
    if (!xml_open(&r, xml_path)) {
        fprintf(stderr, "Cannot open: %s\n", xml_path);
        return 2;
    }

    FILE *dat = fopen(dat_path, "wb");
    if (!dat) { fprintf(stderr, "Cannot create %s\n", dat_path); return 2; }

    SlotList slots;
    slotlist_init(&slots);

    uint64_t data_offset = 0;
    uint64_t pages_seen = 0;
    uint64_t pages_kept = 0;
    time_t start = time(NULL);

    StrBuf title, text, cleaned;
    sb_init(&title); sb_init(&text); sb_init(&cleaned);

    fprintf(stderr, "Indexing %s ...\n", xml_path);

    while (xml_find(&r, "<page>")) {
        pages_seen++;

        /* Find <title>...</title> */
        if (!xml_find(&r, "<title>")) break;
        sb_init(&title);
        if (!xml_read_until(&r, "</title>", &title)) break;
        decode_entities(&title);

        /* Find <text ...> (might have attributes like xml:space="preserve") */
        if (!xml_find(&r, "<text")) break;
        if (!xml_find(&r, ">")) break;
        sb_init(&text);
        if (!xml_read_until(&r, "</text>", &text)) break;
        decode_entities(&text);

        if (pages_seen % 50000 == 0) {
            double elapsed = (double)(time(NULL) - start);
            fprintf(stderr, "  scanned %llu pages, kept %llu, %.0fs elapsed\n",
                    (unsigned long long)pages_seen,
                    (unsigned long long)pages_kept, elapsed);
        }

        /* Skip namespaces and empty titles */
        if (title.len == 0 || is_skippable_title(title.data, title.len)) {
            sb_free(&title); sb_free(&text);
            continue;
        }

        /* Skip redirects: pages whose text starts with "#REDIRECT" */
        if (text.len >= 9 && (
                strncasecmp(text.data, "#REDIRECT", 9) == 0 ||
                strncasecmp(text.data, "#redirect", 9) == 0)) {
            sb_free(&title); sb_free(&text);
            continue;
        }

        /* Strip wikitext */
        sb_init(&cleaned);
        if (!strip_wikitext(text.data, text.len, &cleaned) || cleaned.len < 4) {
            sb_free(&title); sb_free(&text); sb_free(&cleaned);
            continue;
        }
        sb_rtrim(&cleaned);

        /* Write [title][\n][cleaned] to dat */
        uint32_t word_length = (uint32_t)title.len;
        uint32_t data_length = (uint32_t)(title.len + 1 + cleaned.len);

        fwrite(title.data, 1, title.len, dat);
        fputc('\n', dat);
        fwrite(cleaned.data, 1, cleaned.len, dat);

        DictSlot s;
        s.word_hash = dict_fnv1a(title.data, title.len);
        s.data_offset = data_offset;
        s.data_length = data_length;
        s.word_length = word_length;
        slotlist_push(&slots, s);

        data_offset += data_length;
        pages_kept++;

        sb_free(&title); sb_free(&text); sb_free(&cleaned);
    }

    fclose(dat);
    xml_close(&r);

    fprintf(stderr, "\nScanning done. %llu pages seen, %llu kept.\n",
            (unsigned long long)pages_seen, (unsigned long long)pages_kept);
    fprintf(stderr, "Data file: %llu bytes\n", (unsigned long long)data_offset);

    /* ---- Build final hash table (size = next_pow2(count / load_factor)) ---- */

    uint64_t target = (uint64_t)((double)slots.count / DICT_LOAD_FACTOR);
    uint64_t slot_count = dict_next_pow2(target);
    if (slot_count < 16) slot_count = 16;

    DictSlot *table = (DictSlot*)calloc(slot_count, sizeof(DictSlot));
    if (!table) { fprintf(stderr, "OOM allocating final table (%llu slots)\n",
                          (unsigned long long)slot_count); return 3; }

    uint64_t mask = slot_count - 1;
    uint64_t inserted = 0;
    for (uint64_t i = 0; i < slots.count; i++) {
        DictSlot s = slots.slots[i];
        uint64_t idx = s.word_hash & mask;
        while (table[idx].data_length != 0) {
            idx = (idx + 1) & mask;
        }
        table[idx] = s;
        inserted++;
    }

    fprintf(stderr, "Hash table: %llu slots, %llu inserted, load %.2f\n",
            (unsigned long long)slot_count, (unsigned long long)inserted,
            (double)inserted / (double)slot_count);

    /* Write idx file: header + table */
    FILE *idx = fopen(idx_path, "wb");
    if (!idx) { fprintf(stderr, "Cannot create %s\n", idx_path); return 2; }

    DictHeader hdr;
    memset(&hdr, 0, sizeof(hdr));
    hdr.magic = DICT_MAGIC;
    hdr.version = DICT_VERSION;
    hdr.slot_count = slot_count;
    hdr.entry_count = inserted;
    hdr.data_size = data_offset;

    fwrite(&hdr, sizeof(hdr), 1, idx);
    fwrite(table, sizeof(DictSlot), slot_count, idx);
    fclose(idx);

    free(table);
    free(slots.slots);

    double elapsed = (double)(time(NULL) - start);
    fprintf(stderr, "Done in %.0fs. Wrote %s and %s.\n",
            elapsed, dat_path, idx_path);
    return 0;
}