/**
 * current-sock.ts — src/lib/current-sock.ts
 *
 * A live reference to the active Baileys socket.
 *
 * Why this exists
 * ───────────────
 * Background services used to be handed the socket once:
 *
 *     startScanBufferService(sock);   // captured for the lifetime of the service
 *
 * When the connection drops, startBot() builds a NEW socket — but the service
 * still holds the old, closed one, and its `started` guard stops it being
 * re-registered. Every later send then fails with:
 *
 *     Error: Connection Closed   statusCode: 428
 *
 * …forever, until the process is restarted. Scans still succeeded (they're
 * plain HTTP to the portal), so attendance was recorded while the report
 * silently never arrived.
 *
 * Services now read the socket at SEND time via getSock(), so they always use
 * whichever socket is currently alive.
 */

let current: any = null;

/** Called by index.ts every time a socket is created. */
export function setSock(sock: any): void {
  current = sock;
}

/** The socket in use right now, or null before the first connection. */
export function getSock(): any | null {
  return current;
}

/** Best-effort check that the socket is actually usable for sending. */
export function isSockOpen(): boolean {
  const s = current;
  if (!s) return false;
  // Baileys exposes ws.isOpen; fall back to assuming open if the shape changes
  const ws = (s as any).ws;
  if (ws && typeof ws.isOpen === "boolean") return ws.isOpen;
  return true;
}