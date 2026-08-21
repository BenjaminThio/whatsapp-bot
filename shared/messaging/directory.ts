/**
 * directory.ts - the chat census, and the queries the viewer runs over it.
 *
 * Writes come from two places:
 *   • a harvest, where WhatsApp hands over full group membership in one call
 *   • ordinary messages, where each one carries a sender and a display name
 *
 * Neither contacts anybody. See shared/hi-hive/identity.ts for the full list of
 * what each platform gives you for free.
 *
 * Deliberately separate from hi_hive: that table is credentials people chose to
 * register, this is everyone the bot shares a room with. Keeping them apart
 * means clearing the census never touches an account.
 */

import sql from "../db/index.js";

export type Transport = "whatsapp" | "telegram";

export interface ChatRow {
    chatId: string;
    transport: string;
    kind: string;
    name: string | null;
    memberCount: number;
    updatedAt: string;
}

export interface MemberRow {
    chatId: string;
    userId: string;
    transport: string;
    displayName: string | null;
    isAdmin: boolean;
    firstSeen: string;
    lastSeen: string;
    lastSpoke: string | null;
}

export interface HarvestedMember {
    userId: string;
    displayName?: string | null;
    isAdmin?: boolean;
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Record a chat's identity. Safe to call repeatedly. */
export async function upsertChat(
    chatId: string, transport: Transport,
    info: { kind?: string; name?: string | null; description?: string | null; memberCount?: number } = {}
): Promise<void> {
    await sql`
        INSERT INTO chats (chat_id, transport, kind, name, description, member_count, updated_at)
        VALUES (${chatId}, ${transport}, ${info.kind ?? "group"}, ${info.name ?? null},
                ${info.description ?? null}, ${info.memberCount ?? 0}, now())
        ON CONFLICT (chat_id, transport) DO UPDATE SET
            kind         = COALESCE(EXCLUDED.kind, chats.kind),
            name         = COALESCE(EXCLUDED.name, chats.name),
            description  = COALESCE(EXCLUDED.description, chats.description),
            member_count = GREATEST(EXCLUDED.member_count, 0),
            updated_at   = now()
    `;
}

/**
 * Replace a chat's membership with what the platform just reported.
 *
 * A plain upsert would leave people who have since left listed forever, so
 * anyone absent from this snapshot is removed. first_seen is preserved on
 * conflict: it is the one column that must survive a re-harvest, or every
 * refresh would claim everybody joined today.
 */
export async function replaceMembers(
    chatId: string, transport: Transport, members: HarvestedMember[]
): Promise<{ added: number; removed: number }> {
    if (members.length === 0) return { added: 0, removed: 0 };

    return sql.begin(async trx => {
        const ids = members.map(m => m.userId);

        for (const m of members) {
            await trx`
                INSERT INTO chat_members
                    (chat_id, user_id, transport, display_name, is_admin, first_seen, last_seen)
                VALUES (${chatId}, ${m.userId}, ${transport}, ${m.displayName ?? null},
                        ${m.isAdmin ?? false}, now(), now())
                ON CONFLICT (chat_id, user_id, transport) DO UPDATE SET
                    display_name = COALESCE(EXCLUDED.display_name, chat_members.display_name),
                    is_admin     = EXCLUDED.is_admin,
                    last_seen    = now()
            `;
        }

        const gone = await trx<{ user_id: string }[]>`
            DELETE FROM chat_members
             WHERE chat_id = ${chatId} AND transport = ${transport}
               AND user_id <> ALL(${ids})
            RETURNING user_id
        `;

        await trx`
            UPDATE chats SET member_count = ${members.length}, updated_at = now()
             WHERE chat_id = ${chatId} AND transport = ${transport}
        `;

        return { added: members.length, removed: gone.length };
    });
}

/**
 * Note that someone spoke.
 *
 * Telegram cannot enumerate a group through the Bot API, so there this is the
 * only source of membership at all - which is why it inserts rather than only
 * updating.
 */
export async function noteSpoke(
    chatId: string, userId: string, transport: Transport,
    displayName?: string | null, chatName?: string | null
): Promise<void> {
    if (!chatId || !userId) return;

    await sql`
        INSERT INTO chats (chat_id, transport, kind, name, updated_at)
        VALUES (${chatId}, ${transport}, ${chatId.includes("@g.us") || Number(chatId) < 0 ? "group" : "dm"},
                ${chatName ?? null}, now())
        ON CONFLICT (chat_id, transport) DO UPDATE SET
            name = COALESCE(EXCLUDED.name, chats.name), updated_at = now()
    `;

    const inserted = await sql`
        INSERT INTO chat_members
            (chat_id, user_id, transport, display_name, first_seen, last_seen, last_spoke)
        VALUES (${chatId}, ${userId}, ${transport}, ${displayName ?? null}, now(), now(), now())
        ON CONFLICT (chat_id, user_id, transport) DO UPDATE SET
            display_name = COALESCE(EXCLUDED.display_name, chat_members.display_name),
            last_seen    = now(),
            last_spoke   = now()
        RETURNING (xmax = 0) AS is_new
    `;

    /*
    member_count is denormalised so the overview does not run a count per chat,
    which means it has to be maintained here too. Only on a genuine insert:
    recounting on every message would be a scan per message, and on Telegram -
    where speaking is the ONLY way anyone is ever recorded - the count would
    otherwise stay at zero forever.

    xmax = 0 distinguishes an insert from an ON CONFLICT update.
    */
    if (inserted[0]?.["is_new"]) {
        await sql`
            UPDATE chats SET member_count = (
                SELECT count(*) FROM chat_members
                 WHERE chat_id = ${chatId} AND transport = ${transport}
            ) WHERE chat_id = ${chatId} AND transport = ${transport}
        `;
    }
}

/** Forget one chat, or everything. The census only; hi_hive is untouched. */
export async function forgetChat(chatId: string, transport: Transport): Promise<number> {
    const r = await sql`
        DELETE FROM chat_members WHERE chat_id = ${chatId} AND transport = ${transport}
        RETURNING user_id
    `;
    await sql`DELETE FROM chats WHERE chat_id = ${chatId} AND transport = ${transport}`;
    return r.length;
}

// ── Reads, for the viewer ─────────────────────────────────────────────────────

export interface Overview {
    chats: number;
    groups: number;
    people: number;
    memberships: number;
    registered: number;
    byTransport: { transport: string; chats: number; people: number }[];
}

/** Headline counts for the top of the viewer. */
export async function overview(): Promise<Overview> {
    const [totals] = await sql<{ chats: number; groups: number; people: number; memberships: number }[]>`
        SELECT
            (SELECT count(*)::int FROM chats)                          AS chats,
            (SELECT count(*)::int FROM chats WHERE kind = 'group')     AS groups,
            (SELECT count(DISTINCT user_id)::int FROM chat_members)    AS people,
            (SELECT count(*)::int FROM chat_members)                   AS memberships
    `;

    // How many of the people we can see have actually registered credentials
    const [reg] = await sql<{ n: number }[]>`
        SELECT count(DISTINCT m.user_id)::int AS n
          FROM chat_members m
         WHERE EXISTS (SELECT 1 FROM hi_hive h WHERE h.doc_id = m.user_id OR h.jid = m.user_id)
            OR EXISTS (SELECT 1 FROM hi_hive_alias a WHERE a.alias_id = m.user_id)
    `;

    const byTransport = await sql<{ transport: string; chats: number; people: number }[]>`
        SELECT c.transport,
               count(DISTINCT c.chat_id)::int  AS chats,
               count(DISTINCT m.user_id)::int  AS people
          FROM chats c
          LEFT JOIN chat_members m ON m.chat_id = c.chat_id AND m.transport = c.transport
         GROUP BY c.transport ORDER BY c.transport
    `;

    return {
        chats: totals?.chats ?? 0,
        groups: totals?.groups ?? 0,
        people: totals?.people ?? 0,
        memberships: totals?.memberships ?? 0,
        registered: reg?.n ?? 0,
        byTransport,
    };
}

/** Every chat, biggest first. */
export async function listChats(): Promise<ChatRow[]> {
    const rows = await sql<any[]>`
        SELECT chat_id, transport, kind, name, member_count, updated_at
          FROM chats ORDER BY member_count DESC, name NULLS LAST
    `;
    return rows.map(r => ({
        chatId: r.chat_id, transport: r.transport, kind: r.kind,
        name: r.name, memberCount: r.member_count, updatedAt: r.updated_at,
    }));
}

export interface MemberDetail extends MemberRow {
    /** Their hi_hive student id, when they have registered. */
    studentId: string | null;
    hidden: boolean;
    contributions: number;
    /** How many of the bot's chats they are in. */
    chatCount: number;
}

/** Everyone in one chat, with whatever hi_hive knows about them. */
export async function membersOf(chatId: string, transport: string): Promise<MemberDetail[]> {
    const rows = await sql<any[]>`
        SELECT m.*,
               h.student_id, h.hidden, h.contributions,
               (SELECT count(*)::int FROM chat_members x WHERE x.user_id = m.user_id) AS chat_count
          FROM chat_members m
          LEFT JOIN hi_hive h
                 ON h.doc_id = m.user_id
                 OR h.jid    = m.user_id
                 OR h.doc_id = (SELECT doc_id FROM hi_hive_alias a WHERE a.alias_id = m.user_id)
         WHERE m.chat_id = ${chatId} AND m.transport = ${transport}
         ORDER BY m.is_admin DESC, COALESCE(m.display_name, m.user_id)
    `;
    return rows.map(mapMember);
}

/** Everyone the bot can see, across all chats. */
export async function listPeople(search = "", limit = 500): Promise<MemberDetail[]> {
    const like = `%${search}%`;
    const rows = await sql<any[]>`
        SELECT DISTINCT ON (m.user_id) m.*,
               h.student_id, h.hidden, h.contributions,
               (SELECT count(*)::int FROM chat_members x WHERE x.user_id = m.user_id) AS chat_count
          FROM chat_members m
          LEFT JOIN hi_hive h
                 ON h.doc_id = m.user_id
                 OR h.jid    = m.user_id
                 OR h.doc_id = (SELECT doc_id FROM hi_hive_alias a WHERE a.alias_id = m.user_id)
         WHERE ${search === "" ? sql`TRUE` : sql`
               (m.user_id ILIKE ${like} OR m.display_name ILIKE ${like}
                OR h.student_id ILIKE ${like})`}
         ORDER BY m.user_id, m.last_seen DESC
         LIMIT ${limit}
    `;
    return rows.map(mapMember).sort((a, b) =>
        b.chatCount - a.chatCount ||
        (a.displayName ?? a.userId).localeCompare(b.displayName ?? b.userId));
}

/** Which chats one person is in. */
export async function chatsOf(userId: string): Promise<ChatRow[]> {
    const rows = await sql<any[]>`
        SELECT c.chat_id, c.transport, c.kind, c.name, c.member_count, c.updated_at
          FROM chat_members m
          JOIN chats c ON c.chat_id = m.chat_id AND c.transport = m.transport
         WHERE m.user_id = ${userId}
         ORDER BY c.member_count DESC
    `;
    return rows.map(r => ({
        chatId: r.chat_id, transport: r.transport, kind: r.kind,
        name: r.name, memberCount: r.member_count, updatedAt: r.updated_at,
    }));
}

function mapMember(r: any): MemberDetail {
    return {
        chatId: r.chat_id,
        userId: r.user_id,
        transport: r.transport,
        displayName: r.display_name,
        isAdmin: r.is_admin,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
        lastSpoke: r.last_spoke,
        studentId: r.student_id ?? null,
        hidden: r.hidden ?? false,
        contributions: Number(r.contributions ?? 0),
        chatCount: Number(r.chat_count ?? 0),
    };
}
