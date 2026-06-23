/**
 * Internal AES-128-CBC helpers - mirrors aes_encrypt / aes_decrypt from scanner.py.
 */
import crypto from "crypto";

export function aesEncrypt(plaintext: string, key: string, iv: string): string {
    const cipher = crypto.createCipheriv(
        "aes-128-cbc",
        Buffer.from(key, "utf-8"),
        Buffer.from(iv, "utf-8")
    );
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    return encrypted.toString("base64");
}

export function aesDecrypt(ciphertext: string, key: string, iv: string): string | null {
    try {
        let ct = ciphertext.trim();
        ct += "=".repeat((4 - (ct.length % 4)) % 4); // re-pad base64
        const decipher = crypto.createDecipheriv(
            "aes-128-cbc",
            Buffer.from(key, "utf-8"),
            Buffer.from(iv, "utf-8")
        );
        decipher.setAutoPadding(true);
        const dec = Buffer.concat([
            decipher.update(Buffer.from(ct, "base64")),
            decipher.final(),
        ]);
        return dec.toString("utf-8");
    } catch {
        return null;
    }
}