/**
 * contributions.ts - QR credit, for registered and unregistered people alike.
 *
 * The old rule was "increment hi_hive.contributions for this doc id", which
 * silently dropped every contribution from someone without an account. Since
 * supplying QRs is the single most useful thing anyone does in these groups,
 * and doing it requires no registration at all, that under-counted exactly the
 * people worth recognising.
 *
 * Now there is one entry point. Callers pass the chat account that supplied the
 * QR and whatever identity they happen to know; where the credit lands is
 * decided here:
 *
 *   registered   -> hi_hive.contributions, as before
 *   unregistered -> contributors, keyed by the account
 *
 * Nothing is stored for an unregistered contributor beyond what is needed to
 * name them on a leaderboard: id, display name, handle, phone number. No
 * credentials, because they have not offered any.
 */

import sql from "../db/index.js";
import { resolveOwnDocId, exists, invalidateCredsCache } from "./creds.js";
import { cleanName } from "./identity.js";

export type Transport = "whatsapp" | "telegram";

export interface ContributorIdentity {
    displayName?: string | null;
    username?: string | null;
    phoneNumber?: string | null;
}

/**
 * Credit one QR to whoever supplied it.
 *
 * Returns where the credit landed, which the caller can log. A blank userId is
 * ignored rather than throwing: failing to identify a contributor must never
 * abort the scan itself, which is the part that actually matters.
 */
export async function creditContribution(
    userId: string | null | undefined,
    transport: Transport,
    identity: ContributorIdentity = {}
): Promise<"registered" | "unregistered" | "skipped"> {
    const id = userId?.trim();
    if (!id) return "skipped";

    // resolveOwnDocId() follows bind aliases, so someone who registered on the
    // other platform still gets credited to their real account
    const docId = await resolveOwnDocId(id);

    if (await exists(docId)) {
        await sql`
            UPDATE hi_hive SET contributions = contributions + 1 WHERE doc_id = ${docId}
        `;
        invalidateCredsCache();
        return "registered";
    }

    await sql`
        INSERT INTO contributors
            (user_id, transport, display_name, username, phone_number,
             contributions, first_contributed, last_contributed)
        VALUES (${id}, ${transport}, ${identity.displayName ?? null},
                ${identity.username ?? null}, ${identity.phoneNumber ?? null},
                1, now(), now())
        ON CONFLICT (user_id, transport) DO UPDATE SET
            contributions    = contributors.contributions + 1,
            display_name     = COALESCE(EXCLUDED.display_name, contributors.display_name),
            username         = COALESCE(EXCLUDED.username, contributors.username),
            phone_number     = COALESCE(EXCLUDED.phone_number, contributors.phone_number),
            last_contributed = now()
    `;
    return "unregistered";
}

/**
 * Fold an unregistered tally into a hi_hive account.
 *
 * Called when someone who has been contributing anonymously gets bound to
 * credentials: their history should follow them rather than resetting to zero.
 * The contributors row is removed so the same QRs cannot be counted twice.
 */
export async function mergeContributions(userId: string, docId: string): Promise<number> {
    return sql.begin(async trx => {
        const rows = await trx<{ contributions: number }[]>`
            DELETE FROM contributors WHERE user_id = ${userId} RETURNING contributions
        `;
        const total = rows.reduce((sum, r) => sum + Number(r.contributions), 0);
        if (total > 0) {
            await trx`
                UPDATE hi_hive SET contributions = contributions + ${total}
                 WHERE doc_id = ${docId}
            `;
        }
        return total;
    });
}

export interface LeaderRow {
    /** Student id for registered contributors, null otherwise. */
    studentId: string | null;
    displayName: string | null;
    username: string | null;
    phoneNumber: string | null;
    hidden: boolean;
    contributions: number;
    registered: boolean;
    /** The chat account, for unregistered rows. */
    userId: string | null;
}

/**
 * The leaderboard, registered and unregistered merged.
 *
 * A UNION rather than a join: the two groups live in different tables with
 * different keys, and neither is a subset of the other. Ordering happens across
 * the combined set so an unregistered contributor can legitimately outrank a
 * registered one - which is the entire point.
 */
export async function getLeaderboard(limit = 25): Promise<LeaderRow[]> {
    const rows = await sql<any[]>`
        SELECT student_id, display_name, username, phone_number, hidden,
               contributions, TRUE AS registered, NULL::text AS user_id
          FROM hi_hive
         WHERE contributions > 0

        UNION ALL

        SELECT NULL AS student_id, display_name, username, phone_number,
               FALSE AS hidden, contributions, FALSE AS registered, user_id
          FROM contributors
         WHERE contributions > 0

         ORDER BY contributions DESC, student_id ASC NULLS LAST
         LIMIT ${limit}
    `;

    return rows.map(r => ({
        studentId: r.student_id ?? null,
        displayName: r.display_name ?? null,
        username: r.username ?? null,
        phoneNumber: r.phone_number ?? null,
        hidden: r.hidden ?? false,
        contributions: Number(r.contributions),
        registered: r.registered === true,
        userId: r.user_id ?? null,
    }));
}

/** Short, readable phone form. Bare digits are hard to read at a glance. */
function prettyPhone(digits: string): string {
    const d = digits.replace(/\D/g, "");
    if (d.length < 8) return d;
    return `+${[d.slice(0, -7), d.slice(-7, -4), d.slice(-4)].filter(Boolean).join(" ")}`;
}

/**
 * What to call a contributor on the leaderboard.
 *
 * `hidden` only conceals a registered student's id - it is a property of their
 * credentials. An unregistered contributor never asked to be hidden, so the
 * best available identifier is used, ending at a truncated account id rather
 * than nothing at all.
 */
export function leaderLabel(row: LeaderRow): string {
    if (row.hidden) return "Hidden User";
    if (row.displayName) return row.displayName;
    if (row.studentId) return row.studentId;
    if (row.username) return `@${row.username}`;
    if (row.phoneNumber) return prettyPhone(row.phoneNumber);

    const local = (row.userId ?? "").split("@")[0] ?? "";
    return local ? `Guest ${local.slice(-4)}` : "Unknown";
}

// ── Manual adjustment ─────────────────────────────────────────────────────────
/*
Contributions only started being recorded when this feature shipped, so
everything anyone supplied before that is missing - and for guests there was
never a row at all. These let an admin correct the record by hand.
*/

export interface CreditTarget {
    /** The chat account the credit belongs to. */
    userId: string;
    /** Set when the account resolves to real credentials. */
    docId: string | null;
    label: string;
    identity: ContributorIdentity;
}

/**
 * Work out who a typed target refers to, across every table that might know.
 *
 * Accepts a jid/lid, a phone number, a student id, an email, or a doc id -
 * whatever is to hand. Returns null only when nothing anywhere matches, so the
 * caller can say so rather than silently crediting the wrong person.
 */
export async function resolveCreditTarget(input: string): Promise<CreditTarget | null> {
    const raw = input.trim();
    if (!raw) return null;

    // 1. An account that already has credentials, directly or via a bind alias
    const docId = await resolveOwnDocId(raw);
    if (await exists(docId)) {
        const [c] = await sql<any[]>`
            SELECT student_id, display_name, username, phone_number, hidden, jid
              FROM hi_hive WHERE doc_id = ${docId} LIMIT 1
        `;
        return {
            userId: c?.jid ?? raw,
            docId,
            label: c?.hidden ? "Hidden User" : (c?.display_name ?? c?.student_id ?? docId),
            identity: {
                displayName: c?.display_name ?? null,
                username: c?.username ?? null,
                phoneNumber: c?.phone_number ?? null,
            },
        };
    }

    /*
    2. Credentials found by student id, email, username or phone rather than by
    account. The username match matters more than it looks: WhatsApp's newer
    privacy setting hides a person's phone number from anyone who is not a
    saved contact and shows only their @handle instead, so for a fair number of
    people the handle is the ONLY thing there is to type in.
    */
    const [byField] = await sql<any[]>`
        SELECT doc_id, student_id, display_name, username, phone_number, hidden, jid
          FROM hi_hive
         WHERE student_id = ${raw} OR email = ${raw}
            OR phone_number = ${raw.replace(/\D/g, "")}
            OR username = ${raw.replace(/^@/, "")}
         LIMIT 1
    `;
    if (byField) {
        return {
            userId: byField.jid ?? byField.doc_id,
            docId: byField.doc_id,
            label: byField.hidden ? "Hidden User" : (byField.display_name ?? byField.student_id),
            identity: {
                displayName: byField.display_name ?? null,
                username: byField.username ?? null,
                phoneNumber: byField.phone_number ?? null,
            },
        };
    }

    // 3. An existing guest ledger entry
    const [guest] = await sql<any[]>`
        SELECT user_id, display_name, username, phone_number
          FROM contributors
         WHERE user_id = ${raw} OR phone_number = ${raw.replace(/\D/g, "")}
            OR username = ${raw.replace(/^@/, "")}
         LIMIT 1
    `;
    if (guest) {
        return {
            userId: guest.user_id,
            docId: null,
            label: guest.display_name ?? guest.user_id,
            identity: {
                displayName: guest.display_name, username: guest.username,
                phoneNumber: guest.phone_number,
            },
        };
    }

    /*
    4. Somebody the census has seen but who has never been credited. This is the
    common case for a back-fill: the harvest knows them, the ledger does not.
    DISTINCT ON keeps the most recently seen row when they are in several chats.
    */
    const [member] = await sql<any[]>`
        SELECT DISTINCT ON (user_id) user_id, transport, display_name, username, phone_number
          FROM chat_members
         WHERE user_id = ${raw}
            OR phone_number = ${raw.replace(/\D/g, "")}
            OR username = ${raw.replace(/^@/, "")}
            OR display_name ILIKE ${raw}
         ORDER BY user_id, last_seen DESC
         LIMIT 1
    `;
    if (member) {
        return {
            userId: member.user_id,
            docId: null,
            label: member.display_name ?? member.user_id,
            identity: {
                displayName: member.display_name, username: member.username,
                phoneNumber: member.phone_number,
            },
        };
    }

    return null;
}

export interface CreditChange {
    label: string;
    before: number;
    after: number;
    registered: boolean;
    created: boolean;
}

/**
 * Set or adjust someone's contribution total.
 *
 * `delta` adds (and may be negative); otherwise `value` replaces. The result is
 * clamped at zero - a negative contribution count is not a thing, and letting
 * one exist would corrupt the percentage shares on the leaderboard.
 *
 * Creates a guest ledger entry when the target has none, which is the whole
 * point: back-filling history for people who were never counted.
 */
export async function adjustContribution(
    target: CreditTarget, transport: Transport,
    change: { delta?: number; value?: number }
): Promise<CreditChange> {
    const apply = (before: number): number => {
        const next = change.delta !== undefined ? before + change.delta : (change.value ?? before);
        return Math.max(0, Math.trunc(next));
    };

    if (target.docId) {
        const [row] = await sql<any[]>`
            SELECT contributions FROM hi_hive WHERE doc_id = ${target.docId}
        `;
        const before = Number(row?.contributions ?? 0);
        const after = apply(before);
        await sql`UPDATE hi_hive SET contributions = ${after} WHERE doc_id = ${target.docId}`;
        invalidateCredsCache();
        return { label: target.label, before, after, registered: true, created: false };
    }

    const [existing] = await sql<any[]>`
        SELECT contributions FROM contributors WHERE user_id = ${target.userId}
    `;
    const before = Number(existing?.contributions ?? 0);
    const after = apply(before);

    await sql`
        INSERT INTO contributors
            (user_id, transport, display_name, username, phone_number,
             contributions, first_contributed, last_contributed)
        VALUES (${target.userId}, ${transport}, ${target.identity.displayName ?? null},
                ${target.identity.username ?? null}, ${target.identity.phoneNumber ?? null},
                ${after}, now(), now())
        ON CONFLICT (user_id, transport) DO UPDATE SET
            contributions    = ${after},
            display_name     = COALESCE(contributors.display_name, EXCLUDED.display_name),
            username         = COALESCE(contributors.username, EXCLUDED.username),
            phone_number     = COALESCE(contributors.phone_number, EXCLUDED.phone_number),
            last_contributed = now()
    `;

    return {
        label: target.label, before, after,
        registered: false, created: existing === undefined,
    };
}

// ── Pre-registering a guest ───────────────────────────────────────────────────
/*
A guest row is normally created reactively - the first time someone with no
account scans a QR, or when `credit` back-fills them from the census. Neither
helps for someone the bot has never seen at all: a new group member you already
know by jid but who has not spoken or contributed yet.

createGuest() is the explicit version of the same thing `!test add` does for
real credentials, aimed at the contributors ledger instead: give it a jid and a
name, get a row that future contributions land on and `bind` can later attach
real credentials to - deliberately with no student id or email, because a guest
has not provided any.
*/

export interface GuestResult {
    ok: boolean;
    message: string;
    created?: boolean;
}

export async function createGuest(
    userId: string, transport: Transport, displayName: string
): Promise<GuestResult> {
    const id = userId.trim();
    if (!id) return { ok: false, message: "No jid given." };

    const name = cleanName(displayName);
    if (!name) return { ok: false, message: "Give them a name - it is what the leaderboard will show." };

    // Someone with real credentials is not a guest, whether directly or via a
    // bind alias - creating a shadow entry here would just split their tally
    const docId = await resolveOwnDocId(id);
    if (await exists(docId)) {
        return {
            ok: false,
            message: `\`${id}\` already has registered credentials - use \`bind\` or \`credit\` instead.`,
        };
    }

    const rows = await sql<{ contributions: number; created: boolean }[]>`
        INSERT INTO contributors
            (user_id, transport, display_name, contributions, first_contributed, last_contributed)
        VALUES (${id}, ${transport}, ${name}, 0, now(), now())
        ON CONFLICT (user_id, transport) DO UPDATE SET
            display_name = ${name}
        RETURNING contributions, (xmax = 0) AS created
    `;

    const row = rows[0]!;
    return {
        ok: true,
        created: row.created,
        message: row.created
            ? `👤 Guest created\n🆔 \`${id}\`\n📛 ${name}\n📊 0 QR so far - counted automatically from their next contribution.`
            : `👤 Guest renamed to ${name}\n🆔 \`${id}\`\n📊 ${row.contributions} QR already on record.`,
    };
}
