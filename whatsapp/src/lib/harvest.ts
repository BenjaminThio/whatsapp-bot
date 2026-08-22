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
    upsertChat, replaceMembers, renameMember, setMemberPhone, setMemberUsername,
    unresolvedLids, noteSpoke, type HarvestedMember,
} from "../../../shared/messaging/directory.js";
import { rememberIdentity, cleanName } from "../../../shared/hi-hive/identity.js";

const TRANSPORT = "whatsapp" as const;

/** Wait this long after connecting before the first sweep. */
const INITIAL_DELAY_MS = 8_000;
/** Ignore a refresh for a group touched more recently than this. */
const REFRESH_COOLDOWN_MS = 60_000;
/** How often to retry lids that had no phone number yet. */
const PHONE_RETRY_MS = 15 * 60_000;

const lastHarvest = new Map<string, number>();
let sweeping = false;

export interface HarvestSummary {
    groups: number;
    members: number;
    failed: number;
    /** Members whose lid was resolved to a phone number. */
    phones: number;
}

/**
 * Sweep every participating group.
 *
 * One call to WhatsApp; the rest is database work.
 */
export async function harvestAllGroups(sock: WASocket): Promise<HarvestSummary> {
    if (sweeping) return { groups: 0, members: 0, failed: 0, phones: 0 };
    sweeping = true;

    const summary: HarvestSummary = { groups: 0, members: 0, failed: 0, phones: 0 };

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
                summary.phones += await resolvePhoneNumbers(sock, members);

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

/**
 * Retry phone-number resolution for lids already in the database.
 *
 * The lid -> number table fills up as Baileys decrypts traffic, so a lid that
 * was unresolvable during the first sweep often becomes resolvable hours later
 * without the membership itself having changed. Re-running the whole harvest to
 * pick those up would refetch every group for nothing; this reads the ids we
 * already have and asks the local store again.
 */
export async function resolvePendingPhones(sock: WASocket): Promise<number> {
    const store = (sock as any)?.signalRepository?.lidMapping;
    if (!store?.getPNForLID) return 0;

    const pending = await unresolvedLids(TRANSPORT);
    let resolved = 0;

    for (const lid of pending) {
        try {
            const digits = normalisePhone(await store.getPNForLID(lid));
            if (!digits) continue;
            await setMemberPhone(lid, TRANSPORT, digits);
            resolved++;
        } catch { /* still unknown */ }
    }
    return resolved;
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
        await resolvePhoneNumbers(sock, members);

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
            displayName: cleanName(p?.name ?? p?.notify ?? p?.verifiedName),
            // The @handle is a separate field from the display name, and is
            // often present when the name is not
            username: cleanHandle(p?.username),
            /*
            A participant IS a Contact, so it may already carry the phone-number
            form alongside the lid. Free when present, and the only field here
            that makes an unnamed member recognisable.
            */
            phoneNumber: normalisePhone(p?.phoneNumber ?? (isPhoneJid(id) ? id : null)),
            // Baileys reports "admin" | "superadmin" | null
            isAdmin: p?.admin === "admin" || p?.admin === "superadmin",
        });
    }
    return out;
}

const isPhoneJid = (id: string): boolean => id.endsWith("@s.whatsapp.net");

/** Strip a leading @ and validate. Null when there is nothing usable. */
function cleanHandle(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const h = String(raw).trim().replace(/^@+/, "");
    return /^[A-Za-z0-9._-]{2,64}$/.test(h) ? h : null;
}

/**
 * Bare digits from a phone jid or raw number. Null when there is nothing usable.
 *
 * REFUSES an "@lid" input. A lid is also a long run of digits, so stripping
 * non-digits from one yields something that looks exactly like a phone number
 * and is not - storing that would put a fabricated number next to someone's
 * name and make it impossible to tell resolved rows from unresolved ones.
 */
function normalisePhone(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const str = String(raw);
    if (str.includes("@lid")) return null;

    const digits = str.split("@")[0]!.split(":")[0]!.replace(/\D/g, "");
    // Shorter than this is not a dialable number, it is a truncated id
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * Fill in phone numbers for members WhatsApp only gave us a lid for.
 *
 * Baileys keeps its own lid -> phone-number table, populated as it decrypts
 * traffic. Reading it costs nothing and sends nothing. It will not know every
 * lid - the ones it has never seen a message from stay unresolved - so this is
 * best-effort and runs after the membership write rather than blocking it.
 */
async function resolvePhoneNumbers(sock: WASocket, members: HarvestedMember[]): Promise<number> {
    const store = (sock as any)?.signalRepository?.lidMapping;
    if (!store?.getPNForLID) return 0;

    let resolved = 0;
    for (const m of members) {
        if (m.phoneNumber || !m.userId.endsWith("@lid")) continue;
        try {
            const pn = await store.getPNForLID(m.userId);
            const digits = normalisePhone(pn);
            if (!digits) continue;
            m.phoneNumber = digits;
            await setMemberPhone(m.userId, TRANSPORT, digits);
            resolved++;
        } catch {
            // A lid the store has never seen simply stays unresolved
        }
    }
    return resolved;
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
    const name = cleanName(contact?.name ?? contact?.notify ?? contact?.verifiedName);
    const handle = cleanHandle(contact?.username);
    const phone = normalisePhone(contact?.phoneNumber ?? contact?.id);

    const ids = new Set<string>(
        [contact?.id, contact?.lid, contact?.phoneNumber].filter(Boolean)
    );
    if (ids.size === 0) return;

    for (const id of ids) {
        if (name) {
            await renameMember(id, "whatsapp", name).catch(() => {});
            // hi_hive only updates a row that already exists - seeing a
            // contact's name is not grounds to create credentials for them
            void rememberIdentity(id, name);
        }
        // A contact event often carries the number or handle even when it
        // carries no name, and either alone makes the row recognisable
        if (handle) await setMemberUsername(id, "whatsapp", handle).catch(() => {});
        if (phone) await setMemberPhone(id, "whatsapp", phone).catch(() => {});
    }
}

/**
 * Record the sender of any message the bot sees.
 *
 * This is the widest name source there is on WhatsApp. Every message in every
 * group the bot is in arrives with `pushName` - the name that person chose for
 * themselves - and with the sender's id. Nothing is requested and nothing is
 * sent; the bot is simply in the room.
 *
 * It matters because the group member list does NOT carry names: a harvest
 * gives ids, and this fills in who they are as people talk. Called for every
 * message regardless of age or type, since a name is equally true whether the
 * message was a command, an image, or something the bot ignores.
 */
export async function noteMessageSender(msg: any): Promise<void> {
    const chatId: string | undefined = msg?.key?.remoteJid;
    if (!chatId || chatId === "status@broadcast") return;

    // In a group the individual is `participant`; in a DM the chat IS them
    const isGroup = chatId.endsWith("@g.us");
    const userId: string | undefined = isGroup ? msg?.key?.participant : chatId;
    if (!userId) return;

    // The bot's own messages say nothing useful about anyone else
    if (msg?.key?.fromMe) return;

    const name = cleanName(msg?.pushName);
    if (!isGroup) {
        // A DM is itself evidence of a chat the census does not otherwise see
        await noteSpoke(chatId, userId, TRANSPORT, name).catch(() => {});
        return;
    }

    /*
    In a group, only touch a row that already exists - the harvest owns
    membership there. Writing one here would resurrect someone who has left,
    since replaceMembers() deletes exactly the rows a harvest did not report.
    */
    if (name) await renameMember(userId, TRANSPORT, name).catch(() => {});
    void rememberIdentity(userId, name);
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
                console.log(`📇 Directory: ${s.members} member(s) across ${s.groups} group(s), ` +
                            `${s.phones} phone number(s) resolved` +
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

    /*
    Retry unresolved lids on a slow timer. Purely local - it re-reads Baileys'
    own mapping store, which keeps filling as traffic is decrypted, and sends
    nothing to WhatsApp.
    */
    setInterval(() => {
        void resolvePendingPhones(sock).then(n => {
            if (n > 0) console.log(`📇 Resolved ${n} more phone number(s).`);
        });
    }, PHONE_RETRY_MS);

    /*
    Every message, from anyone, anywhere the bot can see. By far the widest
    source of names - see noteMessageSender().
    */
    sock.ev.on("messages.upsert", ({ messages }: any) => {
        for (const m of messages ?? []) void noteMessageSender(m);
    });

    // Names arriving over time - see applyContactName() for why this matters
    sock.ev.on("contacts.upsert", (contacts: any[]) => {
        for (const c of contacts ?? []) void applyContactName(c);
    });
    sock.ev.on("contacts.update", (contacts: any[]) => {
        for (const c of contacts ?? []) void applyContactName(c);
    });
}
