/**
 * Internal helper — mirrors the Creds class from scanner.py.
 * Reads creds.json, attaches fixed AES key/IV and deviceId,
 * and also surfaces the UTAR web portal fields (utarStudentId,
 * utarEncryptedData) added in utar_attendance.py.
 * Not exported from index — consumed internally by the modules.
 */

import { StudentInfo } from "../../commands/test.js";
import db from "../../firebase.js";

export const AES_KEY   = process.env["AES_KEY"]   ?? "P10kn1jhagdge783";
export const AES_IV    = process.env["AES_IV"]    ?? "0000000000000000";
export const DEVICE_ID = process.env["DEVICE_ID"] ?? "05e97579dc0915df";

export async function loadCreds(userId: string): Promise<StudentInfo | undefined>
{
  const docRef = db.collection('hi_hive').doc(userId);
  const docSnap = await docRef.get();
  const credsInfo: StudentInfo | undefined = docSnap.data() as StudentInfo | undefined;

  return credsInfo;
}

export async function saveCreds(userId: string, studentInfo: StudentInfo): Promise<void>
{
  const docRef = db.collection('hi_hive').doc(userId);
  await docRef.set(studentInfo, { merge: true });
}

/*
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { CredsData } from "./types.js";

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
    // hi-hive fields
    userId:    raw.userId    ?? "",
    password:  raw.password  ?? null,
    token:     raw.token     ?? "",
    sessionId: raw.sessionId ?? "",
    fcmToken:  raw.fcmToken  ?? "",
    path:      credsPath,
    aes_key:   AES_KEY,
    aes_iv:    AES_IV,
    deviceId:  DEVICE_ID,
    tokenDate: raw.tokenDate ?? "",
    // UTAR web portal fields
    utarStudentId:      raw.utarStudentId      ?? null,
    utarEncryptedData:  raw.utarEncryptedData  ?? null,
  };
}

export function saveCreds(creds: CredsData): void {
  const toWrite = {
    userId:             creds.userId,
    password:           creds.password,
    token:              creds.token,
    sessionId:          creds.sessionId,
    fcmToken:           creds.fcmToken,
    tokenDate:          creds.tokenDate,
    utarStudentId:      creds.utarStudentId,
    utarEncryptedData:  creds.utarEncryptedData,
  };
  const tmp = creds.path + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), "utf-8");
  fs.renameSync(tmp, creds.path);
}
*/