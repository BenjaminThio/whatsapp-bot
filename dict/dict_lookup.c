/*
 * dict_lookup.c - fast Wiktionary lookup against dict.dat + dict.idx.
 *
 * Two modes:
 *   1. Single-shot:    dict_lookup <word>             → exit 0 on hit, 1 on miss
 *   2. Interactive:    dict_lookup --interactive
 *      Reads words from stdin (one per line), writes responses to stdout.
 *      Each response is "<status> <length>\n<payload>\n" where status is OK or
 *      NOTFOUND, length is the byte length of the payload (0 on NOTFOUND).
 *
 * Compile:
 *   MSVC:  cl /O2 /W3 /TC dict_lookup.c
 *   MinGW: gcc -O2 -Wall -std=c11 -o dict_lookup.exe dict_lookup.c
 *   Linux: gcc -O2 -Wall -std=c11 -o dict_lookup dict_lookup.c
 */
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "dict_common.h"

#ifdef _WIN32
#include <windows.h>
#include <io.h>      /* _setmode, _fileno */
#include <fcntl.h>   /* _O_BINARY */
#define PATH_SEP '\\'
#else
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#define PATH_SEP '/'
#endif

/* ---- Portable mmap shim ---- */

typedef struct {
    const void *base;
    size_t size;
#ifdef _WIN32
    HANDLE file;
    HANDLE mapping;
#else
    int fd;
#endif
} MappedFile;

static int mf_open(MappedFile *m, const char *path) {
#ifdef _WIN32
    m->file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                          OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (m->file == INVALID_HANDLE_VALUE) return 0;
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(m->file, &sz)) { CloseHandle(m->file); return 0; }
    m->size = (size_t)sz.QuadPart;
    m->mapping = CreateFileMappingA(m->file, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!m->mapping) { CloseHandle(m->file); return 0; }
    m->base = MapViewOfFile(m->mapping, FILE_MAP_READ, 0, 0, 0);
    if (!m->base) { CloseHandle(m->mapping); CloseHandle(m->file); return 0; }
    return 1;
#else
    m->fd = open(path, O_RDONLY);
    if (m->fd < 0) return 0;
    struct stat st;
    if (fstat(m->fd, &st) < 0) { close(m->fd); return 0; }
    m->size = (size_t)st.st_size;
    m->base = mmap(NULL, m->size, PROT_READ, MAP_PRIVATE, m->fd, 0);
    if (m->base == MAP_FAILED) { close(m->fd); m->base = NULL; return 0; }
    return 1;
#endif
}

static void mf_close(MappedFile *m) {
#ifdef _WIN32
    if (m->base) UnmapViewOfFile(m->base);
    if (m->mapping) CloseHandle(m->mapping);
    if (m->file) CloseHandle(m->file);
#else
    if (m->base) munmap((void*)m->base, m->size);
    if (m->fd >= 0) close(m->fd);
#endif
    m->base = NULL;
}

/* ---- Dictionary handle ---- */

typedef struct {
    MappedFile dat;
    MappedFile idx;
    const DictHeader *hdr;
    const DictSlot *table;
    uint64_t mask;
} Dict;

static int dict_open(Dict *d, const char *dir) {
    char dat_path[1024], idx_path[1024];
    snprintf(dat_path, sizeof(dat_path), "%s%cdict.dat", dir, PATH_SEP);
    snprintf(idx_path, sizeof(idx_path), "%s%cdict.idx", dir, PATH_SEP);

    if (!mf_open(&d->dat, dat_path)) {
        fprintf(stderr, "Cannot open %s\n", dat_path);
        return 0;
    }
    if (!mf_open(&d->idx, idx_path)) {
        fprintf(stderr, "Cannot open %s\n", idx_path);
        mf_close(&d->dat);
        return 0;
    }

    if (d->idx.size < sizeof(DictHeader)) {
        fprintf(stderr, "Index file too small\n");
        return 0;
    }
    d->hdr = (const DictHeader *)d->idx.base;
    if (d->hdr->magic != DICT_MAGIC) {
        fprintf(stderr, "Bad magic in index\n");
        return 0;
    }
    if (d->hdr->version != DICT_VERSION) {
        fprintf(stderr, "Unsupported index version %u\n", d->hdr->version);
        return 0;
    }

    d->table = (const DictSlot *)((const char*)d->idx.base + sizeof(DictHeader));
    d->mask = d->hdr->slot_count - 1;
    return 1;
}

static void dict_close(Dict *d) {
    mf_close(&d->dat);
    mf_close(&d->idx);
}

/* Lookup. The body section excludes the stored headword prefix + separator. */
static int dict_lookup(const Dict *d, const char *word, size_t word_len,
                       const char **out_body, size_t *out_body_len) {
    uint64_t h = dict_fnv1a(word, word_len);
    uint64_t idx = h & d->mask;

    for (uint64_t step = 0; step < d->hdr->slot_count; step++) {
        const DictSlot *s = &d->table[idx];
        if (s->data_length == 0) return 0;  /* empty slot - definitive miss */

        if (s->word_hash == h && s->word_length == word_len) {
            if (s->data_offset + s->word_length <= d->dat.size) {
                const char *stored = (const char*)d->dat.base + s->data_offset;
                if (memcmp(stored, word, word_len) == 0) {
                    *out_body = stored + word_len + 1;  /* +1 for the \n separator */
                    *out_body_len = s->data_length - (word_len + 1);
                    return 1;
                }
            }
        }
        idx = (idx + 1) & d->mask;
    }
    return 0;
}

/* ---- Main ---- */

static int run_single(Dict *d, const char *word) {
    size_t wlen = strlen(word);
    while (wlen > 0 && (word[wlen-1] == '\n' || word[wlen-1] == '\r' ||
                        word[wlen-1] == ' ' || word[wlen-1] == '\t')) wlen--;

    const char *body = NULL;
    size_t body_len = 0;
    if (dict_lookup(d, word, wlen, &body, &body_len)) {
        fwrite(body, 1, body_len, stdout);
        fputc('\n', stdout);
        return 0;
    }
    fprintf(stderr, "Not found: %.*s\n", (int)wlen, word);
    return 1;
}

static int run_interactive(Dict *d) {
#ifdef _WIN32
    /* Binary mode prevents CRLF translation on the pipe, which is critical for
     * length-prefixed protocols: the parent counts bytes by what we wrote. */
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    /* Disable C-runtime buffering on stdout so each response is written as a
     * single contiguous block from the parent's perspective. setvbuf with NULL
     * + _IONBF disables buffering entirely. */
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    char line[4096];
    while (fgets(line, sizeof(line), stdin)) {
        size_t wlen = strlen(line);
        while (wlen > 0 && (line[wlen-1] == '\n' || line[wlen-1] == '\r')) wlen--;
        line[wlen] = '\0';
        if (wlen == 0) continue;

        const char *body = NULL;
        size_t body_len = 0;
        if (dict_lookup(d, line, wlen, &body, &body_len)) {
            /* %llu with an unsigned long long cast is universally supported,
             * unlike %zu which had MSVC issues pre-VS2015. */
            fprintf(stdout, "OK %llu\n", (unsigned long long)body_len);
            fwrite(body, 1, body_len, stdout);
            fputc('\n', stdout);
        } else {
            fprintf(stdout, "NOTFOUND 0\n\n");
        }
        fflush(stdout);  /* defensive - should already be unbuffered */
    }
    return 0;
}

int main(int argc, char **argv) {
    const char *dir = getenv("DICT_DIR");
    if (!dir) dir = ".";

    Dict d;
    if (!dict_open(&d, dir)) return 2;

    int rc;
    if (argc >= 2 && strcmp(argv[1], "--interactive") == 0) {
        rc = run_interactive(&d);
    } else if (argc >= 2) {
        rc = run_single(&d, argv[1]);
    } else {
        fprintf(stderr, "Usage: %s <word>   OR   %s --interactive\n", argv[0], argv[0]);
        rc = 1;
    }

    dict_close(&d);
    return rc;
}