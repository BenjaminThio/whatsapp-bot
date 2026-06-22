/**
 * scanQr - mirrors the full `live_scan` flow from scanner.py.
 *
 * What it does (exactly like scanner.py live_scan):
 *   1. Strips and validates the QR type
 *   2. Tries to AES-decrypt the payload and runs the offline expiry pre-check
 *   3. Builds the scan URL using SCAN_API_TEMPLATE
 *   4. GET request to the API (same okhttp UA)
 *   5. On 401/403 => calls do_login once and retries (exactly one retry)
 *   6. Passes the response body through interpret_response
 *      (tries plaintext first, then AES-decrypt; reads flag at seg[6])
 *   7. Returns a structured result - ok/status/message/courseCode/expiry/serverResponse
 *
 * Usage:
 *   import { scanQr } from "./scanQr.js";
 *   const result = await scanQr("Q01:*:<encrypted_payload>");
 */

import { loadCreds, DEFAULT_CREDS_PATH } from "./creds.js";
import { aesDecrypt } from "./crypto.js";
import { decodeQr } from "./decode-qr.js";
import { refreshToken } from "./refresh-token.js";
import type { ScanQrResult, ScanStatus, DecodedQr } from "./types.js";

const QR_SEPARATOR  = ":*:";
const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"];

const SCAN_HEADERS = { "User-Agent": "okhttp/4.9.1" };

// Public API

export interface ScanQrOptions {
  /** Base API domain, e.g. "https://your-api.example.com". Falls back to process.env.API_DOMAIN. */
  apiDomain?: string;
  /** Path to creds.json. Default: "creds.json" */
  credsPath?: string;
  /**
   * For LQR type only: GPS coordinates to override the payload with.
   * If omitted for LQR, the original encrypted payload is sent as-is.
   */
  lqrCoords?: { lat: string; lng: string };
}

/**
 * Submit a QR scan to mark attendance. Reads everything from creds.json automatically.
 *
 * @param rawQr   - The raw QR string exactly as scanned (e.g. "Q01:*:<encrypted>")
 * @param options - Optional overrides (apiDomain, credsPath, lqrCoords)
 */
export async function scanQr(
  rawQr: string
): Promise<ScanQrResult> {
  const apiDomain = process.env["ATTENDANCE_QR_SCAN_API_DOMAIN"] ?? "";
  const credsPath = DEFAULT_CREDS_PATH;

  if (!apiDomain) {
    return fail("network_error", "apiDomain is not set. Pass it in options or set API_DOMAIN env var.");
  }

  const creds = loadCreds(credsPath);

  rawQr = rawQr.trim();

  // Step 1: validate QR type (same check as live_scan)
  const sepIdx  = rawQr.indexOf(QR_SEPARATOR);
  const qrType  = sepIdx >= 0 ? rawQr.substring(0, sepIdx) : rawQr;
  let   payload = sepIdx >= 0 ? rawQr.substring(sepIdx + QR_SEPARATOR.length) : "";

  if (!VALID_QR_TYPES.includes(qrType)) {
    return fail("invalid_qr", `Invalid QR type '${qrType}'. Expected one of: ${VALID_QR_TYPES.join(", ")}.`);
  }

  // Step 2: offline decode + expiry pre-check (same as live_scan)
  let expiry: DecodedQr["expiry"] | null = null;
  let scannedCourse: string | null = null;

  const decodeResult = decodeQr(rawQr);
  if (decodeResult.ok) {
    expiry        = decodeResult.decoded.expiry;
    scannedCourse = decodeResult.decoded.info.courseCode ?? null;
  }

  // Step 3: LQR coordinate override (same as live_scan)
  /*
  const lqrCoords: { lat: number, lng: number } = { lat: 0, lng: 0 };
  if (qrType === "LQR" && lqrCoords) {
    const { lat, lng } = lqrCoords;
    if (lat && lng) {
      payload = `${lat}${QR_SEPARATOR}${lng}`;
    }
  }
  */

  // Step 4 & 5: fire the GET request, retry once on 401/403
  const scanUrl = buildScanUrl(apiDomain, qrType, creds.userId, creds.token, payload);

  let httpStatus: number;
  let body: string;

  try {
    ({ httpStatus, body } = await doGet(scanUrl));
  } catch (e) {
    return fail("network_error", `Network error: ${e}`, null, expiry);
  }

  if (httpStatus === 401 || httpStatus === 403) {
    // mirrors: "Token rejected at transport level - refreshing and retrying once..."
    const loginResult = await refreshToken(apiDomain);
    if (!loginResult.ok) {
      return fail("auth_error", `Token rejected (${httpStatus}) and re-login failed: ${loginResult.message}`, null, expiry);
    }
    // reload creds so we have the new token
    const refreshedCreds = loadCreds(credsPath);
    const retryUrl = buildScanUrl(apiDomain, qrType, refreshedCreds.userId, refreshedCreds.token, payload);
    try {
      ({ httpStatus, body } = await doGet(retryUrl));
    } catch (e) {
      return fail("network_error", `Network error on retry: ${e}`, null, expiry);
    }
  }

  // Step 6: interpret the server response (mirrors interpret_response)
  return interpretResponse(body, creds.aes_key, creds.aes_iv, scannedCourse, expiry);
}

// Internal helpers

function buildScanUrl(
  apiDomain: string,
  qrType: string,
  userId: string,
  token: string,
  payload: string
): string {
  const template = `${apiDomain}/QR?type=#TYPE#&uid=#USERID#&token=#TOKEN#&data=#ENCRYPTED#`;
  return template
    .replace("#TYPE#",      qrType)
    .replace("#USERID#",    encodeURIComponent(userId))
    .replace("#TOKEN#",     token)
    .replace("#ENCRYPTED#", payload);
}

async function doGet(url: string): Promise<{ httpStatus: number; body: string }> {
  const res  = await fetch(url, { headers: SCAN_HEADERS });
  const body = (await res.text()).trim();
  return { httpStatus: res.status, body };
}

/*
  Mirrors interpret_response from scanner.py.
  Tries the body as plaintext first (contains QR_SEPARATOR), then AES-decrypts.
  Reads the verdict flag from seg[6] (or last segment).
*/
function interpretResponse(
  body: string,
  aesKey: string,
  aesIv: string,
  scannedCourse: string | null,
  expiry: DecodedQr["expiry"] | null
): ScanQrResult {
  if (!body) {
    return {
      ok: false,
      status: "unreadable",
      message: "Empty body - server accepted but nothing to display.",
      courseCode: null,
      expiry,
      serverResponse: null,
    };
  }

  // try plaintext first, then AES
  let decoded: string | null = null;
  if (body.includes(QR_SEPARATOR)) {
    decoded = body;
  } else {
    decoded = aesDecrypt(body, aesKey, aesIv);
  }

  if (!decoded) {
    return {
      ok: false,
      status: "unreadable",
      message: "Could not interpret response (not plaintext, not AES-decryptable).",
      courseCode: null,
      expiry,
      serverResponse: body,
    };
  }

  const seg   = decoded.split(QR_SEPARATOR);
  const flag  = seg.length > 6 ? seg[6].trim() : (seg[seg.length - 1]?.trim() ?? "");
  const msg5  = seg[5] ?? "";

  // extract course code from msg5 if present (e.g. "UECS2194-1")
  let courseCode: string | null = scannedCourse;
  if (!courseCode && msg5.includes("-") && msg5.length < 12) {
    courseCode = msg5.split("-")[0].trim() || null;
  }

  if (flag === "0") {
    return {
      ok: true,
      status: "marked",
      message: msg5 ? `Attendance marked! Info: ${msg5}` : "Attendance marked!",
      courseCode,
      expiry,
      serverResponse: decoded,
    };
  }

  if (flag === "1") {
    return {
      ok: false,
      status: "rejected",
      message: msg5
        ? `Not marked - server: "${msg5}" (e.g. wrong datetime / already taken / not enrolled)`
        : "Not marked - server rejected without a message.",
      courseCode: null,
      expiry,
      serverResponse: decoded,
    };
  }

  return {
    ok: false,
    status: "unknown_flag",
    message: `Unrecognised server flag '${flag}'. Full response: ${decoded}`,
    courseCode: null,
    expiry,
    serverResponse: decoded,
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