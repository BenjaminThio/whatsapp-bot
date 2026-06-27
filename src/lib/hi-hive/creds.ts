/**
 * Internal helper — mirrors the Creds class from scanner.py.
 * Reads creds.json, attaches fixed AES key/IV and deviceId,
 * and also surfaces the UTAR web portal fields (utarStudentId,
 * utarEncryptedData) added in utar_attendance.py.
 * Not exported from index — consumed internally by the modules.
 */

import { Filter } from "firebase-admin/firestore";
import { Creds } from "../../commands/test.js";
import db from "../../firebase.js";

const COLLECTION: string = 'hi_hive';

export const AES_KEY   = process.env["AES_KEY"]   ?? "P10kn1jhagdge783";
export const AES_IV    = process.env["AES_IV"]    ?? "0000000000000000";
export const DEVICE_ID = process.env["DEVICE_ID"] ?? "05e97579dc0915df";

export async function addAnonymousCreds(creds: Creds)
{
  return await db.collection(COLLECTION).add(creds);
}

export async function loadCreds(userId: string): Promise<Creds | undefined>
{
  const docRef = db.collection(COLLECTION).doc(userId);
  const docSnap = await docRef.get();
  const credsInfo: Creds | undefined = docSnap.data() as Creds | undefined;

  return credsInfo;
}

export async function saveCreds(docId: string, creds: Creds): Promise<void>
{
  const docRef = db.collection(COLLECTION).doc(docId);

  await docRef.set(creds, { merge: true });
}

export async function exists(docId: string): Promise<boolean>
{
  const docRef = db.collection(COLLECTION).doc(docId);
  const docSnap = await docRef.get();

  return docSnap.exists;
}

export async function deleteCreds(docId: string): Promise<Creds | undefined>
{
  const snapshot = await db.collection(COLLECTION).get();
  const match = snapshot.docs.find(d => d.id === docId);

  if (match === undefined)
  {
    return undefined;
  }
  else
  {
    match.ref.delete();

    return match.data() as Creds;
  }
}

export async function getAnonymousDocIds(userId: string): Promise<string[]>
{
  const snapshot = await db.collection(COLLECTION)
    .where('ownerId', '==', userId)
    .get();

  return snapshot.docs.map(doc => doc.id);
}

export async function getRelatedDocIds(id: string): Promise<string[]>
{
  const snapshot = await db.collection(COLLECTION)
    .where(
      Filter.or(
        Filter.where("id", "==", id),
        Filter.where("email", "==", id)
      )
    ).get();

  return snapshot.docs.map(doc => doc.id);
}

export async function looseLoadCreds(id: string): Promise<Creds | undefined>
{
  if (await exists(id))
  {
    return loadCreds(id);
  }
  else
  {
    const docIds: string[] = await getRelatedDocIds(id);

    if (docIds.length > 0)
    {
        return looseLoadCreds(docIds[0]);
    }
    else
    {
        return undefined;
    }
  }
}

export async function getAllDocIds(): Promise<string[]>
{
  const snapshot = await db.collection(COLLECTION).get();

  return snapshot.docs.map(doc => doc.id);
}

export async function getAllDocs(): Promise<Record<string, Creds>>
{
  const snapshot = await db.collection(COLLECTION).get();
  const docs: Record<string, Creds> = {};

  snapshot.docs.forEach((doc) => {
    docs[doc.id] = doc.data() as Creds
  });

  return docs;
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