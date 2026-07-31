/**
 * firebase.ts - shared/firebase.ts
 *
 * The one sanctioned cloud dependency.
 *
 * Core data lives in local Postgres. Firestore survives only for the GitHub
 * webhook relay, whose payload URL has to be reachable from Vercel - which a
 * database on a phone behind CGNAT is not.
 *
 * Initialisation is LAZY and the credentials path is configurable. Reading the
 * service account at import time meant a bot without the key file failed to
 * load the whole module, taking /webhook down and logging an ENOENT that looked
 * nothing like "you have no Firebase credentials".
 *
 * Set FIREBASE_SERVICE_ACCOUNT to point at the key; it otherwise falls back to
 * serviceAccountKey.json in the working directory, then the shared folder.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import type { Firestore } from "firebase-admin/firestore";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

/** Candidate key locations, most explicit first. */
function candidatePaths(): string[] {
    const configured = process.env["FIREBASE_SERVICE_ACCOUNT"];
    return [
        ...(configured ? [path.resolve(configured)] : []),
        path.join(process.cwd(), "serviceAccountKey.json"),
        path.join(HERE, "serviceAccountKey.json"),
        // So one key file can serve both bots
        path.join(HERE, "..", "whatsapp", "serviceAccountKey.json"),
    ];
}

let cached: Firestore | null = null;
let attempted = false;

/** Is a service account key available at all? */
export function hasFirebaseCredentials(): boolean {
    return candidatePaths().some(existsSync);
}

/**
 * The Firestore handle, or null when no credentials are configured.
 *
 * Callers must handle null rather than assuming Firestore is there - it is an
 * optional extra, not a hard requirement.
 */
export async function getFirestoreDb(): Promise<Firestore | null> {
    if (cached) return cached;
    if (attempted) return null;        // don't re-probe a known-missing key
    attempted = true;

    const keyPath = candidatePaths().find(existsSync);
    if (!keyPath) {
        console.warn(
            "🔥 No Firebase service account found - GitHub webhooks are disabled.\n" +
            "   Set FIREBASE_SERVICE_ACCOUNT, or drop serviceAccountKey.json in the bot folder."
        );
        return null;
    }

    try {
        const { initializeApp, cert, getApps } = await import("firebase-admin/app");
        const { getFirestore } = await import("firebase-admin/firestore");

        const serviceAccount = JSON.parse(readFileSync(keyPath, "utf-8"));

        // Both bots may initialise inside one process during tests; reuse the app.
        const app = getApps().length > 0
            ? getApps()[0]!
            : initializeApp({ credential: cert(serviceAccount) });

        cached = getFirestore(app);
        console.log(`🔥 Firebase initialised from ${keyPath}`);
        return cached;
    } catch (err) {
        console.error("🔥 Could not initialise Firebase:", err);
        return null;
    }
}
