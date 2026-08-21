/**
 * bind.ts - attach someone else's chat account to hi-hive credentials.
 *
 * Without this, every student has to run `!test set` themselves. `bind` lets an
 * admin do it on their behalf from their id alone, which covers the two cases
 * that kept coming up:
 *
 *   1. You already know their details. Create the creds AND point their id at
 *      them in one step.
 *   2. You already added them anonymously (`!test add`), so a doc exists keyed
 *      by student id. Point their chat id at that doc instead of duplicating it.
 *
 * The second case is also how one person links their WhatsApp and Telegram
 * accounts to a single set of credentials - bind the other platform's id to the
 * doc they already have.
 *
 * Both bots call this so the rules cannot drift apart; each supplies its own
 * transport name and its own way of naming a target.
 */

import {
  loadCreds, saveCreds, exists, bindAlias, unbindAlias, resolveAlias,
  aliasesForDoc, resolveDocId, claimDoc, type Alias,
} from "./creds.js";
import { setDocIdentity } from "./identity.js";
import type { Creds } from "./types.js";

export type Transport = "whatsapp" | "telegram";

export interface BindResult {
  ok: boolean;
  message: string;
  /** The doc the target now resolves to, when the bind succeeded. */
  docId?: string;
  /** True when the credentials were created by this call rather than reused. */
  created?: boolean;
}

const ID_REGEX = /^\d{7}$/;
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@1utar\.my$/i;

/** Parse "true"/"false"/"yes"/"no"/"1"/"0". Undefined when not a boolean. */
export function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (["true", "yes", "y", "1", "hidden"].includes(s)) return true;
  if (["false", "no", "n", "0", "shown"].includes(s)) return false;
  return undefined;
}

/**
 * Bind `targetId` to an existing doc.
 *
 * `docRef` may be a doc id, a student id, an email, or another bound id -
 * whatever the person typed. It is resolved before binding so the alias always
 * points at a real row.
 */
export async function bindToExisting(
  targetId: string, docRef: string, transport: Transport, boundBy: string,
  displayName?: string | null
): Promise<BindResult> {
  const target = targetId.trim();
  if (!target) return { ok: false, message: "No target id given." };

  const docId = await resolveDocId(docRef);
  if (!docId) {
    return { ok: false, message: `No credentials found for \`${docRef}\`.` };
  }

  // Binding an id that already owns credentials would leave two sets reachable
  // by the same person, with resolution order silently picking one.
  if (await exists(target)) {
    return {
      ok: false,
      message:
        `\`${target}\` already has its own credentials.\n` +
        `Delete them first, or bind a different id.`,
    };
  }

  if (target === docId) {
    return { ok: false, message: "That id already is the doc - nothing to bind." };
  }

  const previous = await resolveAlias(target);
  await bindAlias(target, docId, transport, boundBy);

  /*
  The doc stops being anonymous.

  An anonymous doc is one somebody added on a student's behalf - owner_id names
  the adder, and it shows up in their `list`. Once the student themselves is
  bound to it, it is theirs: the owner is cleared and it leaves the adder's
  anonymous list. Same row, same student id, no duplicate.
  */
  const wasOwnedBy = await claimDoc(docId);

  // The jid is known for certain here, unlike the passive capture that waits
  // for someone to speak
  await setDocIdentity(docId, target, displayName);

  const creds = await loadCreds(docId);
  const who = creds ? (creds.hidden ? "*".repeat(creds.id.length) : creds.id) : docId;

  const claimed = wasOwnedBy
    ? `
📤 No longer anonymous - it was held by \`${wasOwnedBy}\` and is now their own.`
    : "";

  return {
    ok: true,
    docId,
    created: false,
    message: (previous && previous !== docId
      ? `🔗 Rebound \`${target}\` from \`${previous}\` to \`${who}\`.`
      : `🔗 Bound \`${target}\` to \`${who}\`.`) + claimed,
  };
}

/**
 * Create credentials and bind `targetId` to them in one step.
 *
 * The doc is keyed by student id, exactly like `!test add`, so the same student
 * can never end up with two rows. The target's chat id becomes an alias for it.
 */
export async function bindNew(
  targetId: string, studentId: string, email: string,
  hidden: boolean | undefined, transport: Transport, boundBy: string,
  displayName?: string | null
): Promise<BindResult> {
  const target = targetId.trim();
  const id = studentId.trim();
  const mail = email.trim();

  if (!target) return { ok: false, message: "No target id given." };
  if (!ID_REGEX.test(id)) {
    return { ok: false, message: `\`${id}\` is not a 7-digit student id.` };
  }
  if (!EMAIL_REGEX.test(mail)) {
    return { ok: false, message: `\`${mail}\` is not a @1utar.my address.` };
  }

  if (await exists(target)) {
    return {
      ok: false,
      message:
        `\`${target}\` already has its own credentials.\n` +
        `Use \`set\` to change them, or delete them first.`,
    };
  }

  const already = await exists(id);

  /*
  exists() only says whether the target owns a doc, so an id that is merely
  BOUND to one passes that check. Moving it is allowed - rebinding is how a
  mistake gets corrected - but it has to be reported, or creating credentials
  for someone silently detaches them from the account they were already on.
  */
  const previous = await resolveAlias(target);

  /*
  No ownerId: this doc belongs to the person being bound, not to whoever ran the
  command, so it must not appear in the binder's anonymous list. Accountability
  for who created it lives in hi_hive_alias.bound_by instead.
  */
  const creds: Creds = { id, email: mail, hidden: hidden ?? false };
  await saveCreds(id, creds);          // doc id IS the student id
  await bindAlias(target, id, transport, boundBy);
  await setDocIdentity(id, target, displayName);

  const moved = previous && previous !== id
    ? `\n⚠️ Moved from \`${previous}\`, which they were bound to before.`
    : "";

  return {
    ok: true,
    docId: id,
    created: !already,
    message:
      `${already ? "🔗 Bound" : "✅ Created and bound"} \`${target}\`\n` +
      `🫆 Student ID: \`${id}\`\n` +
      `📧 Email: \`${mail}\`\n` +
      `🙈 Hidden: \`${hidden ?? false}\`${moved}`,
  };
}

/** Drop a binding. The credentials themselves are left alone. */
export async function unbind(targetId: string): Promise<BindResult> {
  const target = targetId.trim();
  if (!target) return { ok: false, message: "No target id given." };

  const was = await unbindAlias(target);
  return was
    ? { ok: true, docId: was, message: `🔓 Unbound \`${target}\` from \`${was}\`.` }
    : { ok: false, message: `\`${target}\` is not bound to anything.` };
}

/** Who is bound to the doc this id resolves to. */
export async function bindingsFor(idOrDoc: string): Promise<{ docId?: string; aliases: Alias[] }> {
  const docId = await resolveDocId(idOrDoc);
  if (!docId) return { aliases: [] };
  return { docId, aliases: await aliasesForDoc(docId) };
}

/** Rendered list of an account's bound ids, for `info` and `bind list`. */
export function formatBindings(docId: string, aliases: Alias[]): string {
  if (aliases.length === 0) return `🔗 No other accounts bound to \`${docId}\`.`;
  const lines = aliases.map(a => `  • \`${a.aliasId}\`${a.transport ? ` (${a.transport})` : ""}`);
  return `🔗 *Bound to \`${docId}\`:*\n${lines.join("\n")}`;
}
