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
import { upsertChat, replaceMembers, type HarvestedMember } from "../../../shared/messaging/directory.js";

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
*/
function participantsOf(meta: any): HarvestedMember[] {
    const list: any[] = Array.isArray(meta?.participants) ? meta.participants : [];
    const out: HarvestedMember[] = [];

    for (const p of list) {
        const id: string | undefined = p?.id ?? p?.jid ?? p?.lid;
        if (!id) continue;
        out.push({
            userId: id,
            displayName: p?.name ?? p?.notify ?? p?.subject ?? null,
            // Baileys reports "admin" | "superadmin" | null
            isAdmin: p?.admin === "admin" || p?.admin === "superadmin",
        });
    }
    return out;
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
}
