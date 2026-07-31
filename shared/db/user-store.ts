/**
 * user-store.ts - shared/db/user-store.ts
 *
 * A per-user JSON document store.
 *
 * The Telegram bot had six database modules - shop, snake, sokoban, calculator,
 * tic-tac-toe, birthday - and five of them were the same file with the nouns
 * swapped:
 *
 *     userExists(userId)            createNewX(userId, data)
 *     updateX(userId, data)         updateXField(userId, field, value)
 *     getXData(userId)              deleteXDoc(userId)
 *
 * They also shared the same bug: `getXData` cast a missing document straight to
 * the data type, so a user who had never played got `undefined` typed as a live
 * game and crashed on first property access.
 *
 * One generic store replaces all of them. Each feature calls
 * `userStore<T>("snake")` once and gets a typed handle:
 *
 *     const snake = userStore<SnakeGameData>("snake");
 *     await snake.set(userId, data);
 *     const game = await snake.get(userId);      // T | null, honestly typed
 *
 * A `codec` converts between the stored JSON and richer runtime objects, which
 * is how Coord instances survive the round trip (Firestore needed a
 * FirestoreDataConverter for exactly this).
 */

import sql from "./index.js";

/** Anything that can identify an owner: Telegram user id, or a WhatsApp jid. */
export type OwnerId = string | number;

const key = (owner: OwnerId): string => String(owner);

/**
 * Converts between the JSON shape stored in Postgres and the runtime shape the
 * feature wants. Omit it when they are the same.
 */
export interface DocCodec<T> {
    /** Runtime object -> plain JSON. */
    encode(value: T): unknown;
    /** Plain JSON -> runtime object. */
    decode(raw: any): T;
}

export interface UserStore<T> {
    readonly namespace: string;
    exists(owner: OwnerId): Promise<boolean>;
    /** The document, or null when the user has none. */
    get(owner: OwnerId): Promise<T | null>;
    /** The document, or `fallback` when the user has none. Never writes. */
    getOr(owner: OwnerId, fallback: T): Promise<T>;
    /** Read the document, creating it from `initial` the first time. */
    getOrCreate(owner: OwnerId, initial: T | (() => T)): Promise<T>;
    /** Write the whole document (insert or replace). */
    set(owner: OwnerId, value: T): Promise<void>;
    /** Create only if absent. Returns false when a document already existed. */
    create(owner: OwnerId, value: T): Promise<boolean>;
    /** Shallow-merge a partial into the stored document. */
    merge(owner: OwnerId, patch: Partial<T>): Promise<void>;
    /** Update a single top-level field. */
    setField<K extends keyof T>(owner: OwnerId, field: K, value: T[K]): Promise<void>;
    /** Read-modify-write under a row lock, so two updates can't clobber. */
    mutate(owner: OwnerId, fn: (current: T | null) => T): Promise<T>;
    remove(owner: OwnerId): Promise<boolean>;
    /** Every document in the namespace, as [ownerId, value] pairs. */
    entries(): Promise<[string, T][]>;
    count(): Promise<number>;
}

/**
 * Build a typed handle on one namespace.
 *
 * @param namespace stable name; it is the storage key, so renaming it orphans data
 * @param codec     optional conversion for runtime objects that aren't plain JSON
 */
export function userStore<T>(namespace: string, codec?: DocCodec<T>): UserStore<T> {
    const encode = (value: T): unknown => (codec ? codec.encode(value) : value);
    const decode = (raw: any): T => (codec ? codec.decode(raw) : raw as T);

    const readRaw = async (owner: OwnerId): Promise<any | null> => {
        const rows = await sql<{ data: any }[]>`
            SELECT data FROM user_docs
            WHERE namespace = ${namespace} AND owner_id = ${key(owner)}
        `;
        return rows.length > 0 ? rows[0]!.data : null;
    };

    const writeRaw = async (owner: OwnerId, data: unknown): Promise<void> => {
        await sql`
            INSERT INTO user_docs (namespace, owner_id, data)
            VALUES (${namespace}, ${key(owner)}, ${sql.json(data as any)})
            ON CONFLICT (namespace, owner_id) DO UPDATE
            SET data = EXCLUDED.data, updated_at = now()
        `;
    };

    return {
        namespace,

        async exists(owner) {
            const rows = await sql`
                SELECT 1 FROM user_docs
                WHERE namespace = ${namespace} AND owner_id = ${key(owner)}
            `;
            return rows.length > 0;
        },

        async get(owner) {
            const raw = await readRaw(owner);
            return raw === null ? null : decode(raw);
        },

        async getOr(owner, fallback) {
            const raw = await readRaw(owner);
            return raw === null ? fallback : decode(raw);
        },

        async getOrCreate(owner, initial) {
            const raw = await readRaw(owner);
            if (raw !== null) return decode(raw);

            const value = typeof initial === "function" ? (initial as () => T)() : initial;
            /*
            ON CONFLICT DO NOTHING, then re-read: two messages arriving together
            (a fast double-tap on an inline button) would otherwise both insert
            and the second would throw on the primary key.
            */
            await sql`
                INSERT INTO user_docs (namespace, owner_id, data)
                VALUES (${namespace}, ${key(owner)}, ${sql.json(encode(value) as any)})
                ON CONFLICT (namespace, owner_id) DO NOTHING
            `;
            const settled = await readRaw(owner);
            return settled === null ? value : decode(settled);
        },

        async set(owner, value) {
            await writeRaw(owner, encode(value));
        },

        async create(owner, value) {
            const rows = await sql`
                INSERT INTO user_docs (namespace, owner_id, data)
                VALUES (${namespace}, ${key(owner)}, ${sql.json(encode(value) as any)})
                ON CONFLICT (namespace, owner_id) DO NOTHING
                RETURNING owner_id
            `;
            return rows.length > 0;
        },

        async merge(owner, patch) {
            // jsonb || jsonb is a shallow merge, done inside the database so a
            // concurrent write to a different key is not lost.
            await sql`
                INSERT INTO user_docs (namespace, owner_id, data)
                VALUES (${namespace}, ${key(owner)}, ${sql.json(patch as any)})
                ON CONFLICT (namespace, owner_id) DO UPDATE
                SET data = user_docs.data || EXCLUDED.data, updated_at = now()
            `;
        },

        async setField(owner, field, value) {
            await sql`
                INSERT INTO user_docs (namespace, owner_id, data)
                VALUES (${namespace}, ${key(owner)}, ${sql.json({ [field as string]: value } as any)})
                ON CONFLICT (namespace, owner_id) DO UPDATE
                SET data = jsonb_set(user_docs.data, ARRAY[${String(field)}], ${sql.json(value as any)}, true),
                    updated_at = now()
            `;
        },

        async mutate(owner, fn) {
            return await sql.begin(async (tx) => {
                const rows = await tx<{ data: any }[]>`
                    SELECT data FROM user_docs
                    WHERE namespace = ${namespace} AND owner_id = ${key(owner)}
                    FOR UPDATE
                `;
                const current = rows.length > 0 ? decode(rows[0]!.data) : null;
                const next = fn(current);
                await tx`
                    INSERT INTO user_docs (namespace, owner_id, data)
                    VALUES (${namespace}, ${key(owner)}, ${tx.json(encode(next) as any)})
                    ON CONFLICT (namespace, owner_id) DO UPDATE
                    SET data = EXCLUDED.data, updated_at = now()
                `;
                return next;
            }) as T;
        },

        async remove(owner) {
            const res = await sql`
                DELETE FROM user_docs
                WHERE namespace = ${namespace} AND owner_id = ${key(owner)}
            `;
            return res.count > 0;
        },

        async entries() {
            const rows = await sql<{ owner_id: string; data: any }[]>`
                SELECT owner_id, data FROM user_docs WHERE namespace = ${namespace}
            `;
            return rows.map(r => [r.owner_id, decode(r.data)] as [string, T]);
        },

        async count() {
            const rows = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM user_docs WHERE namespace = ${namespace}
            `;
            return Number(rows[0]?.n ?? 0);
        },
    };
}

// ── Global settings ───────────────────────────────────────────────────────────

/** Read a global setting, or null when unset. */
export async function getSetting<T>(key: string): Promise<T | null> {
    const rows = await sql<{ value: any }[]>`SELECT value FROM bot_settings WHERE key = ${key}`;
    return rows.length > 0 ? rows[0]!.value as T : null;
}

/** Write a global setting. */
export async function setSetting<T>(key: string, value: T): Promise<void> {
    await sql`
        INSERT INTO bot_settings (key, value)
        VALUES (${key}, ${sql.json(value as any)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
}

export async function deleteSetting(key: string): Promise<boolean> {
    const res = await sql`DELETE FROM bot_settings WHERE key = ${key}`;
    return res.count > 0;
}
