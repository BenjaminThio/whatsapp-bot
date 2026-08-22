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
