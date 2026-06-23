/**
 * decodeQr - mirrors the `d <qr>` command from scanner.py (offline, no network).
 *
 * What it does (exactly like scanner.py):
 *   1. Validates the QR separator and type
 *   2. AES-decrypts the payload using the key from creds.json
 *   3. Parses the decrypted string into typed fields (parse_decoded)
 *   4. Runs the offline expiry prediction (predict_expiry)
 *   5. Returns everything as structured data
 */
import { loadCreds, DEFAULT_CREDS_PATH } from "../hi-hive/creds.js";
import { aesDecrypt } from "./crypto.js";
import type { DecodeQrResult, DecodeQrError, DecodedQr, QrInfo } from "../hi-hive/types.js";

const QR_SEPARATOR   = ":*:";
const INFO_SEPARATOR = ":-:";
const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"];

// Public API

/**
 * Offline-decode a raw QR string. No network call is made.
 *
 * @param rawQr     - The raw QR string (e.g. "Q01:*:<encrypted_payload>")
 * @param credsPath - Path to creds.json (default: "creds.json")
 */
export function decodeQr(
    rawQr: string,
): DecodeQrResult | DecodeQrError {
    const creds = loadCreds(DEFAULT_CREDS_PATH);

    rawQr = rawQr.trim();

    // 1. Must contain the separator
    if (!rawQr.includes(QR_SEPARATOR)) {
        return { ok: false, error: "No ':*:' separator found - not a valid QR." };
    }

    // 2. Type must be recognised
    const sepIdx  = rawQr.indexOf(QR_SEPARATOR);
    const qrType  = rawQr.substring(0, sepIdx);
    const payload = rawQr.substring(sepIdx + QR_SEPARATOR.length);

    if (!VALID_QR_TYPES.includes(qrType)) {
        return { ok: false, error: `Type '${qrType}' not in [${VALID_QR_TYPES.join(", ")}].` };
    }

    // 3. AES-decrypt the payload
    const decrypted = aesDecrypt(payload, creds.aes_key, creds.aes_iv);
    if (decrypted === null) {
        return {
            ok: false,
            error: "Could not AES-decrypt the payload (wrong key, or payload isn't encrypted).",
        };
    }

    // 4. Parse the decrypted string into fields  (parse_decoded)
    const parsed = parseDecoded(decrypted);

    // 5. Predict expiry offline  (predict_expiry)
    const expiry = predictExpiry(parsed.info);

    const decoded: DecodedQr = {
        raw:     decrypted,
        type:    parsed.type,
        classId: parsed.classId,
        info:    parsed.info,
        expiry,
    };

    return { ok: true, decoded };
}

// Internal helpers (parse_decoded + predict_expiry from scanner.py)
function parseDecoded(decrypted: string): {
    type: string;
    classId: string | null;
    info: QrInfo;
} {
    const parts   = decrypted.split(QR_SEPARATOR);
    const type    = parts[0] ?? "";
    const classId = type && parts.length >= 5 ? (parts[4] ?? null) : null;

    let info: QrInfo = {};

    if (parts.length > 5) {
        const ip = parts[5].split(INFO_SEPARATOR);

        if (type === "Q01" || type === "Q02") {
            const keys = ["courseCode", "sessionType", "group", "datetime", "hours"] as const;
            keys.forEach((k, i) => { info[k] = ip[i] ?? ""; });
        } else if (type === "E01") {
            const keys = ["eventName", "from", "to", "venue"] as const;
            keys.forEach((k, i) => { info[k] = ip[i] ?? ""; });
        }
    }

    return { type, classId, info };
}

function predictExpiry(info: QrInfo): DecodedQr["expiry"] {
    const dtStr = info.datetime ?? info.from;
    const hrs   = info.hours;

    if (!dtStr) {
        return { verdict: "unknown", reason: "No datetime in QR to compare." };
    }

    const start = parseDt(dtStr);
    if (!start) {
        return { verdict: "unknown", reason: `Couldn't parse datetime '${dtStr}'.` };
    }

    const dur = parseFloat(hrs ?? "0") || 0;
    const end = new Date(start.getTime() + dur * 3_600_000);
    const now = new Date();

    const fmt = (d: Date) =>
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

    if (dur > 0) {
        if (now < start) {
            return {
                verdict: "too_early",
                reason: `Class starts at ${fmt(start)} (now ${fmt(now)}). Not open yet.`,
            };
        }
        if (now > end) {
            return {
                verdict: "expired",
                reason: `Class window ended at ${fmt(end)} (now ${fmt(now)}). Likely EXPIRED.`,
            };
        }
        return {
            verdict: "in_window",
            reason: `Within window ${p(start.getHours())}:${p(start.getMinutes())}–${p(end.getHours())}:${p(end.getMinutes())}. Likely VALID.`,
        };
    }

    const deltaSec = Math.abs((now.getTime() - start.getTime()) / 1000);

    if (deltaSec > 24 * 3600) {
        return {
            verdict: "expired",
            reason: `Class time ${fmt(start)} is ${(deltaSec / 3600).toFixed(1)}h from now. Likely EXPIRED.`,
        };
    }
    return {
        verdict: "in_window",
        reason: `Class time ${fmt(start)} is close to now. Possibly valid.`,
    };
}

function parseDt(s: string): Date | null {
    s = s.trim();
    // YYYY-MM-DD HH:MM[:SS]
    const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m1) return new Date(+m1[1], +m1[2]-1, +m1[3], +m1[4], +m1[5], +(m1[6]??0));
    // DD-MM-YYYY HH:MM
    const m2 = s.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/);
    if (m2) return new Date(+m2[3], +m2[2]-1, +m2[1], +m2[4], +m2[5]);
    // YYYY/MM/DD HH:MM
    const m3 = s.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
    if (m3) return new Date(+m3[1], +m3[2]-1, +m3[3], +m3[4], +m3[5]);
    return null;
}

function p(n: number): string { return String(n).padStart(2, "0"); }