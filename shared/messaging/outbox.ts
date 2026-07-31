/**
 * outbox.ts - shared/messaging/outbox.ts
 *
 * Durable outbound messaging for BOTH bots.
 *
 * Why
 * ---
 * A direct send throws if the connection is down, and the message is gone. That
 * cost us scan reports when the WhatsApp socket dropped mid-batch, and it
 * silently loses reminders that fire during a reconnect - the reminder is marked
 * `fired` and never delivered.
 *
 * With an outbox, "send" means "record the intent". Delivery is retried until it
 * succeeds, so a disconnect only delays a message rather than destroying it.
 *
 * Cross-platform
 * --------------
 * Each bot registers its transport at startup:
 *
 *     registerTransport(whatsappTransport);
 *
 * A queued row remembers which transport owes the message, so the WhatsApp
 * drain never tries to deliver a Telegram reminder. A bot that is offline
 * simply leaves its own rows alone; the other bot keeps working.
 *
 * Delivery is at-least-once. A crash between a successful send and the row
 * delete can re-send once; that's the right trade for a reminder or a report.
 */

import crypto from "node:crypto";
import sql from "../db/index.js";
import type {
    OutboundMessage, SentMessage, Transport, TransportName,
} from "./types.js";

const MAX_ATTEMPTS = 12;               // ~2h of backoff, then give up
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const DRAIN_TICK_MS = Number(process.env["OUTBOX_TICK_MS"] ?? 3_000);
const STALE_AFTER_MS = 24 * 3_600_000; // drop undeliverable messages after a day
const BATCH_SIZE = 10;

// Bigger than this and the row is more of a liability than the message is worth
const MAX_QUEUED_BYTES = Number(process.env["OUTBOX_MAX_BYTES"] ?? 24 * 1024 * 1024);

const newId = (): string => crypto.randomBytes(12).toString("base64url");

export interface QueueOpts {
    /** Lower numbers send first. Reminders 1, delay notices 4, reports 5, chatter 6. */
    priority?: number;
    /** Send immediately if the transport is ready, only queueing on failure. Default true. */
    immediate?: boolean;
    /** Never persist: drop the message if it can't go out right now. */
    ephemeral?: boolean;
}

// ── Transport registry ────────────────────────────────────────────────────────

const transports = new Map<TransportName, Transport>();

/** Called once per bot at startup. Re-registering replaces the old instance. */
export function registerTransport(transport: Transport): void {
    transports.set(transport.name, transport);
    console.log(`📮 Transport registered: ${transport.name}`);
}

export function getTransport(name: TransportName): Transport | null {
    return transports.get(name) ?? null;
}

function isReady(name: TransportName): boolean {
    const t = transports.get(name);
    return !!t && t.isReady();
}

/** Which transports this process can actually deliver for. */
function registeredNames(): TransportName[] {
    return [...transports.keys()];
}

// ── Buffer-safe serialisation ─────────────────────────────────────────────────

const BUF_TAG = "__outbox_buffer__";

/*
JSONB has no notion of binary. A Buffer round-tripped through JSON.stringify
becomes {"type":"Buffer","data":[137,80,...]} - roughly 4x the size, and it does
not deserialise back into a Buffer. We tag it and store base64 instead.
*/
function encodeBuffers(value: any): any {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) return { [BUF_TAG]: value.toString("base64") };
    if (value instanceof Uint8Array) return { [BUF_TAG]: Buffer.from(value).toString("base64") };
    if (Array.isArray(value)) return value.map(encodeBuffers);
    if (typeof value === "object") {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) out[k] = encodeBuffers(v);
        return out;
    }
    return value;
}

function decodeBuffers(value: any): any {
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(decodeBuffers);
    if (typeof value === "object") {
        const tagged = (value as any)[BUF_TAG];
        if (typeof tagged === "string") return Buffer.from(tagged, "base64");
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) out[k] = decodeBuffers(v);
        return out;
    }
    return value;
}

function approxSize(encoded: any): number {
    try { return JSON.stringify(encoded).length; }
    catch { return 0; }
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

async function persist(
    transport: TransportName,
    chatId: string,
    message: OutboundMessage,
    opts: QueueOpts
): Promise<string> {
    const encoded = encodeBuffers(message);
    const size = approxSize(encoded);
    if (size > MAX_QUEUED_BYTES) {
        throw new Error(`message too large to queue (${size} bytes, limit ${MAX_QUEUED_BYTES})`);
    }

    const id = newId();
    await sql`
        INSERT INTO outbox (id, transport, chat_id, kind, body, priority, next_try_at)
        VALUES (${id}, ${transport}, ${chatId}, ${message.kind},
                ${sql.json(encoded)}, ${opts.priority ?? 5}, ${Date.now()})
    `;
    return id;
}

/**
 * Queue a message for delivery.
 *
 * Returns the send result when it went out inline, or undefined when it was
 * persisted for later. Callers that need the sent message (poll tracking, for
 * instance) can check for undefined; everyone else can ignore it.
 */
export async function send(
    transport: TransportName,
    chatId: string,
    message: OutboundMessage,
    opts: QueueOpts = {}
): Promise<SentMessage | undefined> {
    const immediate = opts.immediate ?? true;

    /*
    Reactions are cosmetic. Queueing one means it could land minutes later on a
    message nobody is looking at any more, so they are attempted once and
    dropped - never persisted, never retried.
    */
    const cosmetic = message.kind === "reaction" || opts.ephemeral;

    if (immediate && isReady(transport)) {
        try {
            return await transports.get(transport)!.send(chatId, message);
        } catch (err) {
            if (cosmetic) {
                console.log(`[outbox] dropping ${message.kind} to ${chatId}: ${String(err).slice(0, 120)}`);
                return undefined;
            }
            console.log(`[outbox] direct send to ${chatId} failed, queueing: ${String(err).slice(0, 120)}`);
        }
    } else if (!isReady(transport)) {
        if (cosmetic) return undefined;
        console.log(`[outbox] ${transport} not ready - queueing ${message.kind} for ${chatId}`);
    }

    if (cosmetic) return undefined;

    await persist(transport, chatId, message, opts);
    return undefined;
}

/** Shorthand for the overwhelmingly common case. */
export const sendText = (
    transport: TransportName,
    chatId: string,
    body: string,
    opts: QueueOpts & { replyTo?: string | number; format?: "plain" | "markdown" | "html" } = {}
): Promise<SentMessage | undefined> => {
    const { replyTo, format, ...queueOpts } = opts;
    return send(transport, chatId, { kind: "text", text: body, replyTo, format }, queueOpts);
};

/** Fire-and-forget reaction. Never queued. */
export async function react(
    transport: TransportName,
    chatId: string,
    emoji: string,
    target: { id?: string | number; key?: unknown }
): Promise<void> {
    if (!isReady(transport)) return;
    try {
        await transports.get(transport)!.send(chatId, {
            kind: "reaction",
            emoji,
            targetId: target.id ?? "",
            targetKey: target.key,
        });
    } catch { /* cosmetic - ignore */ }
}

// ── Drain service ─────────────────────────────────────────────────────────────

let started = false;
let draining = false;

/**
 * Start draining. Safe to call from both bots; each process only delivers rows
 * belonging to transports it has registered.
 */
export function startOutboxService(): void {
    if (started) return;
    started = true;
    console.log("📤 Outbox service started (durable outbound messages).");

    const drain = async (): Promise<void> => {
        if (draining) return;                       // never overlap
        draining = true;
        try {
            const mine = registeredNames().filter(isReady);
            if (mine.length === 0) return;            // nothing we can deliver right now

            const now = Date.now();
            const rows = await sql<any[]>`
                SELECT * FROM outbox
                WHERE next_try_at <= ${now}
                  AND transport IN ${sql(mine)}
                ORDER BY priority ASC, created_at ASC
                LIMIT ${BATCH_SIZE}
            `;
            if (rows.length === 0) return;

            for (const row of rows) {
                // Give up on anything hopelessly old rather than retrying forever
                const ageMs = now - new Date(row.created_at).getTime();
                if (ageMs > STALE_AFTER_MS || row.attempts >= MAX_ATTEMPTS) {
                    await sql`DELETE FROM outbox WHERE id = ${row.id}`;
                    console.error(
                        `[outbox] ✗ dropping ${row.id} after ${row.attempts} attempt(s): ${row.last_error ?? "too old"}`
                    );
                    continue;
                }

                const transport = transports.get(row.transport as TransportName);
                if (!transport || !transport.isReady()) continue;   // another process owns it

                try {
                    await transport.send(row.chat_id, decodeBuffers(row.body) as OutboundMessage);
                    await sql`DELETE FROM outbox WHERE id = ${row.id}`;
                    console.log(
                        `[outbox] ✓ delivered ${row.kind} to ${row.chat_id} via ${row.transport}` +
                        (row.attempts > 0 ? ` (attempt ${row.attempts + 1})` : "")
                    );
                } catch (err) {
                    const attempts = row.attempts + 1;
                    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
                    await sql`
                        UPDATE outbox
                        SET attempts = ${attempts},
                            next_try_at = ${Date.now() + delay},
                            last_error = ${String(err).slice(0, 300)}
                        WHERE id = ${row.id}
                    `;
                    console.log(`[outbox] retry ${row.id} in ${Math.round(delay / 1000)}s (attempt ${attempts})`);
                    // Connection probably just went down - stop this pass
                    if (!transport.isReady()) break;
                }
            }
        } catch (err) {
            console.error("[outbox] drain error:", err);
        } finally {
            draining = false;
        }
    };

    void drain();                                   // flush anything left from last run
    setInterval(drain, DRAIN_TICK_MS);
}

/**
 * Reset queued messages to "try now".
 *
 * Call this the moment a connection reopens. Without it a message that
 * accumulated backoff during an outage would keep waiting out its timer even
 * though the link is healthy again - a reminder delayed by a 3-minute reconnect
 * would otherwise land ~5 minutes late.
 *
 * Scoped to one transport so a WhatsApp reconnect doesn't reset Telegram's
 * backoff while Telegram is still genuinely down.
 */
export async function flushOutbox(transport?: TransportName): Promise<number> {
    const now = Date.now();
    const rows = transport
        ? await sql`UPDATE outbox SET next_try_at = ${now}
                    WHERE next_try_at > ${now} AND transport = ${transport} RETURNING id`
        : await sql`UPDATE outbox SET next_try_at = ${now}
                    WHERE next_try_at > ${now} RETURNING id`;

    if (rows.length > 0) {
        console.log(`[outbox] connection back - flushing ${rows.length} waiting message(s) immediately.`);
    }
    return rows.length;
}

/** How many messages are waiting - handy for a status command. */
export async function outboxDepth(transport?: TransportName): Promise<number> {
    const rows = transport
        ? await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM outbox WHERE transport = ${transport}`
        : await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM outbox`;
    return Number(rows[0]?.n ?? 0);
}

// ── Persistent duplicate guard ────────────────────────────────────────────────

/**
 * Has this message already been handled?
 *
 * Backed by Postgres rather than an in-memory Set, because catching up on
 * messages received while a bot was down would otherwise re-process a QR that
 * had already been scanned before the restart.
 *
 * Scoped per transport: message ids are only unique within a platform.
 *
 * Returns true if it was seen before; records it and returns false otherwise.
 */
export async function alreadyProcessed(
    transport: TransportName,
    msgId: string | number | null | undefined
): Promise<boolean> {
    if (msgId === null || msgId === undefined || msgId === "") return false;
    const rows = await sql`
        INSERT INTO processed_messages (msg_id, transport)
        VALUES (${`${transport}:${msgId}`}, ${transport})
        ON CONFLICT (msg_id) DO NOTHING
        RETURNING msg_id
    `;
    return rows.length === 0;          // no row returned = it already existed
}

/** Housekeeping: forget message ids older than 7 days. */
export async function purgeProcessed(): Promise<void> {
    await sql`DELETE FROM processed_messages WHERE handled_at < now() - interval '7 days'`;
}
