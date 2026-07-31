import { userStore } from "../../../shared/db/user-store.js";
import { Key } from "./index.js";

// Postgres-backed, shared with the WhatsApp bot. Plain JSON, so no codec needed.

export interface CalculatorData {
    scientific: boolean;
    secondary: boolean;
    entries: number[];
    result: string;
}
export type CalculatorDataField = "scientific" | "secondary" | "entries" | "result";

const store = userStore<CalculatorData>("calculator");

export const userExists = (userId: number): Promise<boolean> => store.exists(userId);

export async function createNewCalculator(userId: number, data: CalculatorData): Promise<void> {
    if (!(await store.create(userId, data))) {
        console.warn(`[calculator] state already exists for ${userId} - create ignored.`);
    }
}

export const updateCalculator = (userId: number, data: CalculatorData): Promise<void> =>
    store.set(userId, data);

export const updateCalculatorField = (
    userId: number,
    field: CalculatorDataField,
    value: boolean | Key[] | string
): Promise<void> => store.setField(userId, field, value as never);

/**
 * The user's calculator state, creating a blank one on first use.
 *
 * This returns a value rather than null: a calculator with no state is just a
 * cleared calculator, and every caller was immediately using the result.
 */
export const getCalculatorData = (userId: number): Promise<CalculatorData> =>
    store.getOrCreate(userId, {
        scientific: false,
        secondary: false,
        entries: [],
        result: "",
    });

export const deleteCalculatorDoc = (userId: number): Promise<boolean> => store.remove(userId);
