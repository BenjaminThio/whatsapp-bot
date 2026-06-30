/**
 * github-webhook.ts - src/lib/webhook/github-webhook.ts
 *
 * Core store + verification for GitHub webhooks. Each webhook config is one
 * Firestore document in the `webhooks` collection, keyed by a random token.
 *
 * Security model (defense in depth):
 *   1. URL path token  => routes the request to a config, and is unguessable
 *                         (32 bytes of crypto randomness). No token = 404.
 *   2. HMAC-SHA256 sig => GitHub signs every payload with the shared secret.
 *                         We recompute and compare. Wrong/missing sig = 401.
 *
 * So even if someone steals the URL (token), they cannot forge a valid
 * signature without the secret. And without the token they can't find the route.
 */

import crypto from "crypto";
import db from "../../firebase.js";

const COLLECTION = "webhooks";

// Events the user can subscribe to. "all" is a wildcard.
export const SUPPORTED_EVENTS = [
  "push",          // commits pushed
  "pull_request",  // PR opened/closed/merged
  "issues",        // issue opened/closed
  "release",       // release published
  "star",          // repo starred
  "fork",          // repo forked
] as const;

export type GithubEvent = typeof SUPPORTED_EVENTS[number];

export interface WebhookConfig {
  token:      string;        // URL path token (doc id)
  secret:     string;        // HMAC shared secret (set in GitHub webhook UI)
  ownerJid:   string;        // who created it (for management/listing)
  targetJid:  string;        // WhatsApp group/chat to notify
  events:     string[];      // subscribed events, or ["all"]
  repoName:   string | null; // filled in from the first payload received
  createdAt:  number;
  active:     boolean;
}

// Token / secret generation
// URL-safe random token for the webhook path (unguessable route).
export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");   // 32 chars, URL-safe
}

// Strong random secret for GitHub's HMAC signing.
export function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");          // 64 hex chars
}

// Firestore CRUD
export async function createWebhook(
  ownerJid: string,
  targetJid: string,
  events: string[]
): Promise<WebhookConfig> {
  const token = generateToken();
  const config: WebhookConfig = {
    token,
    secret:    generateSecret(),
    ownerJid,
    targetJid,
    events:    events.length ? events : ["all"],
    repoName:  null,
    createdAt: Date.now(),
    active:    true,
  };
  await db.collection(COLLECTION).doc(token).set(config);
  return config;
}

export async function getWebhook(token: string): Promise<WebhookConfig | null> {
  const snap = await db.collection(COLLECTION).doc(token).get();
  return snap.exists ? (snap.data() as WebhookConfig) : null;
}

// List all webhooks created by a given owner.
export async function listWebhooks(ownerJid: string): Promise<WebhookConfig[]> {
  const snap = await db.collection(COLLECTION)
    .where("ownerJid", "==", ownerJid)
    .get();
  return snap.docs.map(d => d.data() as WebhookConfig);
}

export async function deleteWebhook(token: string, ownerJid: string): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(token);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const cfg = snap.data() as WebhookConfig;
  if (cfg.ownerJid !== ownerJid) return false;   // only the owner can delete
  await ref.delete();
  return true;
}

// Update mutable fields (target group, events, active) - owner only.
export async function updateWebhook(
  token: string,
  ownerJid: string,
  patch: Partial<Pick<WebhookConfig, "targetJid" | "events" | "active" | "repoName">>
): Promise<boolean> {
  const ref = db.collection(COLLECTION).doc(token);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const cfg = snap.data() as WebhookConfig;
  if (cfg.ownerJid !== ownerJid && patch.repoName === undefined) return false;
  await ref.set(patch, { merge: true });
  return true;
}

// HMAC verification
/**
 * Verify GitHub's X-Hub-Signature-256 header against the raw request body.
 * GitHub sends "sha256=<hex>" where hex = HMAC-SHA256(body, secret).
 * Uses timingSafeEqual to avoid timing attacks.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // Both must be equal length for timingSafeEqual
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

// Event filter
// Does this config want to be notified about `event`?
export function wantsEvent(config: WebhookConfig, event: string): boolean {
  if (config.events.includes("all")) return true;
  return config.events.includes(event);
}