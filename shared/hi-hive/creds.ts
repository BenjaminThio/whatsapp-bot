/**
 * creds.ts — hi-hive student credentials, now backed by Postgres `hi_hive`.
 * Was: Firestore collection "hi_hive".
 *
 * Two kinds of rows (same as before):
 *   • Personal creds — doc_id = the user's jid/lid, owner_id NULL
 *   • Anonymous creds — doc_id = random id, owner_id = the creator's jid
 *
 * Every former Firestore function is preserved with identical signatures so
 * test.ts and the hi-hive modules need zero changes.
 */

import { Creds } from "./types.js";
import sql from "../db/index.js";

export const AES_KEY   = process.env["AES_KEY"]   ?? "P10kn1jhagdge783";
export const AES_IV    = process.env["AES_IV"]    ?? "0000000000000000";
export const DEVICE_ID = process.env["DEVICE_ID"] ?? "05e97579dc0915df";

/*
Anonymous creds are keyed by the STUDENT ID (e.g. "2504142") rather than a random
string. Two benefits:
  • The same student can never be added twice — the primary key enforces it.
  • `!test del 2504142` works with an id you can actually read and type, which
    fixes the old "pasted the random doc id but it said not found" problem.
*/

// DB row → Creds object (drops nulls so the shape matches the old Firestore data)
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
const ALL_DOCS_TTL_MS = Number(process.env["CREDS_CACHE_MS"] ?? 30_000);

let allDocsCache: { at: number; docs: Record<string, Creds> } | null = null;

/** Drop the cached table. Called by every write in this module. */
export function invalidateCredsCache(): void {
  allDocsCache = null;
}

export async function addAnonymousCreds(creds: Creds): Promise<{ id: string }> {
  const docId = creds.id.trim();            // student id IS the doc id
  await sql`
    INSERT INTO hi_hive (doc_id, student_id, email, hidden, owner_id, updated_at)
    VALUES (${docId}, ${creds.id}, ${creds.email}, ${creds.hidden ?? false},
            ${creds.ownerId ?? null}, now())
    ON CONFLICT (doc_id) DO UPDATE SET
      student_id = EXCLUDED.student_id,
      email      = EXCLUDED.email,
      hidden     = EXCLUDED.hidden,
      owner_id   = COALESCE(EXCLUDED.owner_id, hi_hive.owner_id),
      updated_at = now()
  `;
  invalidateCredsCache();
  return { id: docId };
}

/** Load creds by exact doc id. Returns undefined if not found. */
export async function loadCreds(userId: string): Promise<Creds | undefined> {
  const rows = await sql`SELECT * FROM hi_hive WHERE doc_id = ${userId} LIMIT 1`;
  return rows.length ? mapRow(rows[0]) : undefined;
}

/** Upsert creds at a given doc id (Firestore set({merge:true}) semantics). */
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
  invalidateCredsCache();
}

/** Does a doc with this id exist? */
export async function exists(docId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM hi_hive WHERE doc_id = ${docId} LIMIT 1`;
  return rows.length > 0;
}

/** Delete creds by doc id; returns the deleted Creds (or undefined if none). */
export async function deleteCreds(docId: string): Promise<Creds | undefined> {
  const key = docId.trim();

  /*
  Dropped up front rather than on each return: this function deletes through
  several different paths and only some of them succeed, so invalidating once
  here covers all of them. A needless invalidation costs one query.
  */
  invalidateCredsCache();

  // 1. Exact doc id
  let rows = await sql`DELETE FROM hi_hive WHERE doc_id = ${key} RETURNING *`;
  if (rows.length) return mapRow(rows[0]);

  // 2. By student id or email (handles "I pasted the student id" / legacy rows)
  rows = await sql`
    DELETE FROM hi_hive
    WHERE student_id = ${key} OR email = ${key}
    RETURNING *
  `;
  if (rows.length) return mapRow(rows[0]);

  // 3. Unique prefix — covers old random doc ids shown truncated in a list
  rows = await sql`SELECT doc_id FROM hi_hive WHERE doc_id LIKE ${key + "%"}`;
  if (rows.length === 1) {
    const hit = await sql`DELETE FROM hi_hive WHERE doc_id = ${rows[0].doc_id} RETURNING *`;
    if (hit.length) return mapRow(hit[0]);
  }

  return undefined;   // genuinely not found (or ambiguous prefix)
}

/** All anonymous doc ids owned by a given user. */
/**
 * Turn an anonymous doc into a personal one.
 *
 * `owner_id` is what makes a doc anonymous: it names whoever added it on
 * someone else's behalf, and getAnonymousDocIds() lists by it. Once the student
 * themselves is bound to the doc it is no longer held for them by a third
 * party, so the owner is cleared and it drops out of the adder's anonymous
 * list - the same row, now theirs.
 *
 * Returns the previous owner, or undefined if it was already personal.
 */
export async function claimDoc(docId: string): Promise<string | undefined> {
  // Read the old owner first. A subquery inside RETURNING on the row being
  // updated is snapshot-dependent and reads as a trick; two plain statements
  // in one transaction say what they mean.
  const prev = await sql.begin(async trx => {
    const before = await trx<{ owner_id: string | null }[]>`
      SELECT owner_id FROM hi_hive WHERE doc_id = ${docId} FOR UPDATE
    `;
    if (before.length === 0) return null;
    await trx`UPDATE hi_hive SET owner_id = NULL, updated_at = now() WHERE doc_id = ${docId}`;
    return before[0]!.owner_id;
  });

  invalidateCredsCache();
  return prev ?? undefined;
}

export async function getAnonymousDocIds(userId: string): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM hi_hive WHERE owner_id = ${userId}
  `;
  return rows.map(r => r.doc_id);
}

/** Doc ids whose student_id OR email match the given value (was Filter.or). */
export async function getRelatedDocIds(id: string): Promise<string[]> {
  /*
  Username and phone join the match on purpose. WhatsApp's newer privacy
  setting hides a person's number from anyone who is not a saved contact and
  shows only their @handle in its place, so for a fair number of people the
  handle - or a number someone else copied off their profile before it was
  hidden - is the only thing there is to type into `!test bind`, `!test info`,
  and everything else that resolves a typed id through this function.
  */
  const phone = id.replace(/\D/g, "");
  const handle = id.replace(/^@/, "");
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM hi_hive
    WHERE student_id = ${id} OR email = ${id}
       OR (${phone} <> '' AND phone_number = ${phone})
       OR (${handle} <> '' AND username = ${handle})
  `;
  return rows.map(r => r.doc_id);
}

// ── Aliases: one set of credentials, several platform ids ────────────────────
/*
hi_hive.doc_id holds ONE platform id, but the same person may talk to the
WhatsApp bot from a jid and the Telegram bot from a numeric user id. Without a
link they are two unrelated rows: two sets of creds, two contribution counts,
and a doc only one of their accounts can reach.

An alias is a second id resolving to an existing doc. `bind` creates them, and
resolveDocId() consults them, so both platforms land on the same credentials.
*/

export interface Alias {
  aliasId: string;
  docId: string;
  transport?: string;
  boundBy?: string;
}

/** The doc an alias points at, or undefined when the id is not bound. */
export async function resolveAlias(aliasId: string): Promise<string | undefined> {
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM hi_hive_alias WHERE alias_id = ${aliasId.trim()} LIMIT 1
  `;
  return rows.length ? rows[0]!.doc_id : undefined;
}

/**
 * Point `aliasId` at `docId`.
 *
 * Rebinding an already-bound id moves it rather than failing - binding someone
 * to new credentials is the normal way to correct a mistake.
 */
export async function bindAlias(
  aliasId: string, docId: string, transport?: string, boundBy?: string
): Promise<void> {
  await sql`
    INSERT INTO hi_hive_alias (alias_id, doc_id, transport, bound_by, created_at)
    VALUES (${aliasId.trim()}, ${docId}, ${transport ?? null}, ${boundBy ?? null}, now())
    ON CONFLICT (alias_id) DO UPDATE SET
      doc_id     = EXCLUDED.doc_id,
      transport  = COALESCE(EXCLUDED.transport, hi_hive_alias.transport),
      bound_by   = COALESCE(EXCLUDED.bound_by, hi_hive_alias.bound_by),
      created_at = now()
  `;
  invalidateCredsCache();
}

/** Remove a binding. Returns the doc it used to point at. */
export async function unbindAlias(aliasId: string): Promise<string | undefined> {
  const rows = await sql<{ doc_id: string }[]>`
    DELETE FROM hi_hive_alias WHERE alias_id = ${aliasId.trim()} RETURNING doc_id
  `;
  invalidateCredsCache();
  return rows.length ? rows[0]!.doc_id : undefined;
}

/** Every id bound to a doc, so listings can show who shares one. */
export async function aliasesForDoc(docId: string): Promise<Alias[]> {
  const rows = await sql<{ alias_id: string; doc_id: string; transport: string | null; bound_by: string | null }[]>`
    SELECT alias_id, doc_id, transport, bound_by
    FROM hi_hive_alias WHERE doc_id = ${docId} ORDER BY created_at
  `;
  return rows.map(r => ({
    aliasId: r.alias_id,
    docId: r.doc_id,
    ...(r.transport ? { transport: r.transport } : {}),
    ...(r.bound_by ? { boundBy: r.bound_by } : {}),
  }));
}

/**
 * Turn any id a user might type into the doc it means.
 *
 * Order matters and is deliberate:
 *   1. an exact doc id      - the most specific thing it can be
 *   2. an alias             - an explicit binding someone made on purpose
 *   3. student id / email   - a loose guess, and the only ambiguous one
 *
 * Aliases beat the loose match so a deliberate binding is never overridden by
 * a coincidental student-id hit.
 */
/**
 * The doc that IS this person, for a platform id the bot already trusts.
 *
 * Deliberately stricter than resolveDocId(): exact doc, then alias, and never
 * the student-id/email fallback. Telegram user ids are plain numbers and can be
 * exactly seven digits, which is also the shape of a student id - a loose match
 * there would silently hand someone else's credentials to whoever happened to
 * have a colliding user id.
 *
 * Falls back to the raw id so a brand-new user still gets a doc keyed by it.
 */
export async function resolveOwnDocId(platformId: string): Promise<string> {
  const key = platformId.trim();
  if (await exists(key)) return key;
  return (await resolveAlias(key)) ?? key;
}

export async function resolveDocId(id: string | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const key = id.trim();
  if (!key) return undefined;

  if (await exists(key)) return key;

  const aliased = await resolveAlias(key);
  if (aliased) return aliased;

  const related = await getRelatedDocIds(key);
  return related.length > 0 ? related[0] : undefined;
}

/** Try exact doc id, else fall back to the first id/email match (recursive). */
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

/** Every doc id in the collection. */
export async function getAllDocIds(): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`SELECT doc_id FROM hi_hive`;
  return rows.map(r => r.doc_id);
}

/** Every doc keyed by id → Creds. */
/*
Cached full-table read.

getAllDocs() is on the auto-scan path: every QR that arrives reads the whole
credentials table to build the job list, and the isolated-sessions comparison
reads it again. The table changes only when someone registers or deletes an
account, so re-querying per QR is pure overhead.

The cache is invalidated by every write below rather than expiring on a timer,
so a newly registered student is picked up by the very next scan - a TTL would
mean explaining why "I just added my id and it skipped me".

A short TTL is still applied on top, because the OTHER bot writes to the same
table in a different process and this one gets no notification of that.
*/
export async function getAllDocs(): Promise<Record<string, Creds>> {
  const now = Date.now();
  if (allDocsCache && now - allDocsCache.at < ALL_DOCS_TTL_MS) {
    return allDocsCache.docs;
  }

  const rows = await sql`SELECT * FROM hi_hive`;
  const docs: Record<string, Creds> = {};
  for (const r of rows) docs[r.doc_id] = mapRow(r);

  allDocsCache = { at: now, docs };
  return docs;
}