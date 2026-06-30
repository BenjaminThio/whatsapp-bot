// hi-hive student credentials, now backed by Postgres `hi_hive`.

import crypto from "crypto";
import { Creds } from "../../commands/test.js";
import sql from "../../db/index.js";

export const AES_KEY   = process.env["AES_KEY"]   ?? "P10kn1jhagdge783";
export const AES_IV    = process.env["AES_IV"]    ?? "0000000000000000";
export const DEVICE_ID = process.env["DEVICE_ID"] ?? "05e97579dc0915df";

// Random doc id for anonymous creds (Firestore used to auto-generate these).
function newDocId(): string {
  return crypto.randomBytes(12).toString("base64url");
}

// DB row => Creds object (drops nulls so the shape matches the old Firestore data)
function mapRow(r: any): Creds {
  const creds: Creds = {
    id:     r.student_id,
    email:  r.email,
    hidden: r.hidden,
  };
  if (r.owner_id !== null && r.owner_id !== undefined) creds.ownerId = r.owner_id;
  return creds;
}

/**
 * Add anonymous creds with an auto-generated doc id.
 * Returns an object with `.id` to mirror Firestore's DocumentReference.
 */
export async function addAnonymousCreds(creds: Creds): Promise<{ id: string }> {
  const docId = newDocId();
  await sql`
    INSERT INTO hi_hive (doc_id, student_id, email, hidden, owner_id, updated_at)
    VALUES (${docId}, ${creds.id}, ${creds.email}, ${creds.hidden ?? false},
            ${creds.ownerId ?? null}, now())
  `;
  return { id: docId };
}

// Load creds by exact doc id. Returns undefined if not found.
export async function loadCreds(userId: string): Promise<Creds | undefined> {
  const rows = await sql`SELECT * FROM hi_hive WHERE doc_id = ${userId} LIMIT 1`;
  return rows.length ? mapRow(rows[0]) : undefined;
}

// Upsert creds at a given doc id (Firestore set({merge:true}) semantics).
export async function saveCreds(docId: string, creds: Creds): Promise<void> {
  await sql`
    INSERT INTO hi_hive (doc_id, student_id, email, hidden, owner_id, updated_at)
    VALUES (${docId}, ${creds.id}, ${creds.email}, ${creds.hidden ?? false},
            ${creds.ownerId ?? null}, now())
    ON CONFLICT (doc_id) DO UPDATE SET
      student_id = EXCLUDED.student_id,
      email      = EXCLUDED.email,
      hidden     = EXCLUDED.hidden,
      owner_id   = COALESCE(EXCLUDED.owner_id, hi_hive.owner_id),  -- keep owner if not re-supplied
      updated_at = now()
  `;
}

// Does a doc with this id exist?
export async function exists(docId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM hi_hive WHERE doc_id = ${docId} LIMIT 1`;
  return rows.length > 0;
}

// Delete creds by doc id; returns the deleted Creds (or undefined if none).
export async function deleteCreds(docId: string): Promise<Creds | undefined> {
  const rows = await sql`
    DELETE FROM hi_hive WHERE doc_id = ${docId}
    RETURNING *
  `;
  return rows.length ? mapRow(rows[0]) : undefined;
}

// All anonymous doc ids owned by a given user.
export async function getAnonymousDocIds(userId: string): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM hi_hive WHERE owner_id = ${userId}
  `;
  return rows.map((r: any) => r.doc_id);
}

// Doc ids whose student_id OR email match the given value (was Filter.or).
export async function getRelatedDocIds(id: string): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM hi_hive
    WHERE student_id = ${id} OR email = ${id}
  `;
  return rows.map((r: any) => r.doc_id);
}

// Try exact doc id, else fall back to the first id/email match (recursive).
export async function looseLoadCreds(id: string): Promise<Creds | undefined> {
  if (await exists(id)) {
    return loadCreds(id);
  }
  const docIds = await getRelatedDocIds(id);
  if (docIds.length > 0) {
    return looseLoadCreds(docIds[0]);
  }
  return undefined;
}

// Every doc id in the collection.
export async function getAllDocIds(): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`SELECT doc_id FROM hi_hive`;
  return rows.map((r: any) => r.doc_id);
}

// Every doc keyed by id => Creds.
export async function getAllDocs(): Promise<Record<string, Creds>> {
  const rows = await sql`SELECT * FROM hi_hive`;
  const docs: Record<string, Creds> = {};
  for (const r of rows) docs[r.doc_id] = mapRow(r);
  return docs;
}