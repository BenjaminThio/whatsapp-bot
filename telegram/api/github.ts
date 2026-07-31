/**
 * github.ts - relasma/api/github.ts
 *
 * Vercel endpoint for the legacy single-repo push relay.
 *
 * This predates the per-webhook system in src/github. Repos wired up to it post
 * here, and the notification goes to whichever chat last ran /report.
 *
 * That chat id used to live in a Firestore document. It is a row in the shared
 * `bot_settings` table now, alongside everything else - which also means the
 * WhatsApp bot can be the target if you ever want it to be.
 */

import "../../shared/env.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { Commit, PushEvent } from "@octokit/webhooks-types";
import { getSetting, setSetting } from "../../shared/db/user-store.js";
import { sendText } from "../../shared/messaging/outbox.js";
import type { TransportName } from "../../shared/messaging/types.js";

const SETTING_KEY = "github_report_chat";

interface ReportTarget {
    transport: TransportName;
    chatId: number | string;
}

export async function getReportTarget(): Promise<ReportTarget | null> {
    return await getSetting<ReportTarget>(SETTING_KEY);
}

export async function setReportTarget(transport: TransportName, chatId: number | string): Promise<void> {
    await setSetting<ReportTarget>(SETTING_KEY, { transport, chatId });
}

/** Format a push event. Kept close to the original wording. */
function formatPush(payload: PushEvent): string {
    const branch = payload.ref.split("/").pop() ?? "?";
    const commits = payload.commits.map((c: Commit) => `- ${c.message}`).join("\n");

    return (
        "🚀 <b>New Commit Pushed!</b>\n\n" +
        `📂 <b>Repo:</b> <a href="${payload.repository.html_url}">${payload.repository.full_name}</a>\n` +
        `🍁 <b>Branch:</b> ${branch}\n` +
        `👤 <b>Pusher:</b> ${payload.pusher.name}\n\n` +
        `<b>Commits:</b>\n${commits || "(none)"}\n\n` +
        `<a href="${payload.compare}">🔗 View Changes</a>`
    );
}

export default async (req: VercelRequest, res: VercelResponse): Promise<void> => {
    try {
        const event = req.headers["x-github-event"];

        // GitHub pings a new webhook once to check it is alive
        if (event === "ping") {
            res.status(200).send("pong");
            return;
        }

        if (event !== "push") {
            // Anything else is acknowledged so GitHub doesn't mark the hook failing
            res.status(200).send("ignored");
            return;
        }

        const target = await getReportTarget();
        if (!target) {
            console.error("No report chat configured - run /report in the chat you want notified.");
            res.status(200).send("no target configured");
            return;
        }

        /*
        Queued rather than sent. This runs on Vercel, where the bot process
        isn't listening, so there is no live transport to deliver through - the
        row is picked up by whichever bot owns that transport the next time it
        drains. That also means a push during a bot restart is not lost.
        */
        await sendText(target.transport, String(target.chatId), formatPush(req.body as PushEvent), {
            priority: 6,
            immediate: false,
            format: "html",
        });

        res.status(200).send("OK");
    } catch (err) {
        console.error("💥 GitHub webhook crash:", err);
        res.status(500).send("Error processing webhook");
    }
};
