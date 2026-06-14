/*
bing-images.ts — self-contained Bing image scraper. No dependencies.

Bing is much friendlier to scrape than DuckDuckGo:
  - No vqd token dance (DDG's main fragility) — just one request.
  - Results come from the lightweight async endpoint:
      https://www.bing.com/images/async?q=<query>&first=<offset>&mmasync=1
  - Each result is an <a class="iusc" m="<json>"> element whose `m` attribute
    is a JSON blob: { murl: fullImage, turl: thumbnail, purl: sourcePage, t: title }
  - Far more forgiving rate limits than DDG.

We keep the SAME exported shape as the old DDG module so the command code
doesn't change: searchImages(query, { limit, safeSearch }) → ImageResult[].

If this ever breaks, the likely culprit is the `m="..."` attribute format or
the iusc class name changing — both are in extractResults() below.
*/

export interface ImageResult {
    title: string;
    image: string;        // full-size image URL (murl)
    thumbnail: string;    // thumbnail URL (turl)
    url: string;          // source page (purl)
    width: number;
    height: number;
    source: string;       // host of the source page
}

export type SafeSearch = "strict" | "moderate" | "off";

/*
Bing safe-search is set via the ADLT cookie / adlt query value:
  strict = "strict", moderate = "moderate"(demote), off = "off"
*/
const BING_ADLT: Record<SafeSearch, string> = {
    strict: "strict",
    moderate: "demote",
    off: "off",
};

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];
function pickUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const REQUEST_TIMEOUT_MS = 12_000;

/*
Light throttle. Bing is forgiving, but spacing requests is still polite and
avoids any burst detection. Much lower than DDG's required 3.5s.
*/
const MIN_REQUEST_GAP_MS = 800;
let lastRequestAt = 0;
let throttleChain: Promise<void> = Promise.resolve();
function throttle(): Promise<void> {
    const mine = throttleChain.then(async () => {
        const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastRequestAt = Date.now();
    });
    throttleChain = mine.catch(() => {});
    return mine;
}

// Short result cache so repeated identical queries don't re-hit Bing.
interface CacheEntry { at: number; results: ImageResult[]; }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
function cacheKey(q: string, safe: SafeSearch) { return `${safe}::${q.toLowerCase().trim()}`; }
function cacheGet(k: string): ImageResult[] | null {
    const e = cache.get(k);
    if (!e) return null;
    if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(k); return null; }
    return e.results;
}
function cacheSet(k: string, results: ImageResult[]): void {
    if (cache.size >= CACHE_MAX) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) cache.delete(oldest[0]);
    }
    cache.set(k, { at: Date.now(), results });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Decode HTML entities that appear inside the m="" attribute JSON.
function decodeEntities(s: string): string {
    return s
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

// Pull the host out of a URL for the "source" field.
function hostOf(u: string): string {
    try { return new URL(u).hostname.replace(/^www\./, ""); }
    catch { return ""; }
}

/*
Extract image results from Bing's async-endpoint HTML.
Each result lives in an <a class="iusc" ... m="<json>"> element.
*/
function extractResults(html: string): ImageResult[] {
    const out: ImageResult[] = [];

    /*
    Match the m="..." attribute on iusc anchors. The attribute value is
    HTML-escaped JSON. We grab everything up to the closing quote.
    Using a global regex over the whole document is simpler and more robust
    than a full DOM parse for this single attribute.
    */
    const re = /class="iusc"[^>]*\sm="([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = re.exec(html)) !== null) {
        const rawJson = decodeEntities(match[1]);
        try {
            const data = JSON.parse(rawJson);
            if (!data.murl) continue;
            out.push({
                title: data.t ?? "",
                image: data.murl,
                thumbnail: data.turl ?? "",
                url: data.purl ?? "",
                width: typeof data.mw === "number" ? data.mw : 0,
                height: typeof data.mh === "number" ? data.mh : 0,
                source: hostOf(data.purl ?? ""),
            });
        } catch {
            // Malformed JSON for this entry — skip it
            continue;
        }
    }

    return out;
}

/*
Search Bing images. Same signature as the old DDG module so the command code
is unchanged.
*/
export async function searchImages(
    query: string,
    options: { limit?: number; safeSearch?: SafeSearch } = {},
): Promise<ImageResult[]> {
    const limit = options.limit ?? 20;
    const safe = options.safeSearch ?? "moderate";

    const key = cacheKey(query, safe);
    const cached = cacheGet(key);
    if (cached) {
        console.log(`🔍 [cache hit] "${query}" (${safe})`);
        return cached.slice(0, limit);
    }

    const userAgent = pickUserAgent();
    const adlt = BING_ADLT[safe];

    /*
    The async endpoint returns just the image result markup, no page chrome.
    count + first control how many results / the offset.
    */
    const params = new URLSearchParams({
        q: query,
        first: "1",
        count: String(Math.max(limit, 35)),  // ask for a healthy batch
        mmasync: "1",
        adlt,
    });
    const url = `https://www.bing.com/images/async?${params.toString()}`;

    await throttle();
    const res = await fetchWithTimeout(url, {
        method: "GET",
        headers: {
            "User-Agent": userAgent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`,
            // Safe-search is also enforced via the ADLT cookie.
            "Cookie": `SRCHHPGUSR=ADLT=${adlt}`,
        },
    });

    if (res.status === 429) {
        throw new Error("Bing is rate-limiting us (429). Wait a moment and retry.");
    }
    if (!res.ok) {
        throw new Error(`Bing image search failed: HTTP ${res.status}`);
    }

    const html = await res.text();
    const results = extractResults(html);

    if (results.length === 0 && !html.includes("iusc")) {
        // No iusc markers at all — Bing may have changed their markup
        throw new Error("No image markers found — Bing may have changed their HTML format. Check bing-images.ts:extractResults.");
    }

    cacheSet(key, results);
    return results.slice(0, limit);
}