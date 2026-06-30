/*
datetime.ts - flexible datetime parser for !schedule.

Accepts (separators between date parts can be / - . or space):
  "25/12/2026 14:30"        DD/MM/YYYY + time
  "25-12-2026 14:30:45"     seconds optional
  "2026-12-25 14:30"        ISO year-first (auto-detected: first part has 4 digits)
  "25/12 14:30"             no year => nearest future occurrence
  "14:30"  /  "2:30pm" / "2pm"   time only => today, or tomorrow if already past
  "tomorrow 9am"  /  "today 18:00"
  "in 10m" / "in 2h 30m" / "in 1h30m" / "in 90s"   relative

parseDateTime(tokens) consumes leading tokens and returns the target time
plus how many tokens it consumed, so the caller can treat the remainder
as the activity text. Validation uses Date roundtrips (rejects 31/02 etc).
*/

export interface ParsedDateTime {
    epochMs: number;
    consumed: number;   // number of leading tokens consumed
}

interface TimeParts { h: number; m: number; s: number; }

// Parse "14:30", "14:30:45", "2pm", "2:30pm", "2.30pm". Null if not a time.
function parseTimeToken(tok: string): TimeParts | null {
    let t = tok.toLowerCase();
    let pm = false, am = false;
    if (t.endsWith("pm") || t.endsWith("p.m")) { pm = true; t = t.slice(0, -2); }
    else if (t.endsWith("am") || t.endsWith("a.m")) { am = true; t = t.slice(0, -2); }
    if (!t) return null;

    const parts = t.split(/[:.]/).filter(p => p.length > 0);
    if (parts.length < 1 || parts.length > 3) return null;
    for (const p of parts) if (!/^\d+$/.test(p)) return null;

    let h = parseInt(parts[0], 10);
    const m = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
    const s = parts.length >= 3 ? parseInt(parts[2], 10) : 0;

    /*
    Bare numbers like "14" are only a time if am/pm present or it has a colon -
    otherwise "25" in "25/12" would parse as a time. parts.length 1 without
    am/pm is rejected.
    */
    if (parts.length === 1 && !pm && !am) return null;

    if (pm && h >= 1 && h <= 11) h += 12;
    if (am && h === 12) h = 0;

    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    return { h, m, s };
}

// Parse a date token: "25/12/2026", "2026-12-25", "25.12", etc.
function parseDateToken(tok: string, now: Date): { y: number; mo: number; d: number; hadYear: boolean } | null {
    const parts = tok.split(/[\/\-.]/).filter(p => p.length > 0);
    if (parts.length !== 2 && parts.length !== 3) return null;
    for (const p of parts) if (!/^\d+$/.test(p)) return null;

    let y: number, mo: number, d: number, hadYear = true;
    if (parts.length === 3) {
        if (parts[0].length === 4) {           // YYYY-MM-DD
            y = parseInt(parts[0], 10); mo = parseInt(parts[1], 10); d = parseInt(parts[2], 10);
        } else {                                // DD/MM/YYYY
            d = parseInt(parts[0], 10); mo = parseInt(parts[1], 10); y = parseInt(parts[2], 10);
            if (y < 100) y += 2000;             // "26" => 2026
        }
    } else {                                    // DD/MM, no year
        d = parseInt(parts[0], 10); mo = parseInt(parts[1], 10);
        y = now.getFullYear();
        hadYear = false;
    }

    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const probe = new Date(y, mo - 1, d);
    if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
    return { y, mo, d, hadYear };
}

// Parse duration tokens after "in": "10m", "2h", "1h30m", "90s", "2h 30m"
function parseDurationTokens(tokens: string[]): { ms: number; consumed: number } | null {
    let totalMs = 0;
    let consumed = 0;
    for (const tok of tokens) {
        const t = tok.toLowerCase();
        // Composite like "1h30m" or simple "10m" - scan number+unit pairs
        let i = 0, tokMs = 0, valid = t.length > 0;
        while (i < t.length) {
            let j = i;
            while (j < t.length && t[j] >= '0' && t[j] <= '9') j++;
            if (j === i) { valid = false; break; }
            const n = parseInt(t.slice(i, j), 10);
            // unit: h, m, s, hr, min, sec
            let unit = "";
            let k = j;
            while (k < t.length && /[a-z]/.test(t[k])) { unit += t[k]; k++; }
            if (unit === "h" || unit === "hr" || unit === "hrs") tokMs += n * 3_600_000;
            else if (unit === "m" || unit === "min" || unit === "mins") tokMs += n * 60_000;
            else if (unit === "s" || unit === "sec" || unit === "secs") tokMs += n * 1_000;
            else { valid = false; break; }
            i = k;
        }
        if (!valid || tokMs === 0) break;
        totalMs += tokMs;
        consumed++;
    }
    if (consumed === 0 || totalMs === 0) return null;
    return { ms: totalMs, consumed };
}

/*
Parse the leading tokens of a !schedule invocation into a target datetime.
Returns null if no valid datetime is found at the start.
*/
export function parseDateTime(tokens: string[], now: Date = new Date()): ParsedDateTime | null {
    if (tokens.length === 0) return null;
    const t0 = tokens[0].toLowerCase();

    // Relative: "in <duration...>"
    if (t0 === "in" && tokens.length >= 2) {
        const dur = parseDurationTokens(tokens.slice(1));
        if (dur) return { epochMs: now.getTime() + dur.ms, consumed: 1 + dur.consumed };
        return null;
    }

    // "today"/"tomorrow" [time]
    if (t0 === "today" || t0 === "tomorrow") {
        const base = new Date(now);
        if (t0 === "tomorrow") base.setDate(base.getDate() + 1);
        let time: TimeParts = { h: 9, m: 0, s: 0 };   // default 9 AM
        let consumed = 1;
        if (tokens.length >= 2) {
            const tp = parseTimeToken(tokens[1]);
            if (tp) { time = tp; consumed = 2; }
        }
        const target = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
                                time.h, time.m, time.s);
        return { epochMs: target.getTime(), consumed };
    }

    // Date [time]
    const dateParsed = parseDateToken(tokens[0], now);
    if (dateParsed) {
        let time: TimeParts = { h: 9, m: 0, s: 0 }; // date-only defaults to 9 AM
        let consumed = 1;
        if (tokens.length >= 2) {
            const tp = parseTimeToken(tokens[1]);
            if (tp) { time = tp; consumed = 2; }
        }
        let target = new Date(dateParsed.y, dateParsed.mo - 1, dateParsed.d,
                              time.h, time.m, time.s);
        // No year given and the moment already passed => roll to next year
        if (!dateParsed.hadYear && target.getTime() <= now.getTime()) {
            target = new Date(dateParsed.y + 1, dateParsed.mo - 1, dateParsed.d,
                              time.h, time.m, time.s);
        }
        return { epochMs: target.getTime(), consumed };
    }

    // Time only => today, or tomorrow if already past
    const timeParsed = parseTimeToken(tokens[0]);
    if (timeParsed) {
        let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                              timeParsed.h, timeParsed.m, timeParsed.s);
        if (target.getTime() <= now.getTime()) {
            target = new Date(target.getTime() + 24 * 3_600_000);
        }
        return { epochMs: target.getTime(), consumed: 1 };
    }

    return null;
}

// Human-readable rendering of a target time, e.g. "Wed, 25/12/2026 14:30:00".
export function formatDateTime(epochMs: number): string {
    const d = new Date(epochMs);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${days[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}