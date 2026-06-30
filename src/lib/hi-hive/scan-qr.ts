import { loadCreds, AES_KEY, AES_IV } from "./creds.js";
import { decodeQr } from "../old-hi-hive/decode-qr.js";
import crypto from "crypto";
import type { ScanQrResult, ScanStatus, DecodedQr } from "./types.js";

// Constants
const QR_SEPARATOR   = ":*:";
const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"];

// UTAR Sungai Long campus GPS - required by the server
const UTAR_LAT = "3.0543";
const UTAR_LON = "101.7297";

const UA_BROWSER: Record<string, string> = {
  "User-Agent":   "Mozilla/5.0 (Linux; Android 16; CPH2637) AppleWebKit/537.36 " +
                  "(KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
  "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Content-Type": "application/x-www-form-urlencoded",
  "Origin":       "https://www.hi-hive.com",
  "Referer":      "https://portal.utar.edu.my/stuIntranet/default.jsp",
};

// Public API
export interface ScanQrOptions {
  // Override UTAR_SCAN_URL env var
  scanUrl?: string;
  // Path to creds.json. Default: next to this file
  credsPath?: string;
  // GPS coords to include in qrMessage. Defaults to UTAR Sungai Long.
  coords?: { lat: string; lon: string };
}

/**
 * Submit a QR scan to mark UTAR attendance via the web portal.
 *
 * @param rawQr   - Raw QR string e.g. "Q01:*:<encrypted_payload>"
 * @param options - Optional overrides
*/
export async function scanQr(
  docId: string,
  rawQr: string,
  options: ScanQrOptions = {}
): Promise<ScanQrResult | undefined> {
  const scanUrl   = options.scanUrl   ?? process.env["UTAR_SCAN_URL"] ?? "";
  const lat       = options.coords?.lat ?? UTAR_LAT;
  const lon       = options.coords?.lon ?? UTAR_LON;

  if (!scanUrl) {
    return fail("network_error",
      "UTAR_SCAN_URL is not set. Pass scanUrl in options or set the env var.");
  }

  // Validate QR type
  rawQr = rawQr.trim();
  const qrType = rawQr.substring(0, rawQr.indexOf(QR_SEPARATOR));
  if (!VALID_QR_TYPES.includes(qrType)) {
    return fail("invalid_qr",
      `Invalid QR type '${qrType}'. Expected one of: ${VALID_QR_TYPES.join(", ")}.`);
  }

  // Offline expiry pre-check
  let expiry:     DecodedQr["expiry"] | null = null;
  let courseCode: string | null = null;
  const decodeResult = decodeQr(docId, rawQr);
  if (decodeResult.ok) {
    expiry     = decodeResult.decoded.expiry;
    courseCode = decodeResult.decoded.info.courseCode ?? null;
  }

  // Resolve UTAR token
  // Always generate a fresh token in real-time from id + email + current datetime.
  // Formula: AES-128-CBC( studentId + "FFF" + email + "FFF" + datetime + "FFF" )
  // A stale stored token causes "Invalid QR code" - fresh is always correct.
  const creds = await loadCreds(docId);

  if (creds === undefined) return undefined;

  if (!creds.id || !creds.email) {
    return fail("auth_error",
      "Missing id or email in Firestore hi_hive document. Both are required to generate a token.",
      courseCode, expiry);
  }

  const utarToken = generateEncryptedData(creds.id, creds.email);
  console.log(`[scanQr] Generated fresh token for ${creds.id} / ${creds.email}`);

  // establish session
  let cookies = "";
  try {
    const r = await fetch(scanUrl, {
      method:   "POST",
      headers:  UA_BROWSER,
      body:     new URLSearchParams({ encryptedData: utarToken }),
      redirect: "follow",
    });
    cookies = r.headers.get("set-cookie") ?? "";
    if (!r.ok && r.status !== 302) {
      return fail("auth_error",
        `Session establishment failed with HTTP ${r.status}.`, courseCode, expiry);
    }
  } catch (e) {
    return fail("network_error", `Session establishment failed: ${e}`, courseCode, expiry);
  }

  // submit QR scan
  // qrMessage format (from QR_ClassAttendance_Scanner.html line 419):
  //   rawQr + ":*:" + lat + ":*:" + lon + ":*:0"
  // GPS is REQUIRED - empty coords cause the server to silently return the scanner page
  const qrMessage = `${rawQr}${QR_SEPARATOR}${lat}${QR_SEPARATOR}${lon}${QR_SEPARATOR}0`;

  const step2Headers: Record<string, string> = {
    ...UA_BROWSER,
    "Referer": scanUrl,
  };
  if (cookies) step2Headers["Cookie"] = cookies;

  let htmlBody: string;
  try {
    // Sends the REAL token (not "null") - confirmed from new utar_attendance.py
    const r = await fetch(scanUrl, {
      method:   "POST",
      headers:  step2Headers,
      body:     new URLSearchParams({ qrMessage, encryptedData: utarToken }),
      redirect: "follow",
    });
    htmlBody = await r.text();
  } catch (e) {
    return fail("network_error", `QR submission failed: ${e}`, courseCode, expiry);
  }

  // Parse response: extract handleCallback('...') from JS
  // The server embeds results in a JS callback rather than plain HTML:
  //   handleCallback('QR code has expired...')        => expired
  //   handleCallback('Q01:*:...:*:...:*:0')           => success (flag=0)
  //   handleCallback('Exception: Internal server..')  => server error
  const cbMatch = htmlBody.match(/handleCallback\('([\s\S]*?)'\)/);
  const cbData  = cbMatch ? cbMatch[1].replace(/\\'/g, "'") : "";
  const cbLower = cbData.toLowerCase();

  if (cbData) {
    // Extract server result image URL (Tick.png = success, Cross.png = failure)
    const imageUrl = extractImageUrl(cbData);

    // Convert <br/> => newlines first, then strip tags for clean keyword matching
    const cbLines = cbData
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split("\n").map((l: string) => l.trim()).filter(Boolean).join("\n");
    const cbLower = cbLines.toLowerCase();

    // Log always so issues are visible in terminal
    console.log(`[scanQr] cbData (first 400): ${cbData.slice(0, 400)}`);

    if (cbLower.includes("exception") || cbLower.includes("internal server error")) {
      return {
        ok: false, status: "auth_error",
        message:
          "Server error - the session may not be carrying student identity. " +
          "Ensure id + email are set in your Firestore hi_hive document.",
        courseCode: null, expiry, imageUrl, serverResponse: cbLines.slice(0, 500),
      };
    }

    // All known success phrasings - "has been recorded" is the real server text
    if (cbLower.includes("attendance is taken") ||
        cbLower.includes("attendance is recorded") ||
        cbLower.includes("attendance has been recorded")) {

      // Extract per-line key:value fields embedded after the success message
      const extract = (key: string) =>
        cbLines.match(new RegExp("^" + key + "\\s*:\\s*(.+)$", "im"))?.[1]?.trim() ?? "";

      const cc   = extract("Course Code");
      const type = extract("Type");
      const grp  = extract("Group");
      const dt   = extract("Class Date/Time");
      const hrs  = extract("Class Hour");

      if (cc && !courseCode) courseCode = cc;

      const details = cc
        ? `Course: ${cc}  Type: ${type}  Group: ${grp}  Time: ${dt}  Hours: ${hrs}`
        : "";

      return {
        ok: true, status: "marked",
        message: details ? `Attendance recorded!\n${details}` : "Attendance recorded!",
        courseCode: courseCode || cc || null,
        expiry, imageUrl, serverResponse: cbLines.slice(0, 500),
      };
    }

    if (cbLower.includes("already")) {
      return {
        ok: true, status: "marked",
        message: "Attendance already recorded for this class.",
        courseCode, expiry, imageUrl, serverResponse: cbLines.slice(0, 500),
      };
    }

    if (cbLower.includes("expired") ||
        cbLower.includes("inform your lecturer") ||
        cbLower.includes("wrong datetime")) {
      return {
        ok: false, status: "rejected",
        message: `QR expired or wrong datetime. ${cbLines.slice(0, 200)}`,
        courseCode: null, expiry, imageUrl, serverResponse: cbLines.slice(0, 500),
      };
    }

    // Any other non-QR server message
    if (!cbData.startsWith("Q01") && !cbData.startsWith("E01")) {
      return {
        ok: false, status: "rejected",
        message: `Server says: ${cbLines.slice(0, 200)}`,
        courseCode: null, expiry, imageUrl, serverResponse: cbLines.slice(0, 500),
      };
    }
  }

  // Fallback: check stripped HTML text
  const stripped = htmlBody
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const strLower = stripped.toLowerCase();

  if (strLower.includes("scan hive") && stripped.length < 500) {
    return {
      ok: false, status: "scanner_page",
      message:
        "Server returned the scanner page. " +
        "GPS coordinates may be wrong, or the QR window has passed.",
      courseCode: null, expiry, imageUrl: null, serverResponse: stripped.slice(0, 500),
    };
  }

  return {
    ok: false, status: "unknown_flag",
    message: "Result unclear - check serverResponse.",
    courseCode: null, expiry, imageUrl: null, serverResponse: stripped.slice(0, 500),
  };
}

// Token generation (mirrors generate_encrypted_data)

/**
 * Auto-generate the UTAR encryptedData token from studentId + email + now.
 * Format: AES-128-CBC( studentId + "FFF" + email + "FFF" + datetime + "FFF" )
 * Mirrors generate_encrypted_data() in utar_attendance.py exactly.
 */
export function generateEncryptedData(
  studentId: string,
  email: string,
  loginTime?: string
): string {
  const ts = loginTime
    ?? new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const plaintext = `${studentId}FFF${email}FFF${ts}FFF`;

  const keyBuf = Buffer.from(AES_KEY, "utf-8");
  const ivBuf  = Buffer.from(AES_IV,  "utf-8");
  const cipher = crypto.createCipheriv("aes-128-cbc", keyBuf, ivBuf);

  const data   = Buffer.from(plaintext, "ascii");
  const padLen = 16 - (data.length % 16);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);

  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

export function decryptData(encryptedBase64: string): { studentId: string; email: string; loginTime: string } {
  // Recreate the Key and IV buffers exactly as done in encryption
  const keyBuf = Buffer.from(AES_KEY, "utf-8");
  const ivBuf  = Buffer.from(AES_IV,  "utf-8");

  // Initialize the Decipher
  const decipher = crypto.createDecipheriv("aes-128-cbc", keyBuf, ivBuf);

  // Decrypt the Base64 string back into a Buffer
  const decryptedBuf = Buffer.concat([
    decipher.update(encryptedBase64, "base64"),
    decipher.final()
  ]);

  // Remove the manual padding that was added during encryption
  // The last byte of the buffer contains the number of padding bytes added.
  const padLen = decryptedBuf[decryptedBuf.length - 1];
  const unpaddedBuf = decryptedBuf.subarray(0, decryptedBuf.length - padLen);

  // Convert the unpadded Buffer back to an ASCII string
  const plaintext = unpaddedBuf.toString("ascii");

  // Split the string by your 'FFF' delimiter
  const parts = plaintext.split("FFF");

  return {
    studentId: parts[0] || "",
    email: parts[1] || "",
    loginTime: parts[2] || ""
  };
}

// Helpers
// Extract the first <img src="..."> URL from the server's callback HTML, if any.
function extractImageUrl(cbData: string): string | null {
  const m = cbData.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function fail(
  status: ScanStatus,
  message: string,
  courseCode: string | null = null,
  expiry: DecodedQr["expiry"] | null = null
): ScanQrResult {
  return { ok: false, status, message, courseCode, expiry, imageUrl: null, serverResponse: null };
}