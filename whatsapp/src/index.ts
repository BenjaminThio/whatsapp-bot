// Fills in anything shared/.env provides that this bot has not set itself.
import "../../shared/env.js";
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    decryptPollVote,
    getKeyAuthor,
} from "@whiskeysockets/baileys";
import { createHash } from "node:crypto";
import pino from "pino";
import { loadCommands, parseCommand } from "./loader.js";
import { processMediaDownload } from "./commands/play.js";
import { startBirthdayScheduler } from "./commands/birthday.js";
import { activeSearches, savedPollMessages } from "./memory.js";
import { startScheduleService } from "./commands/schedule.js";
import { startHarvester } from "./lib/harvest.js";
import { tryAutoScan } from "./lib/hi-hive/auto-scan.js";
import { startScanBufferService } from "../../shared/hi-hive/scan-buffer-service.js";
import { startWebhookQueue } from "../../shared/webhook/webhook-queue.js";
import { ensureSchema } from "./db/index.js";
import { setSock } from "./lib/current-sock.js";
import { startOutboxService, purgeProcessed, flushOutbox, queueText } from "./lib/outbox.js";
import { buildContext } from "./lib/command-context.js";
import { extractMessageText } from "./lib/wa-text.js";

/*
Disconnect handling
───────────────────
Only these genuinely require deleting auth and re-pairing. Everything else is
transient and must reconnect.

IMPORTANT: 428 (connectionClosed) and 515 (restartRequired) are NOT fatal.
Pairing itself depends on them — after a pairing code is accepted WhatsApp
closes the socket with 515 and expects an immediate reconnect. Treating those
as fatal makes it impossible to ever finish pairing.
*/
const FATAL_CODES = new Set<number>([
    DisconnectReason.loggedOut,           // 401 — session revoked
    DisconnectReason.forbidden,           // 403 — account blocked
    DisconnectReason.badSession,          // 500 — corrupt keys
    DisconnectReason.multideviceMismatch, // 411 — relink required
    405,                                  // connectionFailure — stale session
]);

let reconnectAttempts = 0;
const MAX_BACKOFF_MS = 60_000;

async function startBot() {
    // Create Postgres tables if they don't exist yet
    try {
        await ensureSchema();
    } catch (err) {
        console.error("🐘 Could not ensure Postgres schema:", err);
    }

    await loadCommands();

    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[System] Connecting using WA v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "info" }) as any,
        browser: Browsers.ubuntu('Chrome'),

        getMessage: async (key) => {
            const stored = savedPollMessages.get(key.id!);
            return stored?.message ?? undefined;
        }
    });

    /*
    Publish the socket so background services always send through the LIVE one.
    A reconnect creates a new socket; services that captured the old reference
    would keep failing with 428 Connection Closed until the process restarted.
    */
    setSock(sock);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const phoneNumber = "601118985323";
                console.log(`\n⏳ Requesting pairing code for ${phoneNumber}...`);

                const code = await sock.requestPairingCode(phoneNumber);

                console.log(`\n📱 YOUR PAIRING CODE: ${code}`);
                console.log("➡️ Open WhatsApp > Linked Devices > Link with phone number instead.");
                console.log("➡️ Enter the code above!");
                console.log("➡️ The bot will disconnect with code 515 and reconnect itself — that's normal.\n");
            } catch (error) {
                console.log("Failed to request code:", error);
            }
        }, 3000);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            reconnectAttempts = 0;                 // healthy again
            console.log("🟢 Bot is online and ready!");
            startBirthdayScheduler(sock);
            startScheduleService(sock);
            // One membership sweep, then event-driven refreshes. See lib/harvest.ts.
            startHarvester(sock);
            void startWebhookQueue().catch(err =>
                // Firebase is optional; the rest of the bot must still run
                console.warn("🪝 GitHub webhook queue not started:", err?.message ?? err));
            startScanBufferService(sock);
            startOutboxService();          // drains anything queued while offline
            void flushOutbox();            // deliver backed-off messages at once
            return;
        }

        if (connection !== "close") return;

        const statusCode: number | undefined =
            (lastDisconnect?.error as any)?.output?.statusCode;

        console.log(`🔴 Connection closed (code ${statusCode ?? "unknown"}).`);

        // 515 — expected right after pairing. Reconnect at once, no backoff.
        if (statusCode === DisconnectReason.restartRequired) {
            console.log("🔄 Restart required (normal after pairing) — reconnecting now...");
            setTimeout(startBot, 1000);
            return;
        }

        // 440 — another session took over. Reconnect, but say so loudly: this
        // means the bot is running in two places against the same account.
        if (statusCode === DisconnectReason.connectionReplaced) {
            console.warn("⚠️ Connection replaced — another instance is using this session.");
            console.warn("   Running the bot on both PC and Termux at once will cause this.");
            setTimeout(startBot, 5000);
            return;
        }

        if (statusCode !== undefined && FATAL_CODES.has(statusCode)) {
            console.log("🚫 FATAL: session is invalid.");
            console.log("   Delete the 'auth_info_baileys' folder and restart to re-pair.");
            process.exit(1);
        }

        // Transient — reconnect with capped exponential backoff so an outage
        // doesn't become a reconnect storm.
        reconnectAttempts++;
        const delay = Math.min(3000 * 2 ** (reconnectAttempts - 1), MAX_BACKOFF_MS);
        console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
        setTimeout(startBot, delay);
    });

    // Forget old processed-message ids so the guard table can't grow forever
    setInterval(() => { void purgeProcessed(); }, 6 * 3_600_000);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        const meId = sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined;

        for (const msg of messages) {
            if (!msg.message) continue;

            const msgTime = Number(msg.messageTimestamp);
            const timeDiff = Math.floor(Date.now() / 1000) - msgTime;
            const messageBody = msg.message.ephemeralMessage?.message || msg.message;

            /*
            Freshness window.

            On reconnect WhatsApp redelivers messages the bot missed. A flat
            60-second cutoff threw those away — so a QR posted while the bot was
            down was discarded before the scanner ever saw it, which is exactly
            the case we care about.

            Images get a much longer window because an attendance QR stays valid
            for its class period. Nothing is trusted blindly: the QR's own expiry
            pre-check still runs, the portal rejects a stale QR itself, and the
            persistent duplicate guard stops anything being scanned twice across
            a restart.

            Commands keep the tight window — replaying an hour-old `!play` on
            reconnect would be surprising rather than helpful.
            */
            const hasImage = !!messageBody.imageMessage;
            const CATCHUP_WINDOW_SEC = Number(process.env["IMAGE_CATCHUP_SEC"] ?? 7200); // 2h
            const maxAgeSec = hasImage ? CATCHUP_WINDOW_SEC : 60;

            // Poll votes can arrive long after the poll was sent; let them through
            if (!messageBody.pollUpdateMessage && timeDiff > maxAgeSec) continue;

            if (hasImage && timeDiff > 60) {
                console.log(`[System] Catching up on an image from ${Math.round(timeDiff / 60)} min ago.`);
            }

            // POLL VOTE HANDLER (kept inline - tightly coupled to Baileys)
            if (messageBody.pollUpdateMessage) {
                await handlePollVote(sock, msg, messageBody, meId);
                continue;
            }

            /*
            AUTO-SCAN
            Runs before command dispatch so a bare image (no caption) is still
            inspected. tryAutoScan has its own duplicate-delivery guard, so the
            'notify' + 'append' double delivery above cannot double-scan.
            */
            if (await tryAutoScan(sock, msg)) {
                continue;
            }

            /*
            COMMAND DISPATCH
            Text can live in several places: a plain text message, a reply, or a
            media caption (image/video/document). extractMessageText checks them
            all so commands sent as captions on any media type get picked up.
            */
            const text = extractMessageText(msg);
            if (!text) continue;

            const hit = parseCommand(text);
            if (!hit) continue;

            const { command: cmd, prefix, invoked } = hit;

            const ctx = buildContext({ sock, msg, text, command: cmd, prefix, invoked });
            if (!ctx) {
                console.log(`[Command] ${prefix}${invoked}: could not resolve chat/user - ignoring.`);
                continue;
            }

            console.log(`[Command] Dispatching: ${prefix}${invoked}` +
                (ctx.match ? ` args="${ctx.match.slice(0, 80)}"` : " (no args)"));

            // Central argument gate - handlers no longer repeat this check
            if (cmd.requiresArgs && !ctx.hasArgs) {
                await ctx.sendUsage().catch(() => { });
                continue;
            }

            // Per-command try/catch so one buggy handler can't crash the bot
            try {
                await cmd.handler(sock, msg, text, ctx);
            } catch (err) {
                console.error(`❌ Command "${prefix}${invoked}" threw:`, err);
                await queueText(
                    ctx.chatId,
                    `❌ Internal error running \`${prefix}${invoked}\`. Check server logs.`,
                    { quotedKey: msg.key }
                ).catch(() => { });
            }
        }
    });
}

// Poll vote decryption - the result of our 6-round debugging saga
async function handlePollVote(sock: any, msg: any, messageBody: any, meId?: string) {
    const pollId = messageBody.pollUpdateMessage.pollCreationMessageKey?.id;
    if (!pollId) return;

    console.log(`\n🗳️ [VOTE] Received for Poll ID: ${pollId}`);

    const searchSession = activeSearches.get(pollId);
    const originalPollMessage = savedPollMessages.get(pollId);
    if (!searchSession || !originalPollMessage) {
        console.log("❌ No session/poll in memory.");
        return;
    }

    try {
        // V3 polls put the encryption secret on messageContextInfo.messageSecret
        const rawSecret = originalPollMessage.message?.messageContextInfo?.messageSecret;
        if (!rawSecret) {
            console.log("❌ No messageSecret on stored poll.");
            return;
        }
        const pollEncKey = Buffer.from(rawSecret);

        /*
        Identify the REAL voter for authorization purposes.
        We use msg.key.participant (groups) or msg.key.remoteJid (DMs),
        NOT getKeyAuthor - getKeyAuthor collapses fromMe-style messages
        to the bot's own JID, which would mis-identify family/group votes.
        */
        const realVoterJid = jidNormalizedUser(
            msg.key.participant || msg.key.remoteJid || ""
        );

        /*
        Authorization policy
        Set ALLOWED_VOTERS = "anyone" to let anyone vote.
        Set to "requester" to allow only the person who typed !play (default).
        Set to "whitelist" to allow only specific JIDs (configured below).
        */
        const ALLOWED_VOTERS: "anyone" | "requester" | "whitelist" = "requester";

        // If using "whitelist" mode, put the allowed JIDs here:
        const WHITELIST = new Set<string>([
            // "60123456789@s.whatsapp.net",
        ]);

        let authorized = false;
        if (ALLOWED_VOTERS === "requester") {
            authorized = realVoterJid === searchSession.requester;
        } else if (ALLOWED_VOTERS === "anyone") {
            authorized = true;
        } else if (ALLOWED_VOTERS === "whitelist") {
            authorized = WHITELIST.has(realVoterJid);
        }

        if (!authorized) {
            console.log(`❌ [REJECTED] Voter ${realVoterJid} not allowed (policy: ${ALLOWED_VOTERS}, requester was: ${searchSession.requester})`);
            return;
        }

        const ownJid = jidNormalizedUser(sock.user?.id ?? "");
        const ownLid = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : null;

        // Every plausible JID combination we know of, labeled
        const allAttempts: { label: string; creator: string; voter: string }[] = [
            { label: "A: getKeyAuthor x2",                   creator: getKeyAuthor(originalPollMessage.key, meId), voter: getKeyAuthor(msg.key, meId) },
            { label: "B: ownJid x2",                         creator: ownJid, voter: ownJid },
            { label: "C: ownJid creator, realVoter voter",   creator: ownJid, voter: realVoterJid },
            { label: "D: realVoter x2",                      creator: realVoterJid, voter: realVoterJid },
            { label: "E: remoteJid x2",                      creator: jidNormalizedUser(originalPollMessage.key.remoteJid!), voter: jidNormalizedUser(msg.key.remoteJid!) },
            { label: "F: getKeyAuthor creator, realVoter",   creator: getKeyAuthor(originalPollMessage.key, meId), voter: realVoterJid },
            { label: "G: realVoter creator, getKeyAuthor",   creator: realVoterJid, voter: getKeyAuthor(msg.key, meId) },
        ];

        // If the bot has an LID identity, add LID-based combos too
        if (ownLid) {
            allAttempts.push({ label: "H: ownLid creator, realVoter",  creator: ownLid, voter: realVoterJid });
            allAttempts.push({ label: "I: ownLid x2",                  creator: ownLid, voter: ownLid });
        }

        let decryptedVote: any = null;
        for (const attempt of allAttempts) {
            try {
                decryptedVote = decryptPollVote(
                    messageBody.pollUpdateMessage.vote,
                    {
                        pollCreatorJid: attempt.creator,
                        pollMsgId: pollId,
                        pollEncKey,
                        voterJid: attempt.voter,
                    } as any
                );
                console.log(`✅ DECRYPTED via "${attempt.label}"`);
                break;
            } catch (e: any) {
                console.log(`   ❌ ${attempt.label} - creator=${attempt.creator} voter=${attempt.voter}`);
            }
        }

        if (!decryptedVote) {
            console.log("❌ Every combination failed.");
            return;
        }

        // selectedOptions are SHA-256 hashes of the original option strings
        const selectedHashes = decryptedVote.selectedOptions.map(
            (b: Uint8Array) => Buffer.from(b).toString("hex")
        );

        const optionTitles = Object.keys(searchSession.results);
        const selectedTitle = optionTitles.find(title => {
            const hash = createHash("sha256").update(Buffer.from(title)).digest("hex");
            return selectedHashes.includes(hash);
        });

        if (!selectedTitle) {
            console.log("⚠️ User un-selected their vote.");
            return;
        }

        console.log(`🎯 [SUCCESS] User clicked: "${selectedTitle}"`);
        const selectedUrl = searchSession.results[selectedTitle];

        activeSearches.delete(pollId);
        savedPollMessages.delete(pollId);

        // Try to delete the poll message from the chat (optional, keeps chat tidy)
        try {
            await sock.sendMessage(msg.key.remoteJid, {
                delete: { remoteJid: msg.key.remoteJid, fromMe: true, id: pollId }
            });
        } catch { /* non-fatal */ }

        await processMediaDownload(sock, selectedUrl, msg.key.remoteJid, originalPollMessage);

    } catch (err) {
        console.error("❌ Poll decrypt failed:", err);
    }
}

await startBot();