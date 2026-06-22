/**
 * Internal helper - mirrors the Creds class from scanner.py.
 * Reads creds.json and attaches the fixed AES key/IV and deviceId.
 * Not exported from index - consumed internally by the 4 modules.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CredsData } from "./types.js";

export const AES_KEY   = process.env.AES_KEY;
export const AES_IV    = process.env.AES_IV;
export const DEVICE_ID = process.env.DEVICE_ID;

/*
  Resolve creds.json relative to THIS file (src/lib/hi-hive/creds.ts),
  so it always points to src/lib/hi-hive/creds.json regardless of the
  working directory the process was started from.
*/
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

export const DEFAULT_CREDS_PATH = path.resolve(__dirname, "creds.json");

export function loadCreds(credsPath = DEFAULT_CREDS_PATH): CredsData {
  if (!fs.existsSync(credsPath)) {
    throw new Error(
      `creds.json not found at "${credsPath}". ` +
      `Run the import step first to generate it from RKStorage.db.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
  return {
    userId:    raw.userId    ?? "",
    password:  raw.password  ?? null,
    token:     raw.token     ?? "",
    sessionId: raw.sessionId ?? "",
    fcmToken:  raw.fcmToken  ?? "",
    path:      credsPath,
    aes_key:   AES_KEY  ?? "",
    aes_iv:    AES_IV   ?? "",
    deviceId:  DEVICE_ID ?? "",
    tokenDate: "",
  };
}

export function saveCreds(creds: CredsData): void {
  const toWrite = {
    userId:    creds.userId,
    password:  creds.password,
    token:     creds.token,
    sessionId: creds.sessionId,
    fcmToken:  creds.fcmToken,
  };
  const tmp = creds.path + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), "utf-8");
  fs.renameSync(tmp, creds.path);
}