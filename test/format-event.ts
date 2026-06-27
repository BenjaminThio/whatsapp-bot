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

  const repo   = repoFull(p) ?? "repo";
  const branch = (p.ref ?? "").replace("refs/heads/", "");
  const pusher = p.pusher?.name ?? p.sender?.login ?? "someone";

  const lines = [
    `🔔 *${repo}*`,
    `📤 ${pusher} pushed ${commits.length} commit${commits.length === 1 ? "" : "s"} to \`${branch}\``,
    "",
  ];

  // Show up to 5 commits, each: short sha + first line of message + author
  for (const c of commits.slice(0, 5)) {
    const sha   = (c.id ?? "").slice(0, 7);
    const msg   = (c.message ?? "").split("\n")[0].slice(0, 80);
    const who   = c.author?.username ?? c.author?.name ?? "?";
    lines.push(`• \`${sha}\` ${msg} — _${who}_`);
  }
  if (commits.length > 5) lines.push(`_…and ${commits.length - 5} more_`);

  // Link to the compare view
  if (p.compare) { lines.push(""); lines.push(`🔗 ${p.compare}`); }

  return lines.join("\n");
}

// ─── pull_request ─────────────────────────────────────────────────────────────

function formatPullRequest(p: any): string | null {
  const action = p.action;
  // Only notify on meaningful actions
  const interesting = ["opened", "closed", "reopened", "ready_for_review"];
  if (!interesting.includes(action)) return null;

  const repo = repoFull(p) ?? "repo";
  const pr   = p.pull_request;
  const num  = pr?.number;
  const title = pr?.title ?? "";
  const who  = p.sender?.login ?? "someone";

  let verb = action;
  let icon = "🔀";
  if (action === "closed") {
    if (pr?.merged) { verb = "merged"; icon = "✅"; }
    else            { verb = "closed"; icon = "❌"; }
  } else if (action === "opened")            { verb = "opened";          icon = "🔀"; }
  else if (action === "reopened")            { verb = "reopened";        icon = "🔄"; }
  else if (action === "ready_for_review")    { verb = "marked ready";    icon = "👀"; }

  return [
    `${icon} *${repo}*`,
    `PR #${num} ${verb} by ${who}`,
    `📝 ${title}`,
    pr?.html_url ? `🔗 ${pr.html_url}` : "",
  ].filter(Boolean).join("\n");
}

// ─── issues ───────────────────────────────────────────────────────────────────

function formatIssues(p: any): string | null {
  const action = p.action;
  const interesting = ["opened", "closed", "reopened"];
  if (!interesting.includes(action)) return null;

  const repo = repoFull(p) ?? "repo";
  const iss  = p.issue;
  const num  = iss?.number;
  const title = iss?.title ?? "";
  const who  = p.sender?.login ?? "someone";

  const icon = action === "closed" ? "✅" : action === "reopened" ? "🔄" : "🐛";

  return [
    `${icon} *${repo}*`,
    `Issue #${num} ${action} by ${who}`,
    `📝 ${title}`,
    iss?.html_url ? `🔗 ${iss.html_url}` : "",
  ].filter(Boolean).join("\n");
}

// ─── release ──────────────────────────────────────────────────────────────────

function formatRelease(p: any): string | null {
  if (p.action !== "published") return null;
  const repo = repoFull(p) ?? "repo";
  const rel  = p.release;
  return [
    `🚀 *${repo}*`,
    `New release: *${rel?.name || rel?.tag_name}*`,
    rel?.body ? `\n${String(rel.body).slice(0, 300)}` : "",
    rel?.html_url ? `\n🔗 ${rel.html_url}` : "",
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