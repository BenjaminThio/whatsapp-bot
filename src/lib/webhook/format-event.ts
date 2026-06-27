/**
 * format-event.ts — src/lib/webhook/format-event.ts
 *
 * Turns a GitHub webhook payload into a WhatsApp-friendly message.
 * Each handler takes the parsed JSON payload and returns a string, or null
 * if this particular sub-action isn't worth notifying (e.g. an edited label).
 */

interface FormatResult {
  text: string;
  repoName: string | null;
}

function repoFull(payload: any): string | null {
  return payload?.repository?.full_name ?? null;
}

// ─── push ─────────────────────────────────────────────────────────────────────

function formatPush(p: any): string | null {
  const commits: any[] = p.commits ?? [];
  if (commits.length === 0) return null;   // branch deletes, tag pushes, etc.

  const repo     = repoFull(p) ?? "repo";
  const repoLink = p.repository?.html_url ?? "";
  const branch   = (p.ref ?? "").split("/").pop() ?? "";
  const pusher   = p.pusher?.name ?? p.sender?.login ?? "someone";
  const compare  = p.compare ?? "";

  // Full commit list — each line: "- <message first line> (sha) — author"
  const commitList = commits.map((c: any) => {
    const sha = (c.id ?? "").slice(0, 7);
    const msg = (c.message ?? "").split("\n")[0];
    const who = c.author?.username ?? c.author?.name ?? "?";
    return `  • ${msg}  \`${sha}\` — _${who}_`;
  }).join("\n");

  const count = commits.length;

  return [
    `🚀 *New Commit${count === 1 ? "" : "s"} Pushed!*`,
    ``,
    `📂 *Repo:* ${repo}`,
    repoLink ? `🔗 ${repoLink}` : "",
    `🍁 *Branch:* ${branch}`,
    `👤 *Pusher:* ${pusher}`,
    `🔢 *Commits:* ${count}`,
    ``,
    `*Changes:*`,
    commitList,
    compare ? `\n🔗 *View diff:* ${compare}` : "",
  ].filter(Boolean).join("\n");
}

// ─── pull_request ─────────────────────────────────────────────────────────────

function formatPullRequest(p: any): string | null {
  const action = p.action;
  const interesting = ["opened", "closed", "reopened", "ready_for_review"];
  if (!interesting.includes(action)) return null;

  const repo     = repoFull(p) ?? "repo";
  const repoLink = p.repository?.html_url ?? "";
  const pr       = p.pull_request;
  const num      = pr?.number;
  const title    = pr?.title ?? "";
  const who      = p.sender?.login ?? "someone";
  const branch   = `${pr?.head?.ref ?? "?"} → ${pr?.base?.ref ?? "?"}`;

  let verb = action, icon = "🔀";
  if (action === "closed") {
    if (pr?.merged) { verb = "merged"; icon = "✅"; }
    else            { verb = "closed"; icon = "❌"; }
  } else if (action === "opened")         { verb = "opened";       icon = "🔀"; }
  else if (action === "reopened")         { verb = "reopened";     icon = "🔄"; }
  else if (action === "ready_for_review") { verb = "ready";        icon = "👀"; }

  return [
    `${icon} *Pull Request ${verb}!*`,
    ``,
    `📂 *Repo:* ${repo}`,
    repoLink ? `🔗 ${repoLink}` : "",
    `🔢 *PR:* #${num}`,
    `🌿 *Branch:* ${branch}`,
    `👤 *By:* ${who}`,
    ``,
    `📝 *Title:* ${title}`,
    pr?.html_url ? `\n🔗 *View PR:* ${pr.html_url}` : "",
  ].filter(Boolean).join("\n");
}

// ─── issues ───────────────────────────────────────────────────────────────────

function formatIssues(p: any): string | null {
  const action = p.action;
  const interesting = ["opened", "closed", "reopened"];
  if (!interesting.includes(action)) return null;

  const repo     = repoFull(p) ?? "repo";
  const repoLink = p.repository?.html_url ?? "";
  const iss      = p.issue;
  const num      = iss?.number;
  const title    = iss?.title ?? "";
  const who      = p.sender?.login ?? "someone";

  const icon = action === "closed" ? "✅" : action === "reopened" ? "🔄" : "🐛";

  return [
    `${icon} *Issue ${action}!*`,
    ``,
    `📂 *Repo:* ${repo}`,
    repoLink ? `🔗 ${repoLink}` : "",
    `🔢 *Issue:* #${num}`,
    `👤 *By:* ${who}`,
    ``,
    `📝 *Title:* ${title}`,
    iss?.html_url ? `\n🔗 *View issue:* ${iss.html_url}` : "",
  ].filter(Boolean).join("\n");
}

// ─── release ──────────────────────────────────────────────────────────────────

function formatRelease(p: any): string | null {
  if (p.action !== "published") return null;
  const repo     = repoFull(p) ?? "repo";
  const repoLink = p.repository?.html_url ?? "";
  const rel      = p.release;
  const who      = p.sender?.login ?? "someone";

  return [
    `🚀 *New Release Published!*`,
    ``,
    `📂 *Repo:* ${repo}`,
    repoLink ? `🔗 ${repoLink}` : "",
    `🏷️ *Version:* ${rel?.name || rel?.tag_name}`,
    `👤 *By:* ${who}`,
    rel?.body ? `\n📝 *Notes:*\n${String(rel.body).slice(0, 400)}` : "",
    rel?.html_url ? `\n🔗 *View release:* ${rel.html_url}` : "",
  ].filter(Boolean).join("\n");
}

// ─── star / fork ──────────────────────────────────────────────────────────────

function formatStar(p: any): string | null {
  if (p.action !== "created") return null;
  const repo = repoFull(p) ?? "repo";
  const who  = p.sender?.login ?? "someone";
  const count = p.repository?.stargazers_count;
  return `⭐ *${repo}*\n${who} starred the repo${count ? ` (now ${count} stars)` : ""}`;
}

function formatFork(p: any): string | null {
  const repo = repoFull(p) ?? "repo";
  const who  = p.sender?.login ?? "someone";
  const forkName = p.forkee?.full_name;
  return `🍴 *${repo}*\n${who} forked the repo${forkName ? ` → ${forkName}` : ""}`;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (p: any) => string | null> = {
  push:         formatPush,
  pull_request: formatPullRequest,
  issues:       formatIssues,
  release:      formatRelease,
  star:         formatStar,
  fork:         formatFork,
};

/**
 * Format a GitHub event into a WhatsApp message.
 * Returns null when the event/sub-action isn't worth notifying.
 */
export function formatEvent(event: string, payload: any): FormatResult | null {
  const handler = HANDLERS[event];
  if (!handler) {
    // Unknown event — a minimal generic note (only if repo present)
    const repo = repoFull(payload);
    if (!repo) return null;
    return { text: `🔔 *${repo}*\nReceived \`${event}\` event`, repoName: repo };
  }
  const text = handler(payload);
  if (!text) return null;
  return { text, repoName: repoFull(payload) };
}