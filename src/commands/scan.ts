import { WAMessage, downloadContentFromMessage } from "@whiskeysockets/baileys";
import { readBarcodes, writeBarcode } from "zxing-wasm";
import { Command } from "./_types.js";

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
        if (readResults.length > 0) return readResults[0].text;
        return null;
    } catch (error) {
        console.error("Failed to read:", error);
        return null;
    }
}

async function handleScan(sock: any, msg: WAMessage, _text: string) {
    if (!msg.key.remoteJid) return;

    console.log("🔍 !scan command triggered!");

    // Pull messageBody fresh from the message
    const messageBody = msg.message?.ephemeralMessage?.message || msg.message;
    if (!messageBody) return;

    const imageMessage = (messageBody as any).imageMessage
        || (messageBody as any).extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

    if (!imageMessage) {
        await sock.sendMessage(msg.key.remoteJid, { text: "⚠️ Please reply to an image with '!scan'." }, { quoted: msg });
        return;
    }
    if (!imageMessage.url && !imageMessage.directPath) {
        await sock.sendMessage(msg.key.remoteJid, { text: "⏳ WhatsApp is still processing this image. Please wait 3 seconds and try again!" }, { quoted: msg });
        return;
    }

    try {
        await sock.sendMessage(msg.key.remoteJid, { text: "⏳ Scanning and enhancing..." }, { quoted: msg });

        const stream = await downloadContentFromMessage(imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        const extractedLink = await scanQR(buffer);
        if (!extractedLink) {
            await sock.sendMessage(msg.key.remoteJid, { text: "❌ No valid QR code detected. WhatsApp compression might have blurred it!" });
            return;
        }

        const newQrBlob = await createQR(extractedLink);
        if (!newQrBlob) throw new Error("createQR returned null");

        const arrayBuffer = await newQrBlob.arrayBuffer();
        const finalImageBuffer = Buffer.from(arrayBuffer);

        await sock.sendMessage(msg.key.remoteJid, {
            image: finalImageBuffer,
            caption: `✅ *QR Scanned Successfully*\n\n🔗 *Link:* ${extractedLink}`,
            mimetype: "image/png"
        }, { quoted: msg });

    } catch (error) {
        console.error("Error processing QR:", error);
        await sock.sendMessage(msg.key.remoteJid, { text: "❌ An internal error occurred while processing the QR code." }, { quoted: msg });
    }
}

const command: Command = {
    name: "scan",
    description: "Scan and re-encode a QR code from a replied image",
    usage: "!scan (reply to an image)",
    handler: handleScan,
};

export default command;