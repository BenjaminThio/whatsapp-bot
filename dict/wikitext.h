/*
 * wikitext.h - Wiktionary markup stripper, v2.
 *
 * Improvements over v1:
 *   - Common templates (plural of, form of, lb, l, m, ...) are RESOLVED to
 *     readable text instead of unconditionally dropped. This prevents the
 *     "noun: " empty-definition problem on entries where the meaning was
 *     entirely encoded in a template.
 *   - Definitions whose content is empty/trivial after cleaning are skipped.
 *   - Language sections with zero surviving definitions are not emitted.
 *   - State machine properly tracks current language; no fragile backscanning.
 *
 * Output format:
 *   === English ===
 *   noun: A unit of language used to communicate.
 *   noun: (computing) A fixed-size unit of data.
 *
 *   === French ===
 *   noun: news, gossip
 */
#ifndef WIKITEXT_H
#define WIKITEXT_H

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>

/* --- Growable string buffer --- */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} StrBuf;

static void sb_init(StrBuf *sb) { sb->data = NULL; sb->len = 0; sb->cap = 0; }
static void sb_free(StrBuf *sb) { free(sb->data); sb->data = NULL; sb->len = sb->cap = 0; }

static void sb_reserve(StrBuf *sb, size_t extra) {
    if (sb->len + extra + 1 > sb->cap) {
        size_t newcap = sb->cap ? sb->cap * 2 : 256;
        while (newcap < sb->len + extra + 1) newcap *= 2;
        char *p = (char*)realloc(sb->data, newcap);
        if (!p) return;
        sb->data = p; sb->cap = newcap;
    }
}

static void sb_append(StrBuf *sb, const char *s, size_t n) {
    sb_reserve(sb, n);
    if (sb->cap >= sb->len + n + 1) {
        memcpy(sb->data + sb->len, s, n);
        sb->len += n;
        sb->data[sb->len] = '\0';
    }
}

static void sb_append_cstr(StrBuf *sb, const char *s) { sb_append(sb, s, strlen(s)); }
static void sb_append_char(StrBuf *sb, char c) { sb_append(sb, &c, 1); }

static void sb_truncate(StrBuf *sb, size_t to) {
    if (to < sb->len) {
        sb->len = to;
        if (sb->data) sb->data[to] = '\0';
    }
}

static void sb_rtrim(StrBuf *sb) {
    while (sb->len > 0 && (sb->data[sb->len - 1] == ' '  ||
                           sb->data[sb->len - 1] == '\t' ||
                           sb->data[sb->len - 1] == '\n')) {
        sb->len--;
    }
    if (sb->data) sb->data[sb->len] = '\0';
}

/* --- Template argument helpers ---
 * Given a template "{{name|arg1|arg2|arg3}}", returns the Nth pipe-delimited
 * argument (0 = name, 1 = arg1, ...). Skips named args (key=value).
 * If the inner content has nested templates, those are dropped from the args
 * for simplicity - accurate enough for the cases we handle.
 */
static int template_get_arg(const char *inner, size_t inner_len, int n,
                            const char **out, size_t *out_len) {
    int depth = 0;
    size_t arg_start = 0;
    int current = 0;

    for (size_t i = 0; i <= inner_len; i++) {
        if (i == inner_len || (depth == 0 && inner[i] == '|')) {
            if (current == n) {
                const char *s = inner + arg_start;
                size_t l = i - arg_start;
                /* Reject named args by scanning for '=' before any space/bracket */
                int has_eq = 0;
                for (size_t k = 0; k < l; k++) {
                    if (s[k] == '=') { has_eq = 1; break; }
                    if (s[k] == '[' || s[k] == '{') break;
                }
                if (has_eq) {
                    /* Try the next positional */
                    current++;
                    arg_start = i + 1;
                    continue;
                }
                *out = s;
                *out_len = l;
                return 1;
            }
            current++;
            arg_start = i + 1;
        } else if (i + 1 < inner_len && inner[i] == '{' && inner[i+1] == '{') {
            depth++; i++;
        } else if (i + 1 < inner_len && inner[i] == '}' && inner[i+1] == '}') {
            if (depth > 0) { depth--; i++; }
        } else if (i + 1 < inner_len && inner[i] == '[' && inner[i+1] == '[') {
            depth++; i++;
        } else if (i + 1 < inner_len && inner[i] == ']' && inner[i+1] == ']') {
            if (depth > 0) { depth--; i++; }
        }
    }
    return 0;
}

/* Get template name (the bit before the first |). */
static int template_get_name(const char *inner, size_t inner_len,
                             const char **out, size_t *out_len) {
    return template_get_arg(inner, inner_len, 0, out, out_len);
}

static int starts_with_ci(const char *s, size_t slen, const char *prefix) {
    size_t plen = strlen(prefix);
    if (slen < plen) return 0;
    for (size_t i = 0; i < plen; i++) {
        char a = s[i]; char b = prefix[i];
        if (a >= 'A' && a <= 'Z') a += 32;
        if (b >= 'A' && b <= 'Z') b += 32;
        if (a != b) return 0;
    }
    return 1;
}

static int eq_ci(const char *s, size_t slen, const char *target) {
    size_t tlen = strlen(target);
    if (slen != tlen) return 0;
    return starts_with_ci(s, slen, target);
}

/* --- Template resolver ---
 * Handles the most common Wiktionary templates that carry the actual
 * definition content. For unrecognized templates, we drop them entirely
 * (same as v1 behavior).
 *
 * Returns 1 if we emitted something to `out`, 0 if we dropped the template.
 */
static int resolve_template(const char *inner, size_t inner_len, StrBuf *out) {
    const char *name = NULL;
    size_t name_len = 0;
    if (!template_get_name(inner, inner_len, &name, &name_len)) return 0;

    /* {{l|lang|word}} → "word" (link to another language's entry) */
    /* {{m|lang|word}} → "word" (mention) */
    /* {{lang|code|text}} → "text" */
    if (eq_ci(name, name_len, "l") || eq_ci(name, name_len, "m") ||
        eq_ci(name, name_len, "link") || eq_ci(name, name_len, "mention") ||
        eq_ci(name, name_len, "lang")) {
        const char *w = NULL; size_t wl = 0;
        /* Prefer the display arg (3) if present, else arg 2 */
        if (template_get_arg(inner, inner_len, 3, &w, &wl) && wl > 0) {
            sb_append(out, w, wl);
        } else if (template_get_arg(inner, inner_len, 2, &w, &wl) && wl > 0) {
            sb_append(out, w, wl);
        }
        return 1;
    }

    /* {{lb|lang|label1|label2|...}} → "(label1, label2)" - qualifier labels */
    /* {{label|...}}, {{tlb|...}} are synonyms */
    if (eq_ci(name, name_len, "lb") || eq_ci(name, name_len, "label") ||
        eq_ci(name, name_len, "tlb") || eq_ci(name, name_len, "qualifier") ||
        eq_ci(name, name_len, "q") || eq_ci(name, name_len, "i")) {
        sb_append_char(out, '(');
        int first = 1;
        for (int i = 2; i < 10; i++) {
            const char *w = NULL; size_t wl = 0;
            if (!template_get_arg(inner, inner_len, i, &w, &wl)) break;
            if (wl == 0) continue;
            /* Skip technical labels like "_" or "and" that are pure glue */
            if (wl == 1 && (w[0] == '_' || w[0] == ',')) continue;
            if (!first) sb_append_cstr(out, ", ");
            sb_append(out, w, wl);
            first = 0;
        }
        sb_append_char(out, ')');
        if (first) {
            /* No labels survived - undo the empty "()" */
            sb_truncate(out, out->len - 2);
            return 0;
        }
        sb_append_char(out, ' ');
        return 1;
    }

    /* {{plural of|lang|word}} → "plural of word" */
    /* Same pattern for: singular of, alternative form of, alternative spelling of,
     *                   form of, inflection of, past of, present of, etc. */
    {
        struct { const char *tpl; const char *expansion; } forms[] = {
            { "plural of",              "plural of" },
            { "singular of",            "singular of" },
            { "alternative form of",    "alternative form of" },
            { "alternative spelling of","alternative spelling of" },
            { "alt form",               "alternative form of" },
            { "alt sp",                 "alternative spelling of" },
            { "alt form of",            "alternative form of" },
            { "alt sp of",              "alternative spelling of" },
            { "abbreviation of",        "abbreviation of" },
            { "acronym of",             "acronym of" },
            { "initialism of",          "initialism of" },
            { "synonym of",             "synonym of" },
            { "diminutive of",          "diminutive of" },
            { "augmentative of",        "augmentative of" },
            { "feminine of",            "feminine of" },
            { "masculine of",           "masculine of" },
            { "form of",                "form of" },
            { "inflection of",          "inflection of" },
            { "past of",                "past of" },
            { "past participle of",     "past participle of" },
            { "present participle of",  "present participle of" },
            { "gerund of",              "gerund of" },
            { "comparative of",         "comparative of" },
            { "superlative of",         "superlative of" },
            { "ellipsis of",            "ellipsis of" },
            { "obsolete form of",       "obsolete form of" },
            { "archaic form of",        "archaic form of" },
            { "alternative case form of","alternative case form of" },
            { "misspelling of",         "misspelling of" },
            { "rare form of",           "rare form of" },
            { "romanization of",        "romanization of" },
            { "transliteration of",     "transliteration of" },
            { "n-g",                    NULL },  /* non-gloss - see below */
            { "ngd",                    NULL },
            { "non-gloss definition",   NULL },
            { NULL, NULL },
        };
        for (int i = 0; forms[i].tpl; i++) {
            if (eq_ci(name, name_len, forms[i].tpl)) {
                if (forms[i].expansion) {
                    sb_append_cstr(out, forms[i].expansion);
                    sb_append_char(out, ' ');
                }
                /* Append the target word (arg 2 for "X of" templates) */
                const char *w = NULL; size_t wl = 0;
                if (template_get_arg(inner, inner_len, 2, &w, &wl) && wl > 0) {
                    if (eq_ci(name, name_len, "n-g") || eq_ci(name, name_len, "ngd") ||
                        eq_ci(name, name_len, "non-gloss definition")) {
                        /* n-g takes the gloss as arg 1, not arg 2 */
                    } else {
                        sb_append(out, w, wl);
                    }
                }
                /* For non-gloss, arg 1 holds the actual text */
                if (eq_ci(name, name_len, "n-g") || eq_ci(name, name_len, "ngd") ||
                    eq_ci(name, name_len, "non-gloss definition")) {
                    if (template_get_arg(inner, inner_len, 1, &w, &wl) && wl > 0) {
                        sb_append(out, w, wl);
                    }
                }
                return 1;
            }
        }
    }

    /* {{w|article}} → "article"   (link to Wikipedia) */
    if (eq_ci(name, name_len, "w") || eq_ci(name, name_len, "wikipedia")) {
        const char *w = NULL; size_t wl = 0;
        if (template_get_arg(inner, inner_len, 2, &w, &wl) && wl > 0) {
            sb_append(out, w, wl);
        } else if (template_get_arg(inner, inner_len, 1, &w, &wl) && wl > 0) {
            sb_append(out, w, wl);
        }
        return 1;
    }

    /* {{gloss|text}} or {{gl|text}} → "(text)" */
    if (eq_ci(name, name_len, "gloss") || eq_ci(name, name_len, "gl")) {
        const char *w = NULL; size_t wl = 0;
        if (template_get_arg(inner, inner_len, 1, &w, &wl) && wl > 0) {
            sb_append_char(out, '(');
            sb_append(out, w, wl);
            sb_append_char(out, ')');
        }
        return 1;
    }

    /* {{taxlink|name|...}} → "name" - taxonomic linking */
    if (eq_ci(name, name_len, "taxlink") || eq_ci(name, name_len, "taxon") ||
        eq_ci(name, name_len, "vern")) {
        const char *w = NULL; size_t wl = 0;
        if (template_get_arg(inner, inner_len, 1, &w, &wl) && wl > 0) {
            sb_append(out, w, wl);
        }
        return 1;
    }

    /* {{IPAchar|text}} → "text" - phonetic transcription */
    if (eq_ci(name, name_len, "ipachar") || eq_ci(name, name_len, "ipa")) {
        const char *w = NULL; size_t wl = 0;
        if (template_get_arg(inner, inner_len, 2, &w, &wl) && wl > 0) {
            sb_append(out, w, wl);
        }
        return 1;
    }

    /* Default: drop the template silently */
    return 0;
}

/* --- Inline cleaner --- */

static void clean_line(const char *line, size_t n, StrBuf *out) {
    size_t i = 0;
    int last_was_space = 1;

    while (i < n) {
        char c = line[i];

        /* {{template|...}} - try to resolve, else drop */
        if (c == '{' && i + 1 < n && line[i+1] == '{') {
            i += 2;
            size_t inner_start = i;
            int depth = 1;
            while (i < n && depth > 0) {
                if (i + 1 < n && line[i] == '{' && line[i+1] == '{') {
                    depth++; i += 2;
                } else if (i + 1 < n && line[i] == '}' && line[i+1] == '}') {
                    depth--; i += 2;
                    if (depth == 0) break;
                } else {
                    i++;
                }
            }
            /* inner span is [inner_start, i-2) if we found matching }} */
            size_t inner_end = (i >= 2 && depth == 0) ? i - 2 : i;
            size_t mark = out->len;
            if (resolve_template(line + inner_start, inner_end - inner_start, out)) {
                if (out->len > mark) last_was_space = 0;
            }
            continue;
        }

        /* [[link|display]] → "display" ; [[link]] → "link" */
        if (c == '[' && i + 1 < n && line[i+1] == '[') {
            i += 2;
            size_t link_start = i;
            size_t pipe_pos = (size_t)-1;
            while (i + 1 < n && !(line[i] == ']' && line[i+1] == ']')) {
                if (line[i] == '|') pipe_pos = i;
                i++;
            }
            size_t link_end = i;
            if (i + 1 < n) i += 2;  /* skip ]] */

            size_t text_start = (pipe_pos != (size_t)-1) ? pipe_pos + 1 : link_start;
            size_t text_end = link_end;

            /* Skip namespaced links: [[File:...]], [[Category:...]], [[w:...]] */
            int skip = 0;
            for (size_t k = link_start;
                 k < (pipe_pos != (size_t)-1 ? pipe_pos : link_end); k++) {
                if (line[k] == ':') { skip = 1; break; }
            }
            if (skip) continue;

            sb_append(out, line + text_start, text_end - text_start);
            last_was_space = 0;
            continue;
        }

        /* '''bold''' / ''italic'' - strip markers */
        if (c == '\'' && i + 2 < n && line[i+1] == '\'' && line[i+2] == '\'') {
            i += 3; continue;
        }
        if (c == '\'' && i + 1 < n && line[i+1] == '\'') {
            i += 2; continue;
        }

        /* HTML: comments, refs, generic tags */
        if (c == '<') {
            if (i + 3 < n && line[i+1] == '!' && line[i+2] == '-' && line[i+3] == '-') {
                i += 4;
                while (i + 2 < n && !(line[i] == '-' && line[i+1] == '-' && line[i+2] == '>')) i++;
                if (i + 2 < n) i += 3;
                continue;
            }
            if (i + 4 < n && (line[i+1] == 'r' || line[i+1] == 'R') &&
                starts_with_ci(line + i, n - i, "<ref")) {
                size_t j = i;
                while (j < n && line[j] != '>') j++;
                if (j < n) j++;
                size_t k = j;
                while (k + 5 < n && !starts_with_ci(line + k, n - k, "</ref>")) k++;
                if (k + 5 < n) { i = k + 6; continue; }
                i = n; continue;
            }
            size_t j = i + 1;
            while (j < n && line[j] != '>') j++;
            if (j < n) i = j + 1; else i = n;
            continue;
        }

        /* Default char with whitespace collapsing */
        if (c == '\t' || c == '\r' || c == '\n' || c == ' ') {
            if (!last_was_space) {
                sb_append_char(out, ' ');
                last_was_space = 1;
            }
        } else {
            sb_append_char(out, c);
            last_was_space = 0;
        }
        i++;
    }
}

/* --- Triviality check ---
 * A definition is "trivial" if after cleaning it has fewer than 3 alphanumeric
 * characters (e.g. just punctuation, a single digit, or an orphan symbol).
 * This catches `noun: .` and `noun: ;` cases left by template-only entries.
 */
static int is_trivial_definition(const char *s, size_t n) {
    int alnum = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if ((c >= '0' && c <= '9') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= 'a' && c <= 'z') ||
            c >= 0x80) {  /* UTF-8 continuation/start bytes count as content */
            alnum++;
            if (alnum >= 3) return 0;
        }
    }
    return 1;
}

/* Normalize a cleaned definition: trim leading/trailing whitespace and
 * trailing punctuation that's likely orphaned (`;`, `:` left dangling after
 * a stripped template). */
static void trim_definition(StrBuf *sb, size_t from) {
    /* Trim leading whitespace */
    size_t lead = from;
    while (lead < sb->len && (sb->data[lead] == ' ' || sb->data[lead] == '\t')) lead++;
    if (lead > from) {
        memmove(sb->data + from, sb->data + lead, sb->len - lead);
        sb->len -= (lead - from);
        if (sb->data) sb->data[sb->len] = '\0';
    }

    /* Trim trailing whitespace + orphan punctuation */
    while (sb->len > from) {
        char c = sb->data[sb->len - 1];
        if (c == ' ' || c == '\t' || c == ';' || c == ':' || c == ',') {
            sb->len--;
        } else break;
    }
    if (sb->data) sb->data[sb->len] = '\0';
}

/* --- Header matchers --- */

static const char *match_pos(const char *line, size_t n) {
    static const char *pos_list[] = {
        "Noun", "Verb", "Adjective", "Adverb", "Pronoun", "Preposition",
        "Conjunction", "Interjection", "Article", "Determiner", "Numeral",
        "Particle", "Postposition", "Proper noun", "Phrase", "Idiom",
        "Abbreviation", "Acronym", "Initialism", "Letter", "Symbol",
        "Suffix", "Prefix", "Infix", "Counter", "Classifier", "Number",
        "Contraction", "Participle",
        NULL
    };
    static const char *pos_lower[] = {
        "noun", "verb", "adjective", "adverb", "pronoun", "preposition",
        "conjunction", "interjection", "article", "determiner", "numeral",
        "particle", "postposition", "proper noun", "phrase", "idiom",
        "abbreviation", "acronym", "initialism", "letter", "symbol",
        "suffix", "prefix", "infix", "counter", "classifier", "number",
        "contraction", "participle",
        NULL
    };
    if (n < 6) return NULL;
    if (line[0] != '=' || line[1] != '=' || line[2] != '=') return NULL;
    size_t i = 0;
    while (i < n && line[i] == '=') i++;
    size_t name_start = i;
    while (i < n && line[i] != '=') i++;
    size_t name_len = i - name_start;

    for (int k = 0; pos_list[k]; k++) {
        if (eq_ci(line + name_start, name_len, pos_list[k])) {
            return pos_lower[k];
        }
    }
    return NULL;
}

static const char *match_language(const char *line, size_t n, size_t *out_len) {
    if (n < 5) return NULL;
    if (line[0] != '=' || line[1] != '=' || line[2] == '=') return NULL;
    size_t i = 2;
    size_t name_start = i;
    while (i < n && line[i] != '=') i++;
    if (i + 1 >= n || line[i+1] != '=') return NULL;
    if (i + 2 < n && line[i+2] == '=') return NULL;
    *out_len = i - name_start;
    return line + name_start;
}

/* --- Main driver --- */

static int strip_wikitext(const char *src, size_t src_len, StrBuf *out) {
    int wrote_anything = 0;

    /* Buffered per-language state - we emit only when a section has content. */
    char current_lang[128] = "";
    size_t current_lang_len = 0;
    int lang_header_pending = 0;       /* we have a language but haven't emitted header */
    int wrote_def_in_current_lang = 0; /* did this lang section get at least one def? */
    const char *current_pos = NULL;

    size_t i = 0;
    while (i < src_len) {
        size_t line_start = i;
        while (i < src_len && src[i] != '\n') i++;
        size_t line_len = i - line_start;
        if (i < src_len) i++;

        const char *line = src + line_start;

        /* Language header */
        size_t lang_len = 0;
        const char *lang = match_language(line, line_len, &lang_len);
        if (lang) {
            /* Close out previous language with a blank line if it had content */
            if (wrote_def_in_current_lang) {
                sb_append_char(out, '\n');
            }
            current_lang_len = lang_len < sizeof(current_lang) - 1
                               ? lang_len : sizeof(current_lang) - 1;
            memcpy(current_lang, lang, current_lang_len);
            current_lang[current_lang_len] = '\0';
            lang_header_pending = 1;
            wrote_def_in_current_lang = 0;
            current_pos = NULL;
            continue;
        }

        /* POS header */
        const char *pos = match_pos(line, line_len);
        if (pos) {
            current_pos = pos;
            continue;
        }

        /* Definition lines: "#" but not "##", "#:", "#*", "#;" */
        if (line_len > 0 && line[0] == '#') {
            if (line_len >= 2 && (line[1] == '*' || line[1] == ':' ||
                                  line[1] == '#' || line[1] == ';')) {
                continue;
            }
            if (current_lang_len == 0) continue;  /* def with no language → skip */

            size_t def_start = 1;
            while (def_start < line_len &&
                   (line[def_start] == ' ' || line[def_start] == '\t')) def_start++;
            if (def_start >= line_len) continue;

            /* Clean into a scratch area at the end of `out`, then check triviality */
            size_t scratch_start = out->len;
            clean_line(line + def_start, line_len - def_start, out);
            trim_definition(out, scratch_start);

            size_t cleaned_len = out->len - scratch_start;
            if (is_trivial_definition(out->data + scratch_start, cleaned_len)) {
                /* Rollback - this definition was effectively empty */
                sb_truncate(out, scratch_start);
                continue;
            }

            /* Definition survived - but we appended directly to `out`, so now
             * we need to insert the language header + POS prefix BEFORE the
             * cleaned text. Easiest approach: stash the cleaned text, rewind,
             * write header/prefix, then write the stashed text back. */
            size_t stash_len = cleaned_len;
            char *stash = (char*)malloc(stash_len + 1);
            if (!stash) {
                /* OOM - just leave the def in place without prefixes */
                sb_append_char(out, '\n');
                wrote_def_in_current_lang = 1;
                wrote_anything = 1;
                continue;
            }
            memcpy(stash, out->data + scratch_start, stash_len);
            stash[stash_len] = '\0';
            sb_truncate(out, scratch_start);

            /* Emit lazy language header */
            if (lang_header_pending) {
                if (out->len > 0 && out->data[out->len-1] != '\n') sb_append_char(out, '\n');
                sb_append_cstr(out, "=== ");
                sb_append(out, current_lang, current_lang_len);
                sb_append_cstr(out, " ===\n");
                lang_header_pending = 0;
            }
            if (current_pos) {
                sb_append_cstr(out, current_pos);
                sb_append_cstr(out, ": ");
            }
            sb_append(out, stash, stash_len);
            sb_append_char(out, '\n');
            free(stash);

            wrote_def_in_current_lang = 1;
            wrote_anything = 1;
        }
    }

    return wrote_anything;
}

#endif /* WIKITEXT_H */