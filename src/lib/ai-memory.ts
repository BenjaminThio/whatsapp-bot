/**
 * ai-memory.ts — chat history persistence, now on Postgres `ai_memory` table.
 * Was: Firestore collection "ai_memory", doc id = chatId, field history[].
 *
 * Extracted into its own helper so query.ts just calls load/save and doesn't
 * care about the storage backend. Keeps the same sliding-window + size-guard
 * logic we built for Firestore.
 */

import sql from "../db/index.js";

export const MAX_HISTORY = 40;          // 20 exchanges
const MAX_SERIALISED_BYTES = 800_000;   // safety net under any single-row bloat

export interface HistoryTurn {
  role: "user" | "model";
  parts: { text: string }[];
}

/** Load history for a chat, trimmed to the last MAX_HISTORY turns. */
export async function loadHistory(chatId: string): Promise<HistoryTurn[]> {
  const rows = await sql<{ history: HistoryTurn[] }[]>`
    SELECT history FROM ai_memory WHERE chat_id = ${chatId} LIMIT 1
  `;
  let history: HistoryTurn[] = rows.length ? (rows[0].history ?? []) : [];
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }
  return history;
}

/**
 * Save history for a chat with the sliding-window + size-guard applied.
 * Returns the actually-persisted array (already trimmed).
 */
export async function saveHistory(chatId: string, history: HistoryTurn[]): Promise<HistoryTurn[]> {
  // Sliding window
  let trimmed = history.length > MAX_HISTORY
    ? history.slice(history.length - MAX_HISTORY)
    : history;

  // Size guard
  if (JSON.stringify(trimmed).length > MAX_SERIALISED_BYTES) {
    trimmed = trimmed.slice(Math.floor(trimmed.length / 2));
  }

  await sql`
    INSERT INTO ai_memory (chat_id, history, updated_at)
    VALUES (${chatId}, ${sql.json(trimmed as any)}, now())
    ON CONFLICT (chat_id) DO UPDATE
      SET history = EXCLUDED.history,
          updated_at = now()
  `;
  return trimmed;
}