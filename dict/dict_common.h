/*
 * dict_common.h - shared format definitions for the Wiktionary dict engine.
 *
 * Two files comprise a built dictionary:
 *   dict.dat - concatenated UTF-8 entry text, no delimiters needed (offset+len in idx)
 *   dict.idx - fixed-size header followed by a flat hash table of Slot records
 *
 * Lookup is O(1) average via 64-bit FNV-1a hashing with linear probing.
 * Collisions are extraordinarily rare with 64-bit hashes over <100M entries,
 * but we verify by re-checking the headword stored at the start of each
 * data entry, so a collision can never serve wrong content.
 */
#ifndef DICT_COMMON_H
#define DICT_COMMON_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

/* Magic number to detect mismatched index files. Increment if format changes. */
#define DICT_MAGIC      0x44494354U  /* "DICT" */
#define DICT_VERSION    1U

/* Load factor: 0.7 means table size = (entry_count / 0.7) rounded up to a power of 2.
 * Lower load = faster lookups, more memory; higher = opposite. */
#define DICT_LOAD_FACTOR 0.7

/* On-disk index header. Stored at the start of dict.idx. */
typedef struct {
    uint32_t magic;        /* DICT_MAGIC */
    uint32_t version;      /* DICT_VERSION */
    uint64_t slot_count;   /* total slots in the hash table (power of 2) */
    uint64_t entry_count;  /* actual entries indexed */
    uint64_t data_size;    /* size of dict.dat in bytes (sanity check) */
    uint8_t  reserved[32]; /* room for future fields without bumping version */
} DictHeader;

/* One hash table slot. Empty slots have word_hash == 0 AND data_length == 0. */
typedef struct {
    uint64_t word_hash;    /* FNV-1a 64-bit of the lowercased headword */
    uint64_t data_offset;  /* byte offset into dict.dat */
    uint32_t data_length;  /* length in bytes of the entry */
    uint32_t word_length;  /* length of the headword stored at data_offset */
                           /* The data layout at data_offset is:
                            *   [word_length bytes: headword in UTF-8]
                            *   [data_length - word_length bytes: entry body]
                            * Used to verify against hash collisions. */
} DictSlot;

/* FNV-1a 64-bit hash. Fast, well-distributed, no dependencies.
 * We hash the lowercased ASCII form of the headword for case-insensitive lookup.
 * Non-ASCII bytes are hashed as-is, preserving exact match for accented words. */
static inline uint64_t dict_fnv1a(const char *s, size_t n) {
    uint64_t h = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        /* Case-fold ASCII letters; leave UTF-8 multibyte sequences untouched. */
        if (c >= 'A' && c <= 'Z') c += 32;
        h ^= c;
        h *= 0x100000001b3ULL;
    }
    return h;
}

/* Round up to the next power of two. Used to size the hash table. */
static inline uint64_t dict_next_pow2(uint64_t x) {
    if (x <= 1) return 1;
    x--;
    x |= x >> 1;  x |= x >> 2;  x |= x >> 4;
    x |= x >> 8;  x |= x >> 16; x |= x >> 32;
    return x + 1;
}

#endif /* DICT_COMMON_H */