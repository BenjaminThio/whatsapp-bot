import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadContentFromMessage } from "@whiskeysockets/baileys";
import pino from "pino";
import { readBarcodes, writeBarcode } from 'zxing-wasm';

import { spawn } from "node:child_process";
import path from "node:path";

interface MusicInfo {
    status: "success" | "error";
    title: string | null;
    duration: number | null;
    url: string;
    ext: string | null;
    abr: string | null;
    mimeType: string | null;
    message?: string;
}

const getMusicInfo = (url: string): Promise<MusicInfo> => 
    new Promise((resolve, reject) => {
        const exePath = path.join(import.meta.dir, "./music.exe");
        const worker = spawn(exePath, [url]);

        let err = "";
        let out = "";

        worker.stderr.on("data", (d) => (err += d.toString("utf8")));
        worker.stdout.on("data", (d) => (out += d.toString("utf8")));

        worker.on("error", reject);
        worker.on("close", (code) => {
            if (code !== 0) return reject(err || "Process exited with error code");
            try {
                resolve(JSON.parse(out));
            } catch (e) {
                reject("Failed to parse JSON output: " + out);
            }
        });
    });

async function createQR(link: string): Promise<Blob | null> {
    try {
        const writeResult = await writeBarcode(link, {
            format: "QRCode",
            scale: 3,
            addQuietZones: true
        });

        return writeResult.image; 
    } catch (error) {
        console.error("Failed to generate:", error);
        throw error;
    }
}

async function scanQR(imageInput: File | Blob | ArrayBuffer | Uint8Array): Promise<string | null> {
    try {
        const readResults = await readBarcodes(imageInput, {
            tryHarder: true,
            formats: ["QRCode"],
            maxNumberOfSymbols: 1
        });

        if (readResults.length > 0) {
            return readResults[0].text;
        }
        return null;
    } catch (error) {
        console.error("Failed to read:", error);
        return null;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[System] Connecting using WA v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }) as any,
        browser: Browsers.ubuntu('Chrome')
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const phoneNumber = "601118985323"; 
                console.log(`\n⏳ Requesting pairing code for ${phoneNumber}...`);
                
                const code = await sock.requestPairingCode(phoneNumber);
                
                console.log(`\n📱 YOUR PAIRING CODE: ${code}`);
                console.log("➡️ Open WhatsApp on your phone.");
                console.log("➡️ Go to Linked Devices > Link a device.");
                console.log("➡️ Tap 'Link with phone number instead'.");
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
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages) {
            
            if (!msg.message) continue;

            const messageBody = msg.message.ephemeralMessage?.message || msg.message;

            const text: string = 
                messageBody.conversation || 
                messageBody.extendedTextMessage?.text || 
                messageBody.imageMessage?.caption || 
                '';

            if (text) {
                console.log(`[Message Received] Extracted Text: "${text}"`);
            }

            if (text.toLowerCase() === "!start") {
                console.log("✅ !start command triggered!");
                if (msg.key.remoteJid) {
                    await sock.sendMessage(msg.key.remoteJid, { text: "Hello Mum!" });
                }
            }
            else if (text.toLowerCase() === "!scan") {
                if (!msg.key.remoteJid) continue;
                
                console.log("🔍 !scan command triggered!");

                const imageMessage = messageBody.imageMessage || messageBody.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

                if (!imageMessage) {
                    await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Please reply to an image with '!scan'." }, { quoted: msg });
                    continue; 
                }
                if (!imageMessage.url && !imageMessage.directPath) {
                    console.log("⚠️ Image missing URL (Sync delay).");
                    await sock.sendMessage(
                        msg.key.remoteJid, 
                        { text: "⏳ WhatsApp is still processing this image on their servers. Please wait 3 seconds and try again!" }, 
                        { quoted: msg }
                    );
                    continue;
                }

                try {
                    await sock.sendMessage(msg.key.remoteJid, { text: "⏳ Scanning and enhancing..." }, { quoted: msg });
                    console.log("📥 Downloading encrypted image...");

                    const stream = await downloadContentFromMessage(imageMessage, 'image');
                    let buffer = Buffer.from([]);
                    for await (const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }

                    console.log("🧩 Passing buffer to zxing-wasm...");
                    const extractedLink = await scanQR(buffer);

                    if (!extractedLink) {
                        console.log("❌ Scan failed: No barcode found.");
                        await sock.sendMessage(msg.key.remoteJid, { text: "❌ No valid QR code detected. WhatsApp compression might have blurred it!" });
                        continue;
                    }

                    console.log(`✅ Found link: ${extractedLink} | Generating new QR...`);
                    const newQrBlob = await createQR(extractedLink);
                    
                    if (!newQrBlob) {
                        throw new Error("createQR returned null");
                    }

                    const arrayBuffer = await newQrBlob.arrayBuffer();
                    const finalImageBuffer = Buffer.from(arrayBuffer);

                    console.log("📤 Sending enhanced QR back to chat...");
                    await sock.sendMessage(
                        msg.key.remoteJid, 
                        { 
                            image: finalImageBuffer, 
                            caption: `✅ *QR Scanned Successfully*\n\n🔗 *Link:* ${extractedLink}`,
                            mimetype: "image/png" 
                        }, 
                        { quoted: msg } 
                    );
                    
                    console.log("✨ Done!");

                } catch (error) {
                    console.error("Error processing QR:", error);
                    await sock.sendMessage(msg.key.remoteJid, { text: "❌ An internal error occurred while processing the QR code." }, { quoted: msg });
                }
            }
            else if (text.toLowerCase().startsWith("!play ")) {
                if (!msg.key.remoteJid) continue;

                const targetUrl = text.slice(6).trim();

                if (!targetUrl) {
                    await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Please provide a link! Example: *!play https://...*" }, { quoted: msg });
                    continue;
                }

                try {
                    await sock.sendMessage(msg.key.remoteJid, { text: "⏳ Fetching media link..." }, { quoted: msg });
                    
                    console.log(`🎵 Running music.exe for: ${targetUrl}`);
                    const musicInfo = await getMusicInfo(targetUrl);

                    if (musicInfo.status === "error" || !musicInfo.url) {
                        await sock.sendMessage(msg.key.remoteJid, { text: `❌ Failed to fetch media: ${musicInfo.message || 'Unknown error'}` }, { quoted: msg });
                        continue;
                    }

                    console.log(`📤 Sending video: ${musicInfo.title}`);

                    await sock.sendMessage(
                        msg.key.remoteJid, 
                        { 
                            video: { url: musicInfo.url }, 
                            caption: musicInfo.title || "🎵 Here is your media!"
                        }, 
                        { quoted: msg }
                    );

                    console.log("✨ Video sent successfully!");

                } catch (error) {
                    console.error("Play command error:", error);
                    await sock.sendMessage(msg.key.remoteJid, { text: "❌ An internal error occurred while running the extractor." }, { quoted: msg });
                }
            }
        }
    });
}

await startBot();