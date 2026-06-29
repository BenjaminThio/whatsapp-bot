import { WAMessage } from "@whiskeysockets/baileys";
import { writeBarcode } from "zxing-wasm";
import { Command } from "./_types.js";
import { loadCreds } from "../lib/old-hi-hive/creds.js";
import { aesEncrypt } from "../lib/old-hi-hive/crypto.js";

/*
  !genqr <type> <args...>

  Builds an attendance QR image by reversing the exact encryption the app uses:
    1. Assembles the plaintext using the same ":*:" / ":-:" delimited structure
       that parseDecoded() in decode-qr.ts reads back out
    2. AES-128-CBC encrypts it with the key/IV from creds.json  (aesEncrypt)
    3. Wraps it as   <type>:*:<encrypted_payload>
    4. Re-encodes the final raw string back into a QR image via zxing

  Supported types:

  Q01 / Q02  — class attendance QR
    !genqr Q01 <classId> <courseCode> <sessionType> <group> <datetime> <hours>
    !genqr Q01 12345 UECS2194 L G1 "2025-01-20 09:00" 2

  E01  — event QR
    !genqr E01 <classId> <eventName> <from> <to> <venue>
    !genqr E01 99999 "Orientation" "2025-01-20 08:00" "2025-01-20 12:00" "Hall A"

  CTR / LQR  — minimal types, just need a classId
    !genqr CTR <classId>
    !genqr LQR <classId>

  All arguments after the type are positional. Wrap any arg containing
  spaces in double quotes.
*/

// ─── Constants (must match decode-qr.ts exactly) ─────────────────────────────

const QR_SEPARATOR   = ":*:";
const INFO_SEPARATOR = ":-:";

const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"] as const;
type QrType = typeof VALID_QR_TYPES[number];

// ─── Argument parser ─────────────────────────────────────────────────────────
/*
  Splits a shell-style argument string, respecting "quoted phrases".
  e.g. 'Q01 12345 UECS2194 L G1 "2025-01-20 09:00" 2'
    => ["Q01", "12345", "UECS2194", "L", "G1", "2025-01-20 09:00", "2"]
*/
function parseArgs(input: string): string[] {
    const args: string[] = [];
    let current = "";
    let inQuote = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '"') {
            inQuote = !inQuote;
        } else if (ch === " " && !inQuote) {
            if (current.length > 0) { args.push(current); current = ""; }
        } else {
            current += ch;
        }
    }
    if (current.length > 0) args.push(current);
    return args;
}

// ─── Plaintext builder ────────────────────────────────────────────────────────
/*
  Reassembles the exact decrypted plaintext that parseDecoded() in decode-qr.ts
  splits apart. The structure (verified from parseDecoded source):

    parts = decrypted.split(":*:")
    parts[0] = qrType
    parts[1] = "" (padding)
    parts[2] = "" (padding)
    parts[3] = "" (padding)
    parts[4] = classId
    parts[5] = info  (joined by ":-:")

  So plaintext = type:*::*::*::*:classId:*:<info>
*/
function buildPlaintext(type: QrType, classId: string, infoParts: string[]): string {
    const info = infoParts.join(INFO_SEPARATOR);
    // parts[0]:*:parts[1]:*:parts[2]:*:parts[3]:*:parts[4]:*:parts[5]
    //   type  :*:   ""  :*:   ""   :*:   ""   :*: classId :*:  info
    return [type, "", "", "", classId, info].join(QR_SEPARATOR);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function usageFor(type: QrType): string {
    switch (type) {
        case "Q01":
        case "Q02":
            return `!genqr ${type} <classId> <courseCode> <sessionType> <group> <datetime> <hours>\n` +
                   `Example: !genqr ${type} 12345 UECS2194 L G1 "2025-01-20 09:00" 2`;
        case "E01":
            return `!genqr E01 <classId> <eventName> <from> <to> <venue>\n` +
                   `Example: !genqr E01 99999 "Orientation" "2025-01-20 08:00" "2025-01-20 12:00" "Hall A"`;
        case "CTR":
        case "LQR":
            return `!genqr ${type} <classId>\n` +
                   `Example: !genqr ${type} 12345`;
    }
}

// ─── QR image generator ───────────────────────────────────────────────────────

async function buildQrImage(rawQrString: string): Promise<Buffer> {
    const result = await writeBarcode(rawQrString, {
        format: "QRCode",
        scale: 3,
        addQuietZones: true,
    });
    const arrayBuffer = await result.image!.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

async function handleGenQr(sock: any, msg: WAMessage, text: string): Promise<void> {
    if (!msg.key.remoteJid) return;
    const jid = msg.key.remoteJid;

    const input = text.slice("!genqr".length).trim();

    // No args at all — show full usage
    if (!input) {
        await sock.sendMessage(jid, {
            text:
                "⚠️ *Usage:* `!genqr <type> <args...>`\n\n" +
                "*Types:*\n" +
                `• \`${usageFor("Q01")}\`\n\n` +
                `• \`${usageFor("E01")}\`\n\n` +
                `• \`${usageFor("CTR")}\`\n\n` +
                `• \`${usageFor("LQR")}\`\n\n` +
                "_Wrap arguments containing spaces in double quotes._",
        }, { quoted: msg });
        return;
    }

    const args = parseArgs(input);
    const typeRaw = args[0]?.toUpperCase();

    // Validate type
    if (!VALID_QR_TYPES.includes(typeRaw as QrType)) {
        await sock.sendMessage(jid, {
            text:
                `❌ *Unknown QR type:* \`${typeRaw}\`\n` +
                `Valid types: ${VALID_QR_TYPES.join(", ")}`,
        }, { quoted: msg });
        return;
    }

    const type = typeRaw as QrType;
    const rest = args.slice(1); // everything after the type

    // ── Per-type argument extraction & validation ─────────────────────────────

    let classId: string;
    let infoParts: string[];

    if (type === "Q01" || type === "Q02") {
        // classId courseCode sessionType group datetime hours  (6 args)
        if (rest.length < 6) {
            await sock.sendMessage(jid, {
                text: `⚠️ *Not enough arguments for ${type}*\n\n\`${usageFor(type)}\``,
            }, { quoted: msg });
            return;
        }
        classId   = rest[0];
        // info = courseCode:-:sessionType:-:group:-:datetime:-:hours
        infoParts = [rest[1], rest[2], rest[3], rest[4], rest[5]];

    } else if (type === "E01") {
        // classId eventName from to venue  (5 args)
        if (rest.length < 5) {
            await sock.sendMessage(jid, {
                text: `⚠️ *Not enough arguments for E01*\n\n\`${usageFor("E01")}\``,
            }, { quoted: msg });
            return;
        }
        classId   = rest[0];
        // info = eventName:-:from:-:to:-:venue
        infoParts = [rest[1], rest[2], rest[3], rest[4]];

    } else {
        // CTR / LQR — just classId  (1 arg)
        if (rest.length < 1) {
            await sock.sendMessage(jid, {
                text: `⚠️ *Not enough arguments for ${type}*\n\n\`${usageFor(type)}\``,
            }, { quoted: msg });
            return;
        }
        classId   = rest[0];
        infoParts = [];
    }

    await sock.sendMessage(jid, { react: { text: "⏳", key: msg.key } });

    try {
        // ── Step 1: load AES key/IV from creds.json ───────────────────────────
        const creds = loadCreds();

        // ── Step 2: build plaintext (exact reversal of parseDecoded) ─────────
        const plaintext = buildPlaintext(type, classId, infoParts);

        // ── Step 3: AES-128-CBC encrypt → base64 (reversal of aesDecrypt) ────
        const encryptedPayload = aesEncrypt(plaintext, creds.aes_key, creds.aes_iv);

        // ── Step 4: assemble the final raw QR string ──────────────────────────
        const rawQrString = `${type}${QR_SEPARATOR}${encryptedPayload}`;

        // ── Step 5: encode as a QR image via zxing ────────────────────────────
        const imageBuffer = await buildQrImage(rawQrString);

        // ── Step 6: send the image with a summary caption ─────────────────────
        const captionLines = [
            `✅ *Generated Attendance QR*`,
            ``,
            `*Type:* ${type}`,
            `*Class ID:* ${classId}`,
        ];

        if (type === "Q01" || type === "Q02") {
            captionLines.push(`*Course:*    ${infoParts[0]}`);
            captionLines.push(`*Session:*   ${infoParts[1]}`);
            captionLines.push(`*Group:*     ${infoParts[2]}`);
            captionLines.push(`*Date/Time:* ${infoParts[3]}`);
            captionLines.push(`*Hours:*     ${infoParts[4]}`);
        } else if (type === "E01") {
            captionLines.push(`*Event:* ${infoParts[0]}`);
            captionLines.push(`*From:*  ${infoParts[1]}`);
            captionLines.push(`*To:*    ${infoParts[2]}`);
            captionLines.push(`*Venue:* ${infoParts[3]}`);
        }

        captionLines.push(``);
        captionLines.push(`🔐 *Raw:* \`${rawQrString}\``);
        captionLines.push(`_Payload encrypted with AES-128-CBC_`);

        await sock.sendMessage(jid, {
            image: imageBuffer,
            caption: captionLines.join("\n"),
            mimetype: "image/png",
        }, { quoted: msg });

        await sock.sendMessage(jid, { react: { text: "✅", key: msg.key } });

    } catch (err: any) {
        console.error("!genqr error:", err);
        await sock.sendMessage(jid, {
            text: `❌ Failed to generate QR: ${err?.message ?? err}`,
        }, { quoted: msg });
        await sock.sendMessage(jid, { react: { text: "❌", key: msg.key } });
    }
}

// ─── Command definition ───────────────────────────────────────────────────────

const command: Command = {
    name: "genqr",
    aliases: ["gqr", "createqr", "generate_attendance_qr", "generate_qr"],
    description: "Generate an encrypted attendance QR code image",
    usage: '!genqr <Q01|Q02|E01|CTR|LQR> <classId> <args...>',
    requiresArgs: true,
    handler: handleGenQr,
};

export default command;