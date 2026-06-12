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
import { loadCommands, findCommand } from "./loader.js";
import { processMediaDownload } from "./commands/play.js";
import { startBirthdayScheduler } from "./commands/birthday.js";
import { activeSearches, savedPollMessages } from "./memory.js";

async function startBot() {
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

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const phoneNumber = "601118985323";
                console.log(`\n⏳ Requesting pairing code for ${phoneNumber}...`);

                const code = await sock.requestPairingCode(phoneNumber);

                console.log(`\n📱 YOUR PAIRING CODE: ${code}`);
                console.log("➡️ Open WhatsApp > Linked Devices > Link with phone number instead.");
                console.log("➡️ Enter the code above!\n");
            } catch (error) {
                console.log("Failed to request code:", error);
            }
        }, 3000);
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            const fatalCodes = [DisconnectReason.loggedOut, 405, 428, 403];
            const isFatal = fatalCodes.includes(statusCode);

            console.log(`🔴 Connection closed (Reason code: ${statusCode}).`);

            if (isFatal) {
                console.log("🚫 FATAL ERROR: Session invalid. Delete 'auth_info_baileys' and restart.");
                process.exit(1);
            } else {
                console.log("🔄 Reconnecting in 3 seconds...");
                setTimeout(startBot, 3000);
            }
        } else if (connection === "open") {
            console.log("🟢 Bot is online and ready!");
            startBirthdayScheduler(sock);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return;

        const meId = sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined;

        for (const msg of messages) {
            if (!msg.message) continue;

            const msgTime = Number(msg.messageTimestamp);
            const timeDiff = Math.floor(Date.now() / 1000) - msgTime;
            const messageBody = msg.message.ephemeralMessage?.message || msg.message;

            // Poll votes can arrive long after the poll was sent; let them through
            if (!messageBody.pollUpdateMessage && timeDiff > 60) continue;

            // POLL VOTE HANDLER (kept inline - tightly coupled to Baileys)
            if (messageBody.pollUpdateMessage) {
                await handlePollVote(sock, msg, messageBody, meId);
                continue;
            }

            /*
            COMMAND DISPATCH
            Text can live in several places: a plain text message, a reply, or a
            media caption (image/video/document). We check them all so commands
            sent as captions on any media type get picked up.
            */
            const text: string =
                messageBody.conversation ||
                (messageBody.extendedTextMessage as any)?.text ||
                (messageBody.imageMessage as any)?.caption ||
                (messageBody.videoMessage as any)?.caption ||
                (messageBody.documentMessage as any)?.caption ||
                '';

            if (!text) continue;

            const cmd = findCommand(text);
            if (!cmd) continue;

            console.log(`[Command] Dispatching: !${cmd.name}`);

            // Per-command try/catch so one buggy handler can't crash the bot
            try {
                await cmd.handler(sock, msg, text);
            } catch (err) {
                console.error(`❌ Command "!${cmd.name}" threw:`, err);
                if (msg.key.remoteJid) {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `❌ Internal error running \`!${cmd.name}\`. Check server logs.`
                    }, { quoted: msg }).catch(() => { });
                }
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
            // "60198765432@s.whatsapp.net",
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

        /*
        DIAGNOSTIC HARNESS - prints everything and tries every combo.
        Remove this verbose logging once we identify the working combo.
        */
        console.log("---- 🔬 CROSS-ACCOUNT VOTE DEEP DUMP ----");
        console.log("Stored poll key:", JSON.stringify(originalPollMessage.key));
        console.log("Incoming msg key:", JSON.stringify(msg.key));
        console.log("sock.user.id:    ", sock.user?.id);
        console.log("sock.user.lid:   ", (sock.user as any)?.lid);
        console.log("meId (normalized):", meId);
        console.log("realVoterJid:    ", realVoterJid);
        console.log("session.requester:", searchSession.requester);
        console.log("messageSecret length:", pollEncKey.length);
        console.log("vote.encPayload length:", messageBody.pollUpdateMessage.vote?.encPayload?.length);
        console.log("vote.encIv length:     ", messageBody.pollUpdateMessage.vote?.encIv?.length);
        console.log("------------------------------------------");

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
        let successLabel = "";
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
                successLabel = attempt.label;
                console.log(`✅ DECRYPTED via "${attempt.label}"`);
                console.log(`   creator: ${attempt.creator}`);
                console.log(`   voter:   ${attempt.voter}`);
                break;
            } catch (e: any) {
                console.log(`   ❌ ${attempt.label} - creator=${attempt.creator} voter=${attempt.voter}`);
            }
        }

        if (!decryptedVote) {
            console.log("❌ Every combination failed. Paste the deep dump above so we can debug.");
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