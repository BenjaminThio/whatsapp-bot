import { userStore } from "../../../shared/db/user-store.js";
import { Coord } from "../types.js";

// Postgres-backed, shared with the WhatsApp bot. See snake/database.ts for why
// the codec exists (Coord is a class, JSONB only stores plain objects).

export interface SokobanGameData {
    player: Coord;
    boxes: Coord[];
    destinations: Coord[];
    barriers: Coord[];
}
export type SokobanGameDataField = "player" | "boxes" | "destinations" | "barriers";

interface RawCoord { x: number; y: number }

const toRaw = (c: Coord): RawCoord => ({ x: c.x, y: c.y });
const fromRaw = (c: RawCoord): Coord => new Coord(c.x, c.y);
const listToRaw = (cs: Coord[]): RawCoord[] => cs.map(toRaw);
const listFromRaw = (cs: RawCoord[]): Coord[] => cs.map(fromRaw);

const store = userStore<SokobanGameData>("sokoban", {
    encode: (data) => ({
        player: toRaw(data.player),
        boxes: listToRaw(data.boxes),
        destinations: listToRaw(data.destinations),
        barriers: listToRaw(data.barriers),
    }),
    decode: (raw) => ({
        player: fromRaw(raw.player as RawCoord),
        boxes: listFromRaw(raw.boxes as RawCoord[]),
        destinations: listFromRaw(raw.destinations as RawCoord[]),
        barriers: listFromRaw(raw.barriers as RawCoord[]),
    }),
});

export const userExists = (userId: number): Promise<boolean> => store.exists(userId);

export async function createNewSokobanGame(userId: number, data: SokobanGameData): Promise<void> {
    if (!(await store.create(userId, data))) {
        console.warn(`[sokoban] game already exists for ${userId} - create ignored.`);
    }
}

export const updateSokobanGame = (userId: number, data: SokobanGameData): Promise<void> =>
    store.set(userId, data);

export async function updateSokobanGameField(
    userId: number,
    field: SokobanGameDataField,
    value: Coord | Coord[]
): Promise<void> {
    const encoded = Array.isArray(value) ? listToRaw(value) : toRaw(value);
    await store.setField(userId, field, encoded as never);
}

/** The player's game, or null when they have none. */
export const getSokobanGameData = (userId: number): Promise<SokobanGameData | null> =>
    store.get(userId);

export const deleteSokobanDoc = (userId: number): Promise<boolean> => store.remove(userId);
