// Flexible date parser that accepts any non-digit separators (/, -, ., space, etc.)
// Returns null if the input is not a valid real-world date.
//
// Supports two shapes:
//   - DD<sep>MM<sep>YYYY    e.g. "09/03/2005", "9-3-2005", "9.3.2005"
//   - DD<sep>MM             e.g. "09/03", "9-3"  (year is null => recurring yearly reminder)
//
// Validation: uses Date object roundtrip to catch impossible dates like 31/02.

export interface ParsedDate {
    day: number;
    month: number;       // 1–12 (human-readable, NOT 0-indexed)
    year: number | null; // null when user omits the year
}

export function parseFlexibleDate(input: string): ParsedDate | null {
    if (!input || typeof input !== "string") return null;

    // Split on any run of non-digit characters
    const parts = input.trim().split(/\D+/).filter(p => p.length > 0);

    if (parts.length !== 2 && parts.length !== 3) return null;

    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parts.length === 3 ? parseInt(parts[2], 10) : null;

    if (!Number.isFinite(day) || !Number.isFinite(month)) return null;
    if (year !== null && !Number.isFinite(year)) return null;

    // Cheap bounds check before the expensive Date roundtrip
    if (day < 1 || day > 31) return null;
    if (month < 1 || month > 12) return null;

    // If year was provided, validate it's a real date in that year
    if (year !== null) {
        if (year < 1900 || year > 2200) return null;
        const probe = new Date(year, month - 1, day);
        if (
            probe.getFullYear() !== year ||
            probe.getMonth() !== month - 1 ||
            probe.getDate() !== day
        ) return null;
    } else {
        // No year supplied - validate against a leap year so Feb 29 is allowed
        const probe = new Date(2000, month - 1, day);
        if (probe.getMonth() !== month - 1 || probe.getDate() !== day) return null;
    }

    return { day, month, year };
}

// Format a parsed date back into a canonical DD/MM display string
export function formatDate(d: ParsedDate): string {
    const dd = String(d.day).padStart(2, "0");
    const mm = String(d.month).padStart(2, "0");
    return d.year !== null ? `${dd}/${mm}/${d.year}` : `${dd}/${mm}`;
}

// "DD/MM" key used to match against today's date in the scheduler
export function toDayMonthKey(d: ParsedDate): string {
    const dd = String(d.day).padStart(2, "0");
    const mm = String(d.month).padStart(2, "0");
    return `${dd}/${mm}`;
}