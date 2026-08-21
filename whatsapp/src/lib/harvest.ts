/**
 * harvest.ts - record who is in the groups this bot belongs to.
 *
 * `sock.groupFetchAllParticipating()` returns every group the account is in,
 * with the full participant list for each, in ONE request. No message is sent
 * and nobody is contacted - it is the same data WhatsApp already gave the
 * client to render the group list.
 *
 * That makes it the only broad source of ids on WhatsApp. Everything else
 * (pushName, quoted senders, mentions) tells you about one person at a time,
 * and only once they have done something.
 *
 * Two things worth being deliberate about:
 *
 *   1. This writes rows for people who never interacted with the bot. That is
 *      the point, but it is also why the census lives in its own tables rather
 *      than in hi_hive - clearing it never touches anyone's credentials.
 *
 *   2. It runs ONCE on connect, then only in response to change events. Polling
 *      a full membership fetch on a phone is wasteful, and WhatsApp rate-limits
 *      it: a burst of them on a flaky connection is a good way to get the
 *      session throttled.
 */

import type { WASocket } from "@whiskeysockets/baileys";
import {
    upsertChat, replaceMembers, renameMember, type HarvestedMember,
} from "../../../shared/messaging/directory.js";
import { rememberIdentity, cleanName } from "../../../shared/hi-hive/identity.js";

const TRANSPORT = "whatsapp" as const;

/** Wait this long after connecting before the first sweep. */
const INITIAL_DELAY_MS = 8_000;
/** Ignore a refresh for a group touched more recently than this. */
const REFRESH_COOLDOWN_MS = 60_000;

const lastHarvest = new Map<string, number>();
let sweeping = false;

export interface HarvestSummary {
    groups: number;
    members: number;
    failed: number;
}

/**
 * Sweep every participating group.
 *
 * One call to WhatsApp; the rest is database work.
 */
export async function harvestAllGroups(sock: WASocket): Promise<HarvestSummary> {
    if (sweeping) return { groups: 0, members: 0, failed: 0 };
    sweeping = true;

    const summary: HarvestSummary = { groups: 0, members: 0, failed: 0 };

    try {
        const all = await sock.groupFetchAllParticipating();

        for (const [jid, meta] of Object.entries(all)) {
            try {
                const members = participantsOf(meta);

                await upsertChat(jid, TRANSPORT, {
                    kind: "group",
                    name: meta.subject ?? null,
                    description: (meta as any).desc ?? null,
                    memberCount: members.length,
                });
                await replaceMembers(jid, TRANSPORT, members);

                lastHarvest.set(jid, Date.now());
                summary.groups++;
                summary.members += members.length;
            } catch (err) {
                // One unreadable group must not abandon the rest
                summary.failed++;
                console.error(`📇 Harvest failed for ${jid}:`, err instanceof Error ? err.message : err);
            }
        }
    } catch (err) {
        console.error("📇 Could not fetch groups:", err instanceof Error ? err.message : err);
    } finally {
        sweeping = false;
    }

    return summary;
}

/** Re-read one group, unless it was just done. */
export async function harvestGroup(sock: WASocket, jid: string, force = false): Promise<number> {
    const last = lastHarvest.get(jid) ?? 0;
    if (!force && Date.now() - last < REFRESH_COOLDOWN_MS) return 0;

    try {
        const meta = await sock.groupMetadata(jid);
        const members = participantsOf(meta);

        await upsertChat(jid, TRANSPORT, {
            kind: "group",
            name: meta.subject ?? null,
            description: (meta as any).desc ?? null,
            memberCount: members.length,
        });
        await replaceMembers(jid, TRANSPORT, members);

        lastHarvest.set(jid, Date.now());
        return members.length;
    } catch (err) {
        console.error(`📇 Harvest failed for ${jid}:`, err instanceof Error ? err.message : err);
        return 0;
    }
}

/*
Baileys has changed the participant shape across versions, and a group can
report a member with an id but no name. Take whichever id field is present and
skip anything without one rather than writing a row keyed by undefined.

A participant is `Contact & { isAdmin, admin, ... }`. Contact.name is "the name
you have saved for them"; Contact.notify is "the name they broadcast about
themselves". Both come from Baileys' contact store, which is built from a
history/contact sync and from pushNames seen on past messages - NOT from the
group member list itself. For an @lid participant especially, that store is
frequently empty, so most members come back with an id and nothing else. That
gap is what applyContactName() below closes as names arrive later.
*/
function participantsOf(meta: any): HarvestedMember[] {
    const list: any[] = Array.isArray(meta?.participants) ? meta.participants : [];
    const out: HarvestedMember[] = [];

    for (const p of list) {
        const id: string | undefined = p?.id ?? p?.jid ?? p?.lid;
        if (!id) continue;
        out.push({
            userId: id,
            displayName: cleanName(p?.name ?? p?.notify),
            // Baileys reports "admin" | "superadmin" | null
            isAdmin: p?.admin === "admin" || p?.admin === "superadmin",
        });
    }
    return out;
}

/*
Learn a name from Baileys' own contact events, and apply it everywhere that
person is known - not just in the one chat being harvested.

`contacts.upsert` fires with a batch during the initial sync; `contacts.update`
fires one at a time as WhatsApp tells the socket about someone, including from
a pushName on a message the bot merely receives in a shared group. Neither
requires the bot to send anything, and neither is limited to people who have
addressed the bot directly - which is why this catches far more people over
time than the passive per-message capture in identity.ts alone.

The same human can appear under more than one id: `contact.id` is whichever
form WhatsApp currently prefers, `contact.lid` and `contact.phoneNumber` are
the others when known. Writing the name to every id present is what lets a bare
`@lid` row that was harvested with no name at all pick one up once the socket
learns who that lid actually belongs to.
*/
async function applyContactName(contact: any): Promise<void> {
    const name = cleanName(contact?.name ?? contact?.notify);
    if (!name) return;

    const ids = new Set<string>(
        [contact?.id, contact?.lid, contact?.phoneNumber].filter(Boolean)
    );
    for (const id of ids) {
        await renameMember(id, "whatsapp", name).catch(() => {});
        // hi_hive only updates a row that already exists - seeing a contact's
        // name is not grounds to create credentials for them
        void rememberIdentity(id, name);
    }
}

/**
 * Start harvesting: one sweep shortly after connecting, then react to changes.
 *
 * The delay lets the socket finish its initial sync first; asking immediately
 * on "open" tends to return an empty or partial list.
 */
export function startHarvester(sock: WASocket): void {
    setTimeout(() => {
        void harvestAllGroups(sock).then(s => {
            if (s.groups > 0) {
                console.log(`📇 Directory: ${s.members} member(s) across ${s.groups} group(s)` +
                            `${s.failed > 0 ? `, ${s.failed} failed` : ""}.`);
            }
        });
    }, INITIAL_DELAY_MS);

    // Someone joined or left - refresh just that group
    sock.ev.on("group-participants.update", (ev: any) => {
        if (ev?.id) void harvestGroup(sock, ev.id, true);
    });

    // Subject or description changed
    sock.ev.on("groups.update", (updates: any[]) => {
        for (const u of updates ?? []) {
            if (u?.id) void harvestGroup(sock, u.id);
        }
    });

    // Names arriving over time - see applyContactName() for why this matters
    sock.ev.on("contacts.upsert", (contacts: any[]) => {
        for (const c of contacts ?? []) void applyContactName(c);
    });
    sock.ev.on("contacts.update", (contacts: any[]) => {
        for (const c of contacts ?? []) void applyContactName(c);
    });
}
