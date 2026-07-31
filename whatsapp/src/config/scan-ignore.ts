/**
 * scan-ignore.ts - src/config/scan-ignore.ts
 *
 * The auto-scanner inspects every image that lands in a chat. Sometimes you want
 * to share a QR without it being submitted - a screenshot for a friend, a QR
 * from a class you're not in, a test image.
 *
 * Put the directive anywhere in the image caption:
 *
 *     !ignore              -> caption is just the directive
 *     /ignore              -> any configured prefix works
 *     look at this !ignore -> anywhere in the caption is fine
 *
 * Override the words with SCAN_IGNORE_WORDS="ignore,skip,noscan" in .env.
 */

import { splitPrefix } from "./prefixes.js";

const DEFAULT_WORDS = ["ignore", "noscan", "skip"];

function readWords(): string[] {
    const raw = process.env["SCAN_IGNORE_WORDS"];
    if (!raw) return DEFAULT_WORDS;
    const parsed = raw.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_WORDS;
}

const IGNORE_WORDS = readWords();

/** The words that suppress a scan, for help text. */
export function ignoreWords(): string[] {
    return [...IGNORE_WORDS];
}

/**
 * Does this caption ask the scanner to leave the image alone?
 *
 * The directive must be a prefixed word on its own - "!ignore", not "ignore" -
 * so an ordinary sentence mentioning the word can never suppress a real scan.
 */
export function isScanIgnored(caption: string | null | undefined): boolean {
    if (!caption) return false;

    for (const token of caption.split(/\s+/)) {
        const split = splitPrefix(token);
        if (!split) continue;
        // Trim trailing punctuation so "!ignore." and "!ignore," still count
        const word = split.rest.toLowerCase().replace(/[.,;:!?]+$/, "");
        if (IGNORE_WORDS.includes(word)) return true;
    }
    return false;
}
