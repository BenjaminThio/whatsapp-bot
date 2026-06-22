/**
 * refreshToken - mirrors the `r` command from scanner.py (do_login).
 *
 * What it does (exactly like scanner.py):
 *   1. Reads creds.json (needs userId, password, token, fcmToken)
 *   2. POSTs to /chat/api/preLogin/login with the same Android device body
 *   3. Validates responseCode === 1
 *   4. Updates sessionId + token in creds.json
 *   5. Returns the result
 *
 * NOTE (from scanner.py): The app allows only ONE active session per account.
 * Logging in here will sign out the phone app. The token usually stays the
 * same across logins; only the sessionId changes.
 */
import { loadCreds, saveCreds, DEFAULT_CREDS_PATH } from "./creds.js";
import type { RefreshTokenResult } from "./types.js";

const HTTP_HEADERS = {
  "Content-Type": "application/json;charset=utf-8",
  Accept:         "application/json, text/plain, */*",
  "User-Agent":   "okhttp/4.9.1",
};

// Public API

/**
 * Re-login to refresh the sessionId (and possibly the token).
 * Reads credentials from creds.json and saves updates back automatically.
 *
 * @param apiDomain - Base API domain (e.g. "https://your-api.example.com")
 * @param credsPath - Path to creds.json (default: "creds.json")
 */
export async function refreshToken(
  apiDomain: string,
): Promise<RefreshTokenResult> {
  const creds = loadCreds(DEFAULT_CREDS_PATH);

  if (!creds.password) {
    return { ok: false, message: "No stored password in creds.json - cannot auto-login." };
  }

  const endpoint = `${apiDomain}/chat/api/preLogin/login`;

  // Same request body the app sends (from scanner.py do_login)
  const body = {
    userId:      creds.userId,
    password:    creds.password,
    os:          "Android",
    token:       creds.fcmToken,
    lang:        "en",
    deviceId:    creds.deviceId,
    osVersion:   "16",
    deviceModel: "CPH2637",
    appVersion:  "2.3.1",
    appName:     "hi-hive",
    deviceType:  "Android",
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method:  "POST",
      headers: HTTP_HEADERS,
      body:    JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, message: `Login request failed: ${e}` };
  }

  if (res.status !== 200) {
    const snippet = (await res.text()).slice(0, 300);
    return { ok: false, message: `Login HTTP ${res.status}: ${snippet}` };
  }

  let full: Record<string, unknown>;
  try {
    full = await res.json() as Record<string, unknown>;
  } catch {
    return { ok: false, message: "Login response wasn't JSON." };
  }

  // Server puts responseCode at the top level or nested under .data (scanner.py line 487)
  const data = ("responseCode" in full ? full : (full["data"] as Record<string, unknown>)) ?? {};

  if (data["responseCode"] !== 1) {
    return {
      ok: false,
      message: `Login not accepted by server. responseCode: ${data["responseCode"]}`,
    };
  }

  const newSession = (data["sessionId"] as string | undefined) ?? creds.sessionId;
  const newToken   = (data["token"]     as string | undefined) ?? creds.token;
  const tokenDate  = res.headers.get("date") ?? new Date().toISOString();
  const tokenChanged = newToken !== creds.token;

  // Persist back to creds.json (exactly like creds.save() in scanner.py)
  creds.sessionId = newSession;
  creds.token     = newToken;
  creds.tokenDate = tokenDate;
  saveCreds(creds);

  return {
    ok: true,
    message: tokenChanged
      ? `Login successful. Token changed. New sessionId: ${newSession}`
      : `Login successful. Token unchanged. New sessionId: ${newSession}`,
    newSessionId:  newSession,
    newToken:      newToken,
    tokenChanged,
  };
}