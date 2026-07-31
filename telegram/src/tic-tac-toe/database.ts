import { userStore } from "../../../shared/db/user-store.js";

// Postgres-backed, shared with the WhatsApp bot. Plain JSON, so no codec needed.

export interface TicTacToeData {
    board: (boolean | null)[];
    player: boolean;
}
export type TicTacToeDataField = "board" | "player";

const store = userStore<TicTacToeData>("tic_tac_toe");

export const userExists = (userId: number): Promise<boolean> => store.exists(userId);

export async function createNewTicTacToe(userId: number, data: TicTacToeData): Promise<void> {
    if (!(await store.create(userId, data))) {
        console.warn(`[tic-tac-toe] game already exists for ${userId} - create ignored.`);
    }
}

export const updateTicTacToe = (userId: number, data: TicTacToeData): Promise<void> =>
    store.set(userId, data);

export const updateTicTacToeField = (
    userId: number,
    field: TicTacToeDataField,
    value: (boolean | null)[] | boolean
): Promise<void> => store.setField(userId, field, value as never);

/** The player's board, or null when they have none. */
export const getTicTacToeData = (userId: number): Promise<TicTacToeData | null> =>
    store.get(userId);

export const deleteTicTacToeDoc = (userId: number): Promise<boolean> => store.remove(userId);
