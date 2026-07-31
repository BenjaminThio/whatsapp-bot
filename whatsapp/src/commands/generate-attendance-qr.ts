import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { loadCreds } from "../../../shared/hi-hive/legacy/creds.js";
import { aesEncrypt } from "../../../shared/hi-hive/legacy/crypto.js";
import { cmd } from "../config/prefixes.js";
import { createQrImage, QR_SEPARATOR, VALID_QR_TYPES, type QrType } from "../../../shared/lib/qr.js";

/*
  !genqr <type> <args...>

  Builds an attendance QR image by reversing the exact encryption the app uses:
    1. Assembles the plaintext using the same ":*:" / ":-:" delimited structure
       that parseDecoded() in decode-qr.ts reads back out
    2. AES-128-CBC encrypts it with the key/IV from creds.json  (aesEncrypt)
    3. Wraps it as   <type>:*:<encrypted_payload>
    4. Re-encodes the final raw string back into a QR image via zxing

  All arguments after the type are positional. Wrap any arg containing spaces in
  double quotes - ctx.quotedArgs does that parsing.
*/

const INFO_SEPARATOR = ":-:";

/*
Per-type argument shape. Adding a new QR type is now a matter of adding a row
here rather than another branch in the handler.
*/
interface TypeSpec {
    /** Positional argument names AFTER the classId. */
    fields: string[];
    example: string;
    /** Caption labels, aligned with `fields`. */
    labels: string[];
}

const SPECS: Record<QrType, TypeSpec> = {
    Q01: {
        fields: ["courseCode", "sessionType", "group", "datetime", "hours"],
        example: `${cmd("genqr")} Q01 12345 UECS2194 L G1 "2025-01-20 09:00" 2`,
        labels: ["Course", "Session", "Group", "Date/Time", "Hours"],
    },
    Q02: {
        fields: ["courseCode", "sessionType", "group", "datetime", "hours"],
        example: `${cmd("genqr")} Q02 12345 UECS2194 L G1 "2025-01-20 09:00" 2`,
        labels: ["Course", "Session", "Group", "Date/Time", "Hours"],
    },
    E01: {
        fields: ["eventName", "from", "to", "venue"],
        example: `${cmd("genqr")} E01 99999 "Orientation" "2025-01-20 08:00" "2025-01-20 12:00" "Hall A"`,
        labels: ["Event", "From", "To", "Venue"],
    },
    CTR: { fields: [], example: `${cmd("genqr")} CTR 12345`, labels: [] },
    LQR: { fields: [], example: `${cmd("genqr")} LQR 12345`, labels: [] },
};

function usageFor(type: QrType): string {
    const spec = SPECS[type];
    const argList = ["<classId>", ...spec.fields.map(f => `<${f}>`)].join(" ");
    return `${cmd("genqr")} ${type} ${argList}\nExample: ${spec.example}`;
}

/*
  Reassembles the exact decrypted plaintext that parseDecoded() in decode-qr.ts
  splits apart:

    parts[0] = qrType, parts[1..3] = padding, parts[4] = classId, parts[5] = info

  So plaintext = type:*::*::*::*:classId:*:<info>
*/
function buildPlaintext(type: QrType, classId: string, infoParts: string[]): string {
    return [type, "", "", "", classId, infoParts.join(INFO_SEPARATOR)].join(QR_SEPARATOR);
}

async function handleGenQr(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext): Promise<void> {
    // quotedArgs keeps "2025-01-20 09:00" as a single argument
    const args = ctx.quotedArgs;
    const typeRaw = (args[0] ?? "").toUpperCase();

    if (!(VALID_QR_TYPES as readonly string[]).includes(typeRaw)) {
        await ctx.replyText(
            `❌ *Unknown QR type:* \`${typeRaw}\`\n` +
            `Valid types: ${VALID_QR_TYPES.join(", ")}`
        );
        return;
    }

    const type = typeRaw as QrType;
    const spec = SPECS[type];
    const rest = args.slice(1);
    const needed = 1 + spec.fields.length;   // classId + the type's own fields

    if (rest.length < needed) {
        await ctx.replyText(`⚠️ *Not enough arguments for ${type}*\n\n\`${usageFor(type)}\``);
        return;
    }

    const classId = rest[0];
    const infoParts = spec.fields.map((_, i) => rest[i + 1]);

    await ctx.react("⏳");

    try {
        const creds = loadCreds();
        const plaintext = buildPlaintext(type, classId, infoParts);
        const encryptedPayload = aesEncrypt(plaintext, creds.aes_key, creds.aes_iv);
        const rawQrString = `${type}${QR_SEPARATOR}${encryptedPayload}`;
        const imageBuffer = await createQrImage(rawQrString);

        const captionLines = [
            `✅ *Generated Attendance QR*`,
            ``,
            `*Type:* ${type}`,
            `*Class ID:* ${classId}`,
            ...spec.labels.map((label, i) => `*${label}:* ${infoParts[i]}`),
            ``,
            `🔐 *Raw:* \`${rawQrString}\``,
            `_Payload encrypted with AES-128-CBC_`,
        ];

        await ctx.reply({
            image: imageBuffer,
            caption: captionLines.join("\n"),
            mimetype: "image/png",
        });

        await ctx.react("✅");

    } catch (err: any) {
        console.error("!genqr error:", err);
        await ctx.replyText(`❌ Failed to generate QR: ${err?.message ?? err}`);
        await ctx.react("❌");
    }
}

const command: Command = {
    name: "genqr",
    aliases: ["gqr", "createqr", "generate_attendance_qr", "generate_qr"],
    description: "Generate an encrypted attendance QR code image",
    usage: `${cmd("genqr")} <Q01|Q02|E01|CTR|LQR> <classId> <args...>`,
    usageHint:
        `⚠️ *Usage:* \`${cmd("genqr")} <type> <args...>\`\n\n` +
        "*Types:*\n" +
        `• \`${usageFor("Q01")}\`\n\n` +
        `• \`${usageFor("E01")}\`\n\n` +
        `• \`${usageFor("CTR")}\`\n\n` +
        `• \`${usageFor("LQR")}\`\n\n` +
        "_Wrap arguments containing spaces in double quotes._",
    requiresArgs: true,
    handler: handleGenQr,
};

export default command;
