/**
 * http.ts - src/lib/http.ts
 *
 * Small fetch helpers. Two commands were each carrying an identical
 * "download this image with a timeout and a browser user-agent, return null on
 * anything unexpected" routine.
 */

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export interface FetchOpts {
    timeoutMs?: number;
    headers?: Record<string, string>;
    maxBytes?: number;
}

/** fetch() with a hard timeout, so a hung server can't wedge a command. */
export async function fetchWithTimeout(url: string, opts: FetchOpts = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        return await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": BROWSER_UA, ...(opts.headers ?? {}) },
        });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Download an image URL into a Buffer.
 * Returns null on any failure - a bad URL in a list of results is normal, not
 * an error worth throwing over.
 */
export async function fetchImageBuffer(url: string, opts: FetchOpts = {}): Promise<Buffer | null> {
    try {
        const res = await fetchWithTimeout(url, {
            ...opts,
            headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,*/*", ...(opts.headers ?? {}) },
        });
        if (!res.ok) return null;

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.startsWith("image/")) return null;

        const buf = Buffer.from(await res.arrayBuffer());
        const limit = opts.maxBytes ?? MAX_IMAGE_BYTES;
        if (buf.length === 0 || buf.length > limit) return null;
        return buf;
    } catch {
        return null;
    }
}
