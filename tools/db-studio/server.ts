/**
 * server.ts - a Firestore-console-style browser for the bot's Postgres.
 *
 *   bun run studio            then open http://127.0.0.1:4321 on the phone
 *
 * Exists because the schema is spread across six .sql files and a generic JSONB
 * document store, and after a few weeks away none of that is in your head any
 * more. This shows the tables, their structure, every row, and lets you edit
 * values in place.
 *
 * Safety, in order of importance:
 *
 *   • Binds to 127.0.0.1 only. Never reachable from the network, only from the
 *     phone it runs on. Pass --host 0.0.0.0 to override, and understand that it
 *     exposes the whole database with no login.
 *   • Every table and column name is checked against the live catalog before it
 *     reaches SQL. Identifiers cannot be parameterised, so the only safe way to
 *     use one is to prove it already exists.
 *   • Values always go through query parameters, never string interpolation.
 *   • Writes need a primary key. A table without one is read-only here, because
 *     an UPDATE with no unique target can silently rewrite every row.
 */

import { file } from "bun";
import path from "node:path";
import url from "node:url";
import sql from "../../shared/db/index.js";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
};

const PORT = Number(flag("port", process.env["STUDIO_PORT"] ?? "4321"));
const HOST = flag("host", "127.0.0.1");
const PAGE_SIZE = 50;

// ── Catalog ───────────────────────────────────────────────────────────────────

interface Column {
    name: string;
    type: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    default: string | null;
}

interface TableInfo {
    name: string;
    columns: Column[];
    primaryKey: string[];
    rowCount: number;
}

/*
The catalog is read once and cached. Everything that touches SQL validates
against it first: an identifier that is not in here never reaches a query.
*/
let catalog: Map<string, TableInfo> | null = null;

async function loadCatalog(force = false): Promise<Map<string, TableInfo>> {
    if (catalog && !force) return catalog;

    const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
    `;

    const cols = await sql<{
        table_name: string; column_name: string; data_type: string;
        is_nullable: string; column_default: string | null;
    }[]>`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
    `;

    const pks = await sql<{ table_name: string; column_name: string }[]>`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position
    `;

    const pkMap = new Map<string, string[]>();
    for (const r of pks) {
        pkMap.set(r.table_name, [...(pkMap.get(r.table_name) ?? []), r.column_name]);
    }

    const out = new Map<string, TableInfo>();
    for (const t of tables) {
        const pk = pkMap.get(t.table_name) ?? [];
        const counted = await sql.unsafe(
            `SELECT count(*)::int AS n FROM ${quoteIdent(t.table_name)}`
        ) as unknown as { n: number }[];

        out.set(t.table_name, {
            name: t.table_name,
            primaryKey: pk,
            rowCount: counted[0]?.n ?? 0,
            columns: cols
                .filter(c => c.table_name === t.table_name)
                .map(c => ({
                    name: c.column_name,
                    type: c.data_type,
                    nullable: c.is_nullable === "YES",
                    isPrimaryKey: pk.includes(c.column_name),
                    default: c.column_default,
                })),
        });
    }

    catalog = out;
    return out;
}

/** Wrap an identifier for SQL. Only ever called with a catalog-verified name. */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

async function requireTable(name: string): Promise<TableInfo> {
    const cat = await loadCatalog();
    const t = cat.get(name);
    if (!t) throw new HttpError(404, `No such table: ${name}`);
    return t;
}

function requireColumn(table: TableInfo, name: string): Column {
    const c = table.columns.find(c => c.name === name);
    if (!c) throw new HttpError(400, `No such column: ${table.name}.${name}`);
    return c;
}

class HttpError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

// ── Value handling ────────────────────────────────────────────────────────────

const JSON_TYPES = new Set(["json", "jsonb"]);
const NUMERIC_TYPES = new Set([
    "smallint", "integer", "bigint", "decimal", "numeric", "real",
    "double precision",
]);

/**
 * Turn the editor's string into something the column will accept.
 *
 * The UI is text boxes, so everything arrives as a string. Postgres will not
 * coerce "true" into a boolean column or "" into a number, and a JSONB column
 * needs real JSON rather than a quoted string containing JSON.
 */
function coerce(column: Column, raw: unknown): unknown {
    if (raw === null) {
        if (!column.nullable) throw new HttpError(400, `${column.name} cannot be null`);
        return null;
    }

    if (JSON_TYPES.has(column.type)) {
        if (typeof raw === "string") {
            try {
                return JSON.parse(raw);
            } catch (e) {
                throw new HttpError(400, `${column.name} is not valid JSON: ${(e as Error).message}`);
            }
        }
        return raw;   // already an object from the tree editor
    }

    if (typeof raw !== "string") return raw;

    if (column.type === "boolean") {
        const s = raw.trim().toLowerCase();
        if (["true", "t", "yes", "1"].includes(s)) return true;
        if (["false", "f", "no", "0"].includes(s)) return false;
        throw new HttpError(400, `${column.name} expects a boolean, got "${raw}"`);
    }

    if (NUMERIC_TYPES.has(column.type)) {
        if (raw.trim() === "") {
            if (column.nullable) return null;
            throw new HttpError(400, `${column.name} cannot be empty`);
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new HttpError(400, `${column.name} expects a number, got "${raw}"`);
        return n;
    }

    // Empty text in a nullable column means NULL, which is nearly always what
    // clearing a field is meant to do
    if (raw === "" && column.nullable) return null;
    return raw;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });

/** Build a WHERE clause over the primary key, as parameterised SQL. */
/*
What a query parameter may be.

JSONB values are passed as a JS OBJECT and left for postgres.js to serialise.
Pre-stringifying them and casting with ::jsonb looks tidier and is wrong:
postgres.js JSON-encodes the string it is given, so the column ends up holding
a JSON *string* rather than an object - jsonb_typeof() says "string" and every
path query against it returns null.

postgres.js types unsafe()'s parameters more narrowly than it accepts at
runtime, hence the cast at the call site.
*/
type Param = string | number | boolean | null | object;

function pkWhere(table: TableInfo, key: Record<string, string>): { clause: string; values: Param[] } {
    if (table.primaryKey.length === 0) {
        throw new HttpError(400, `${table.name} has no primary key, so rows cannot be addressed safely`);
    }
    const values: Param[] = [];
    const parts = table.primaryKey.map((col, i) => {
        const v = key[col];
        if (v === undefined) throw new HttpError(400, `Missing key column: ${col}`);
        const column = requireColumn(table, col);
        values.push(coerce(column, v) as Param);
        return `${quoteIdent(col)} = $${i + 1}`;
    });
    return { clause: parts.join(" AND "), values };
}

async function listRows(name: string, url: URL): Promise<Response> {
    const table = await requireTable(name);
    const page = Math.max(0, Number(url.searchParams.get("page") ?? 0));
    const search = (url.searchParams.get("q") ?? "").trim();

    const order = table.primaryKey.length > 0
        ? table.primaryKey.map(quoteIdent).join(", ")
        : "1";

    let rows: unknown[];
    let total = table.rowCount;

    if (search) {
        /*
        Search casts the whole row to text. Slow on a big table, but these are
        small and it means one box finds anything without the user having to
        know which column holds it.
        */
        const q = `%${search}%`;
        rows = await sql.unsafe(
            `SELECT * FROM ${quoteIdent(name)} WHERE ${quoteIdent(name)}::text ILIKE $1
             ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`,
            [q]
        ) as unknown as unknown[];
        const c = await sql.unsafe(
            `SELECT count(*)::int AS n FROM ${quoteIdent(name)} WHERE ${quoteIdent(name)}::text ILIKE $1`,
            [q]
        ) as unknown as { n: number }[];
        total = c[0]?.n ?? 0;
    } else {
        rows = await sql.unsafe(
            `SELECT * FROM ${quoteIdent(name)} ORDER BY ${order}
             LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`
        ) as unknown as unknown[];
    }

    return json({ table, rows, page, pageSize: PAGE_SIZE, total });
}

async function updateCell(name: string, body: any): Promise<Response> {
    const table = await requireTable(name);
    const column = requireColumn(table, String(body.column));

    if (column.isPrimaryKey) {
        throw new HttpError(400, `${column.name} is part of the primary key and cannot be edited here`);
    }

    const { clause, values } = pkWhere(table, body.key ?? {});
    // coerce() has already turned JSON text into a real object; hand that
    // straight to postgres.js and let it do the encoding
    const value = coerce(column, body.value ?? null) as Param;

    const updated = await sql.unsafe(
        `UPDATE ${quoteIdent(name)} SET ${quoteIdent(column.name)} = $${values.length + 1}
         WHERE ${clause} RETURNING *`,
        [...values, value] as never[]
    ) as unknown as unknown[];

    if (updated.length === 0) throw new HttpError(404, "No row matched that key");
    return json({ ok: true, row: updated[0] });
}

async function deleteRow(name: string, body: any): Promise<Response> {
    const table = await requireTable(name);
    const { clause, values } = pkWhere(table, body.key ?? {});

    const deleted = await sql.unsafe(
        `DELETE FROM ${quoteIdent(name)} WHERE ${clause} RETURNING *`, values as never[]
    ) as unknown as unknown[];

    if (deleted.length === 0) throw new HttpError(404, "No row matched that key");
    catalog = null;                     // row counts are stale now
    return json({ ok: true, deleted: deleted[0] });
}

async function runHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/" || p === "/index.html") {
        return new Response(file(path.join(HERE, "index.html")), {
            headers: { "content-type": "text/html; charset=utf-8" },
        });
    }

    if (p === "/api/tables") {
        const cat = await loadCatalog(url.searchParams.get("refresh") === "1");
        return json({ tables: [...cat.values()] });
    }

    const rowsMatch = p.match(/^\/api\/rows\/([A-Za-z0-9_]+)$/);
    if (rowsMatch) return listRows(rowsMatch[1]!, url);

    // A request body can only be read once, so parse it and pass it along
    if (p === "/api/cell" && req.method === "POST") {
        const body = await req.json() as any;
        return updateCell(String(body.table), body);
    }

    if (p === "/api/delete" && req.method === "POST") {
        const body = await req.json() as any;
        return deleteRow(String(body.table), body);
    }

    return json({ error: "Not found" }, 404);
}

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
        try {
            return await runHandler(req);
        } catch (err) {
            if (err instanceof HttpError) return json({ error: err.message }, err.status);
            console.error("studio error:", err);
            return json({ error: (err as Error).message ?? "Internal error" }, 500);
        }
    },
});

console.log(`
🗄️  Lasma DB Studio

    http://${HOST}:${server.port}

    Open that in the phone's browser. Ctrl-C to stop.
    ${HOST === "127.0.0.1"
        ? "Bound to localhost - reachable only from this device."
        : "⚠️  Bound to " + HOST + " - anyone on the network can read and edit the database."}
`);
