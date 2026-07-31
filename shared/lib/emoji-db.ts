/**
 * emoji-db.ts - shared/lib/emoji-db.ts
 *
 * Emoji lookup over a 60 MB JSONL file, without reading 60 MB.
 *
 * Both bots had a bad strategy here, in opposite directions:
 *
 *   Telegram  streamed the entire file and substring-matched every line, on
 *             every command. 11 ms for an entry near the top, 107 ms for one
 *             near the bottom, and it did the whole thing again next time.
 *   WhatsApp  parsed all 5,225 entries into Maps at first use: 383 ms of
 *             startup stall and 66 MB of JS heap held for the life of the
 *             process - on a phone.
 *
 * Almost all of that 60 MB is the `designs` array: per-platform artwork history,
 * dozens of image URLs per emoji, needed only for the one entry being shown.
 * The searchable part - character, name, shortcode, aliases - is a few hundred
 * KB.
 *
 * So: scan the file once to build an index of {keys -> byte offset, length},
 * cache that index next to the data, and read only the bytes of the entry
 * actually asked for. Lookup becomes one positioned read.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { dataFile } from "../assets/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmojiTimeline { date: string; image_url: string; version: string }
export interface EmojiDesign { title: string; description: string; timelines: EmojiTimeline[] }

export interface EmojiEntry {
    character: string;
    name: string;
    description: string[];
    code: string;
    render_quality: number;
    version: number;
    category: { main: string | null; sub: string | null };
    alias?: string[];
    variant?: boolean;
    alert?: string;
    designs?: EmojiDesign[];
}

/** The searchable part, held in memory. The heavy `designs` stay on disk. */
interface IndexRecord {
    character: string;
    name: string;
    code: string;
    alias: string[];
    /** Byte offset of the line in the JSONL. */
    offset: number;
    /** Byte length of the line. */
    length: number;
}

interface IndexFile {
    version: number;
    /** Size and mtime of the source, so a changed dataset invalidates the index. */
    sourceSize: number;
    sourceMtimeMs: number;
    records: IndexRecord[];
}

const INDEX_VERSION = 1;

const DATA_PATH = dataFile("emoji.jsonl");
const INDEX_PATH = dataFile("emoji.index.json");

// ── Index construction ────────────────────────────────────────────────────────

/**
 * Read the JSONL once and record where each entry lives.
 *
 * Byte offsets, not line numbers: emoji characters are multi-byte, so a line
 * index would still require decoding the whole file to find a given line.
 *
 * The scan works on raw bytes rather than readline. readline hands back the
 * line with its terminator stripped, so reconstructing the offset means
 * guessing whether that was "\n" or "\r\n" - and guessing wrong drifts the
 * offset by one byte per line, which silently poisons every entry after the
 * first. This counts the bytes it actually consumed instead, so LF, CRLF and a
 * mixture all index correctly.
 */
async function buildIndex(): Promise<IndexFile> {
    const stat = statSync(DATA_PATH);
    const records: IndexRecord[] = [];

    const NEWLINE = 0x0a;
    let pending: Buffer = Buffer.alloc(0);
    let lineStart = 0;          // absolute offset of the line being accumulated
    let consumed = 0;           // absolute offset of the end of `pending`

    const addLine = (bytes: Buffer, offset: number): void => {
        const text = bytes.toString("utf-8").trim();
        if (!text) return;
        try {
            const e = JSON.parse(text) as EmojiEntry;
            records.push({
                character: e.character ?? "",
                name: e.name ?? "",
                code: e.code ?? "",
                alias: e.alias ?? [],
                offset,
                // Stored length covers the raw bytes, trailing \r included -
                // JSON.parse tolerates it after trim()
                length: bytes.length,
            });
        } catch {
            // One malformed line must not cost the whole index
        }
    };

    for await (const chunk of createReadStream(DATA_PATH)) {
        pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
        consumed += (chunk as Buffer).length;

        let searchFrom = 0;
        let nl: number;

        while ((nl = pending.indexOf(NEWLINE, searchFrom)) !== -1) {
            addLine(pending.subarray(searchFrom, nl), lineStart);
            lineStart += nl - searchFrom + 1;      // + the newline itself
            searchFrom = nl + 1;
        }

        pending = pending.subarray(searchFrom);
    }

    // A final line with no trailing newline
    if (pending.length > 0) addLine(pending, lineStart);

    void consumed;

    return {
        version: INDEX_VERSION,
        sourceSize: stat.size,
        sourceMtimeMs: stat.mtimeMs,
        records,
    };
}

/** Is a cached index still valid for the current data file? */
function indexMatches(idx: IndexFile, stat: { size: number; mtimeMs: number }): boolean {
    return idx.version === INDEX_VERSION
        && idx.sourceSize === stat.size
        // mtime can drift by a millisecond across filesystems; compare loosely
        && Math.abs(idx.sourceMtimeMs - stat.mtimeMs) < 1000;
}

// ── Loading ───────────────────────────────────────────────────────────────────

interface Loaded {
    records: IndexRecord[];
    byChar: Map<string, IndexRecord>;
    byCode: Map<string, IndexRecord>;
    byName: Map<string, IndexRecord>;
    /** True when offsets were verified to address real lines. */
    offsetsValid: boolean;
}

let loading: Promise<Loaded> | null = null;

async function load(): Promise<Loaded> {
    loading ??= (async () => {
        if (!existsSync(DATA_PATH)) {
            throw new Error(`Emoji dataset not found at ${DATA_PATH}`);
        }
        const stat = statSync(DATA_PATH);

        let index: IndexFile | null = null;

        if (existsSync(INDEX_PATH)) {
            try {
                const cached = JSON.parse(await readFile(INDEX_PATH, "utf-8")) as IndexFile;
                if (indexMatches(cached, stat)) index = cached;
                else console.log("📖 Emoji index is stale - rebuilding.");
            } catch {
                console.warn("📖 Emoji index unreadable - rebuilding.");
            }
        }

        if (index === null) {
            const started = performance.now();
            index = await buildIndex();
            try {
                await writeFile(INDEX_PATH, JSON.stringify(index), "utf-8");
            } catch (err) {
                // A read-only install still works, it just rebuilds each boot
                console.warn("📖 Could not cache the emoji index:", err instanceof Error ? err.message : err);
            }
            console.log(
                `📖 Built emoji index: ${index.records.length} entries in ${(performance.now() - started).toFixed(0)} ms`
            );
        }

        const byChar = new Map<string, IndexRecord>();
        const byCode = new Map<string, IndexRecord>();
        const byName = new Map<string, IndexRecord>();

        for (const r of index.records) {
            if (r.character) byChar.set(r.character, r);
            if (r.code) byCode.set(r.code.toLowerCase(), r);
            if (r.name) byName.set(r.name.toLowerCase(), r);
            for (const a of r.alias) byCode.set(a.toLowerCase(), r);
        }

        /*
        Sanity-check one offset before trusting the whole index. A CRLF file, or
        one edited after the index was written, would give offsets that point
        mid-line and every lookup would fail with a confusing parse error.
        */
        let offsetsValid = true;
        const probe = index.records[0];
        if (probe) {
            try {
                const entry = await readAt(probe.offset, probe.length);
                offsetsValid = entry !== null && entry.character === probe.character;
            } catch {
                offsetsValid = false;
            }
        }
        if (!offsetsValid) {
            console.warn("📖 Emoji index offsets look wrong - falling back to a full scan per lookup.");
        }

        return { records: index.records, byChar, byCode, byName, offsetsValid };
    })();

    return loading;
}

// ── Reading one entry ─────────────────────────────────────────────────────────

/*
One shared read handle, opened on first use and kept.

Opening a 60 MB file per lookup is a syscall and a fresh file object every time
for no benefit - the handle is read-only and positioned per read, so it is safe
to share across concurrent lookups.
*/
let handlePromise: Promise<Awaited<ReturnType<typeof open>>> | null = null;

function dataHandle() {
    handlePromise ??= open(DATA_PATH, "r");
    return handlePromise;
}

/** Read and parse exactly one line, by byte offset. */
async function readAt(offset: number, length: number): Promise<EmojiEntry | null> {
    try {
        const handle = await dataHandle();
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        const text = buf.subarray(0, bytesRead).toString("utf-8").trim();
        if (!text) return null;
        return JSON.parse(text) as EmojiEntry;
    } catch {
        return null;
    }
}

/** Release the shared handle. Only needed by tests and on shutdown. */
export async function closeEmojiDb(): Promise<void> {
    if (handlePromise === null) return;
    const h = await handlePromise.catch(() => null);
    handlePromise = null;
    await h?.close().catch(() => { });
}

/** Last-resort linear scan, used only when the offsets can't be trusted. */
async function scanFor(match: (r: EmojiEntry) => boolean): Promise<EmojiEntry | null> {
    const rl = createInterface({
        input: createReadStream(DATA_PATH, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });
    try {
        for await (const line of rl) {
            const t = line.trim();
            if (!t) continue;
            try {
                const e = JSON.parse(t) as EmojiEntry;
                if (match(e)) return e;
            } catch { /* skip bad line */ }
        }
    } finally {
        rl.close();
    }
    return null;
}

async function fetchEntry(record: IndexRecord, loaded: Loaded): Promise<EmojiEntry | null> {
    if (loaded.offsetsValid) {
        const direct = await readAt(record.offset, record.length);
        if (direct) return direct;
    }
    return scanFor(e => e.character === record.character);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface EmojiMatch {
    entry: EmojiEntry;
    /** How it was found, for the "closest match" note in the reply. */
    method: "character" | "shortcode" | "name" | "fuzzy";
}

export interface EmojiSuggestion {
    character: string;
    name: string;
    code: string;
}

export type EmojiLookup =
    | { kind: "match"; match: EmojiMatch }
    | { kind: "suggestions"; suggestions: EmojiSuggestion[] }
    | { kind: "none" };

/**
 * Find an emoji by character, shortcode, alias or name, falling back to a fuzzy
 * search over names.
 */
export async function lookupEmoji(query: string): Promise<EmojiLookup> {
    const loaded = await load();

    const q = query.trim();
    if (!q) return { kind: "none" };

    const exact = async (r: IndexRecord | undefined, method: EmojiMatch["method"]): Promise<EmojiLookup | null> => {
        if (!r) return null;
        const entry = await fetchEntry(r, loaded);
        return entry ? { kind: "match", match: { entry, method } } : null;
    };

    const byChar = await exact(loaded.byChar.get(q), "character");
    if (byChar) return byChar;

    const lower = q.toLowerCase();
    const shortcodeForm = lower.startsWith(":") && lower.endsWith(":") ? lower : `:${lower}:`;

    const byCode = await exact(loaded.byCode.get(shortcodeForm) ?? loaded.byCode.get(lower), "shortcode");
    if (byCode) return byCode;

    const byName = await exact(loaded.byName.get(lower), "name");
    if (byName) return byName;

    // Fuzzy: scored over the in-memory names only, no file access
    const tokens = lower.split(/\s+/).filter(t => t.length >= 2);
    const scored: { r: IndexRecord; score: number }[] = [];

    for (const r of loaded.records) {
        const name = r.name.toLowerCase();
        let score = 0;

        if (name.includes(lower)) {
            score += 100;
            if (name.startsWith(lower)) score += 50;
        }
        for (const t of tokens) if (name.includes(t)) score += 10;
        if (r.code.toLowerCase().includes(lower)) score += 30;
        for (const a of r.alias) if (a.toLowerCase().includes(lower)) score += 20;

        if (score > 0) scored.push({ r, score });
    }

    if (scored.length === 0) return { kind: "none" };

    scored.sort((a, b) => b.score - a.score);

    const top = scored[0]!;
    const runnerUp = scored[1];

    // Confident enough to answer directly rather than offer a list
    if (top.score >= 100 && (!runnerUp || top.score >= runnerUp.score * 2)) {
        const entry = await fetchEntry(top.r, loaded);
        if (entry) return { kind: "match", match: { entry, method: "fuzzy" } };
    }

    return {
        kind: "suggestions",
        suggestions: scored.slice(0, 6).map(s => ({
            character: s.r.character,
            name: s.r.name,
            code: s.r.code,
        })),
    };
}

/** Preferred artwork platforms, best first. */
const PREFERRED_DESIGNS = [
    "Microsoft Teams",
    "WhatsApp",
    "Apple",
    "Google Noto Color Emoji",
    "Twitter",
];

export interface PickedImage {
    url: string;
    platformTitle: string;
    version: string;
    date: string;
}

/** Pick the best available artwork for an entry, newest version of it. */
export function pickImage(entry: EmojiEntry): PickedImage | null {
    if (!entry.designs || entry.designs.length === 0) return null;

    const newest = (d: EmojiDesign): PickedImage | null => {
        const latest = d.timelines[d.timelines.length - 1];
        if (!latest?.image_url) return null;
        return { url: latest.image_url, platformTitle: d.title, version: latest.version, date: latest.date };
    };

    for (const pref of PREFERRED_DESIGNS) {
        const design = entry.designs.find(d => d.title.includes(pref));
        if (design) {
            const picked = newest(design);
            if (picked) return picked;
        }
    }

    return newest(entry.designs[0]!);
}

/** Animated artwork, when the platform ships it. */
export function pickAnimated(entry: EmojiEntry): PickedImage | null {
    if (!entry.designs) return null;
    const design = entry.designs.find(d => d.title.includes("Microsoft Teams (3D Animated)"));
    if (!design) return null;
    const latest = design.timelines[design.timelines.length - 1];
    if (!latest?.image_url) return null;
    return { url: latest.image_url, platformTitle: design.title, version: latest.version, date: latest.date };
}

/** Force an index rebuild. Only needed after replacing the dataset by hand. */
export function resetEmojiIndex(): void {
    loading = null;
}

export { DATA_PATH as EMOJI_DATA_PATH, INDEX_PATH as EMOJI_INDEX_PATH };
