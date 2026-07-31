/**
 * qr.ts - src/lib/qr.ts
 *
 * QR reading and writing, in one place.
 *
 * Four files each carried their own zxing call, and they were not equal: the
 * auto-scanner had a four-pass escalation that copes with photos of a projector
 * screen, while !scan and !decode used a single fast pass that gave up on the
 * same image. Everything now shares the good one.
 */

import { readBarcodes, writeBarcode } from "zxing-wasm/full";
import { ensureZXingReady } from "../hi-hive/zxing-init.js";

export const QR_SEPARATOR = ":*:";
export const VALID_QR_TYPES = ["E01", "Q01", "Q02", "LQR", "CTR"] as const;
export type QrType = typeof VALID_QR_TYPES[number];

/** The "<type>:*:" header of an attendance QR, or null if it has none. */
export function qrTypeOf(raw: string): QrType | null {
    const sep = raw.indexOf(QR_SEPARATOR);
    if (sep === -1) return null;
    const head = raw.substring(0, sep);
    return (VALID_QR_TYPES as readonly string[]).includes(head) ? (head as QrType) : null;
}

export function isAttendanceQr(raw: string): boolean {
    return qrTypeOf(raw) !== null;
}

/*
Photos of a projector or laptop screen are hard: glare, angle, moire, and often
more than one QR in frame. Each pass is more aggressive (and slower) than the
last, and we stop at the first one that finds anything.
*/
const PASSES: { name: string; opts: any }[] = [
    { name: "fast",       opts: { tryHarder: true, formats: ["QRCode"], maxNumberOfSymbols: 10 } },
    { name: "rotate",     opts: { tryHarder: true, tryRotate: true, tryInvert: true, formats: ["QRCode"], maxNumberOfSymbols: 10 } },
    { name: "downscale",  opts: { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, formats: ["QRCode"], maxNumberOfSymbols: 10 } },
    { name: "any-format", opts: { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 10 } },
];

/**
 * Read every QR code in an image, escalating through decode settings until
 * something is found. Returns distinct strings, in detection order.
 */
export async function readQrCodes(image: Uint8Array | Blob | ArrayBuffer): Promise<string[]> {
    ensureZXingReady();

    for (const pass of PASSES) {
        try {
            const results = await readBarcodes(image as any, pass.opts);
            const texts = results.map((r: any) => r.text).filter(Boolean);
            if (texts.length > 0) {
                console.log(`[qr] pass "${pass.name}" found ${texts.length} symbol(s)`);
                return [...new Set<string>(texts)];
            }
            console.log(`[qr] pass "${pass.name}" found nothing - escalating`);
        } catch (err) {
            console.log(`[qr] pass "${pass.name}" error: ${err}`);
        }
    }

    return [];
}

/** The first QR code in an image, or null. */
export async function readQrCode(image: Uint8Array | Blob | ArrayBuffer): Promise<string | null> {
    const all = await readQrCodes(image);
    return all[0] ?? null;
}

/** Every attendance-format QR in an image, ignoring unrelated codes in frame. */
export async function readAttendanceQrs(image: Uint8Array | Blob | ArrayBuffer): Promise<string[]> {
    return (await readQrCodes(image)).filter(isAttendanceQr);
}

/** Render a string as a PNG QR code. */
export async function createQrImage(content: string): Promise<Buffer> {
    ensureZXingReady();
    const result = await writeBarcode(content, {
        format: "QRCode",
        scale: 3,
        addQuietZones: true,
    });
    if (!result.image) throw new Error("zxing returned no image");
    return Buffer.from(await result.image.arrayBuffer());
}
