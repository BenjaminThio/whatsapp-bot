/**
 * scanQr — mirrors scan_qr() from utar_attendance.py.
 *
 * Two-step POST flow (confirmed from QR_ClassAttendance_Scanner.html):
 *
 *   Step 1 — establish UTAR web session
 *     POST SCAN_URL  { encryptedData: utarToken }
 *     → server sets a session cookie
 *
 *   Step 2 — submit the QR scan
 *     POST SCAN_URL  { qrMessage: rawQr + ":*:" + lat + ":*:" + lon + ":*:0",
 *                      encryptedData: "null" }
 *     → HTML response; parse for success / error / token-expired keywords
 *
 * The `utarToken` is either:
 *   a) stored as `utarEncryptedData` in creds.json, or
 *   b) auto-generated from `utarStudentId` + `userId` (email) + current time
 *      via generateEncryptedData() — mirrors utar_attendance.py get_token()
 *
 * Env vars required:
 *   UTAR_SCAN_URL   — e.g. "https://www.hi-hive.com/UTAR/main.jsp"
 */

import { loadCreds, DEFAULT_CREDS_PATH, AES_KEY, AES_IV } from "./creds.js";
import { decodeQr } from "../old-hi-hive/decode-qr.js"; 
import crypto from "crypto";
import type { ScanQrResult, ScanStatus, DecodedQr } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const QR_SEPARATOR   = ":*:";
const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"];

const UA_BROWSER = {
  "User-Agent":   "Mozilla/5.0 (Linux; Android 16; CPH2637) AppleWebKit/537.36 " +
                  "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Content-Type": "application/x-www-form-urlencoded",
  "Origin":       "https://www.hi-hive.com",
  "Referer":      "https://portal.utar.edu.my/stuIntranet/default.jsp",
};

// keyword lists mirrored from utar_attendance.py
const SUCCESS_PATTERNS = [
  "attendance is recorded", "attendance is taken",
  "recorded on", "taken on", "successfully", "your attendance",
];
const ERROR_PATTERNS = [
  "wrong datetime", "already", "expired", "invalid",
  "error", "failed", "not found", "incorrect",
];
const TOKEN_EXPIRED_PATTERNS = [
  "login", "session expired", "please login", "unauthorized",
];

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ScanQrOptions {
  /** Override UTAR_SCAN_URL env var */
  scanUrl?: string;
  /** Path to creds.json. Default: next to this file */
  credsPath?: string;
  /** GPS coords appended to the qrMessage (optional) */
  coords?: { lat: string; lon: string };
}

/**
 * Submit a QR scan to mark UTAR attendance via the web portal.
 * Reads the UTAR token automatically from creds.json, auto-generating
 * it from utarStudentId + email if no stored token is found.
 *
 * @param rawQr   - Raw QR string e.g. "Q01:*:<encrypted_payload>"
 * @param options - Optional overrides
 */
export async function scanQr(
  rawQr: string,
  options: ScanQrOptions = {}
): Promise<ScanQrResult> {
  const scanUrl   = options.scanUrl ?? process.env["UTAR_SCAN_URL"] ?? "";
  const credsPath = options.credsPath ?? DEFAULT_CREDS_PATH;
  const lat       = options.coords?.lat ?? "";
  const lon       = options.coords?.lon ?? "";

  if (!scanUrl) {
    return fail("network_error", "UTAR_SCAN_URL is not set. Pass scanUrl in options or set the env var.");
  }

  // ── Offline pre-check (expiry prediction) ────────────────────────────────
  rawQr = rawQr.trim();

  const sepIdx = rawQr.indexOf(QR_SEPARATOR);
  const qrType = sepIdx >= 0 ? rawQr.substring(0, sepIdx) : rawQr;

  if (!VALID_QR_TYPES.includes(qrType)) {
    return fail("invalid_qr", `Invalid QR type '${qrType}'. Expected one of: ${VALID_QR_TYPES.join(", ")}.`);
  }

  let expiry: DecodedQr["expiry"] | null = null;
  let courseCode: string | null = null;
  const decodeResult = decodeQr(rawQr);
  if (decodeResult.ok) {
    expiry     = decodeResult.decoded.expiry;
    courseCode = decodeResult.decoded.info.courseCode ?? null;
  }

  // ── Resolve UTAR token ────────────────────────────────────────────────────
  const creds = loadCreds(credsPath);
  let utarToken: string;

  if (creds.utarEncryptedData) {
    utarToken = creds.utarEncryptedData;
  } else if (creds.utarStudentId && creds.userId) {
    // auto-generate from studentId + email + current datetime
    // mirrors generate_encrypted_data() in utar_attendance.py
    utarToken = generateEncryptedData(creds.utarStudentId, creds.userId);
  } else {
    return fail(
      "auth_error",
      "No UTAR token found. Add utarEncryptedData or utarStudentId to creds.json.",
      courseCode, expiry
    );
  }

  // ── Step 1: establish session (POST encryptedData=token) ──────────────────
  let cookies: string;
  try {
    const r = await fetch(scanUrl, {
      method:  "POST",
      headers: UA_BROWSER,
      body:    new URLSearchParams({ encryptedData: utarToken }),
      redirect: "follow",
    });
    // grab Set-Cookie header(s) to carry into step 2
    cookies = r.headers.get("set-cookie") ?? "";
    if (!r.ok && r.status !== 302) {
      return fail("auth_error", `Session establishment failed with HTTP ${r.status}.`, courseCode, expiry);
    }
  } catch (e) {
    return fail("network_error", `Session establishment failed: ${e}`, courseCode, expiry);
  }

  // ── Step 2: submit QR scan ────────────────────────────────────────────────
  // message format from QR_ClassAttendance_Scanner.html line 419:
  //   encryptedText + ":*:" + latitude + ":*:" + longitude + ":*:0"
  const qrMessage = `${rawQr}${QR_SEPARATOR}${lat}${QR_SEPARATOR}${lon}${QR_SEPARATOR}0`;

  let htmlBody: string;
  try {
    const headers: Record<string, string> = {
      ...UA_BROWSER,
      "Referer": scanUrl,
    };
    if (cookies) headers["Cookie"] = cookies;

    const r = await fetch(scanUrl, {
      method:  "POST",
      headers,
      body:    new URLSearchParams({ qrMessage, encryptedData: "null" }),
      redirect: "follow",
    });
    htmlBody = await r.text();
  } catch (e) {
    return fail("network_error", `QR submission failed: ${e}`, courseCode, expiry);
  }

  // ── Parse HTML response (mirrors keyword detection in utar_attendance.py) ─
  const plainText = stripHtml(htmlBody);
  return interpretHtml(plainText, courseCode, expiry);
}

// ─── Token generation (mirrors generate_encrypted_data) ───────────────────────

/**
 * Auto-generate the UTAR encryptedData token from studentId + email + now.
 * Format: AES-128-CBC(studentId + "FFF" + email + "FFF" + datetime + "FFF")
 * Mirrors generate_encrypted_data() in utar_attendance.py exactly.
 */
export function generateEncryptedData(studentId: string, email: string, loginTime?: string): string {
  const ts        = loginTime ?? new Date().toISOString()
    .replace("T", " ").replace(/\.\d+Z$/, "");          // "YYYY-MM-DD HH:MM:SS"
  const plaintext = `${studentId}FFF${email}FFF${ts}FFF`;

  const keyBuf    = Buffer.from(AES_KEY, "utf-8");
  const ivBuf     = Buffer.from(AES_IV,  "utf-8");
  const cipher    = crypto.createCipheriv("aes-128-cbc", keyBuf, ivBuf);

  // PKCS7 pad to 16-byte block manually (same as Python's Crypto.Util.Padding.pad)
  const data      = Buffer.from(plaintext, "ascii");
  const padLen    = 16 - (data.length % 16);
  const padded    = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);

  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Strip HTML tags, collapse whitespace — mirrors BeautifulSoup get_text() */
function stripHtml(html: string): string {
  // remove script/style blocks entirely
  let t = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // remove remaining tags
  t = t.replace(/<[^>]+>/g, " ");
  // collapse whitespace
  return t.replace(/\s+/g, " ").trim();
}

/**
 * Classify the stripped server text using the same keyword lists as
 * utar_attendance.py, and return a structured ScanQrResult.
 */
function interpretHtml(
  text: string,
  courseCode: string | null,
  expiry: DecodedQr["expiry"] | null
): ScanQrResult {
  if (!text) {
    return fail("unreadable", "Empty response from server.", courseCode, expiry);
  }

  const tl = text.toLowerCase();

  if (SUCCESS_PATTERNS.some(p => tl.includes(p))) {
    return {
      ok: true,
      status: "marked",
      message: "✅ Attendance recorded!",
      courseCode,
      expiry,
      serverResponse: text.slice(0, 500),
    };
  }

  if (TOKEN_EXPIRED_PATTERNS.some(p => tl.includes(p))) {
    return {
      ok: false,
      status: "token_expired",
      message:
        "Session expired. Update utarEncryptedData in creds.json, " +
        "or set utarStudentId so a new token can be auto-generated.",
      courseCode: null,
      expiry,
      serverResponse: text.slice(0, 500),
    };
  }

  if (ERROR_PATTERNS.some(p => tl.includes(p))) {
    return {
      ok: false,
      status: "rejected",
      message: "Server rejected the scan — wrong datetime / already taken / not enrolled.",
      courseCode: null,
      expiry,
      serverResponse: text.slice(0, 500),
    };
  }

  if (tl.includes("scan hive")) {
    return {
      ok: false,
      status: "scanner_page",
      message: "Server returned the scanner page. QR window may have passed, or the class hasn't started yet.",
      courseCode: null,
      expiry,
      serverResponse: text.slice(0, 500),
    };
  }

  return {
    ok: false,
    status: "unknown_flag",
    message: "Result unclear — check serverResponse.",
    courseCode: null,
    expiry,
    serverResponse: text.slice(0, 500),
  };
}

function fail(
  status: ScanStatus,
  message: string,
  courseCode: string | null = null,
  expiry: DecodedQr["expiry"] | null = null
): ScanQrResult {
  return { ok: false, status, message, courseCode, expiry, serverResponse: null };
}