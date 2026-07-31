import { userStore } from "../../../shared/db/user-store.js";
import { Coord } from "../types.js";

/*
Postgres-backed, shared with the WhatsApp bot.

This used to be Firestore, and the file was one of five near-identical copies of
the same five functions. The storage and the concurrency handling now live in
shared/db/user-store.ts; what stays here is the shape of a snake game and the
names the rest of the module already calls.

Coord is a class with methods, so it needs a codec: JSONB stores plain
{x, y} objects, and `contains()` in types.ts calls coord.equals() on the way
back out. That is what the old FirestoreDataConverter was for.
*/

export interface SnakeGameData {
    parts: Coord[];
    foodCoord: Coord;
}
export type SnakeGameDataField = "parts" | "foodCoord";

interface RawCoord { x: number; y: number }

const toRaw = (c: Coord): RawCoord => ({ x: c.x, y: c.y });
const fromRaw = (c: RawCoord): Coord => new Coord(c.x, c.y);

const store = userStore<SnakeGameData>("snake", {
    encode: (data) => ({
        parts: data.parts.map(toRaw),
        foodCoord: toRaw(data.foodCoord),
    }),
    decode: (raw) => ({
        parts: (raw.parts as RawCoord[]).map(fromRaw),
        foodCoord: fromRaw(raw.foodCoord as RawCoord),
    }),
});

export const userExists = (userId: number): Promise<boolean> => store.exists(userId);

export async function createNewSnakeGame(userId: number, data: SnakeGameData): Promise<void> {
    // create() is atomic, so two fast taps can't both think they created the game
    if (!(await store.create(userId, data))) {
        console.warn(`[snake] game already exists for ${userId} - create ignored.`);
    }
}

export const updateSnakeGame = (userId: number, data: SnakeGameData): Promise<void> =>
    store.set(userId, data);

export async function updateSnakeGameField(
    userId: number,
    field: SnakeGameDataField,
    value: Coord | Coord[]
): Promise<void> {
    const encoded = Array.isArray(value) ? value.map(toRaw) : toRaw(value);
    await store.setField(userId, field, encoded as never);
}

/**
 * The player's game, or null when they have none.
 *
 * The Firestore version cast a missing document straight to SnakeGameData, so a
 * user whose game had been deleted got `undefined` typed as a live game and
 * crashed on the first property read. Callers must now handle null.
 */
export const getSnakeGameData = (userId: number): Promise<SnakeGameData | null> =>
    store.get(userId);

export const deleteSnakeDoc = (userId: number): Promise<boolean> => store.remove(userId);
