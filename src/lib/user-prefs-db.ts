/**
 * user-prefs-db.ts — Postgres data access for user preferences.
 * Was: Firestore collection "user_prefs", doc id = userId (schemaless blob).
 *
 * Stored as a single JSONB column so any key/value the code used round-trips
 * unchanged. get returns {} when no row exists.
 */

import sql from "../db/index.js";

export async function getPrefs(userId: string): Promise<Record<string, any>> {
  const rows = await sql<{ prefs: Record<string, any> }[]>`
    SELECT prefs FROM user_prefs WHERE user_id = ${userId} LIMIT 1
  `;
  return rows.length ? (rows[0].prefs ?? {}) : {};
}

/** Merge-patch the prefs blob (like Firestore set({merge:true})). */
export async function setPrefs(userId: string, patch: Record<string, any>): Promise<void> {
  await sql`
    INSERT INTO user_prefs (user_id, prefs, updated_at)
    VALUES (${userId}, ${sql.json(patch)}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET prefs = user_prefs.prefs || EXCLUDED.prefs,   -- JSONB merge
          updated_at = now()
  `;
}

/** Overwrite the whole prefs blob. */
export async function replacePrefs(userId: string, prefs: Record<string, any>): Promise<void> {
  await sql`
    INSERT INTO user_prefs (user_id, prefs, updated_at)
    VALUES (${userId}, ${sql.json(prefs)}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET prefs = EXCLUDED.prefs, updated_at = now()
  `;
}