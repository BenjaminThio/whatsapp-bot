import { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { Command, CommandContext } from "./_types.js";
import { refreshToken } from "../../../shared/hi-hive/legacy/refresh-token.js";
import { cmd } from "../config/prefixes.js";

/*
  !refresh

  Re-logins to the API to get a fresh sessionId. Mirrors what scanner.py's `r`
  command does via do_login: POSTs to /chat/api/preLogin/login, validates
  responseCode === 1, and saves the new sessionId + token to creds.json.

  WARNING (from scanner.py): the app allows only ONE active session per account.
  Running this will sign out the phone app. Only use when the sessionId is stale
  and attendance shows "No record found".
*/

async function handleRefresh(_sock: WASocket, _msg: WAMessage, _text: string, ctx: CommandContext) {
  const apiDomain = process.env["ATTENDANCE_QR_SCAN_API_DOMAIN"] ?? "";

  if (!apiDomain) {
    await ctx.replyText(
      "❌ *ATTENDANCE_QR_SCAN_API_DOMAIN* is not set in the environment.\n" +
      "Cannot reach the login endpoint."
    );
    return;
  }

  // Warn up-front about the single-session policy (mirrors scanner.py do_login)
  await ctx.replyText(
    "⚠️ *Warning*\n" +
    "Refreshing the session will *sign out the phone app*.\n" +
    "The token usually stays the same - only the sessionId changes.\n\n" +
    "⏳ Logging in..."
  );
  await ctx.react("⏳");

  try {
    const result = await refreshToken(apiDomain);

    if (!result.ok) {
      await ctx.replyText(`❌ *Refresh failed*\n${result.message}`);
      await ctx.react("❌");
      return;
    }

    const tokenNote = result.tokenChanged
      ? `🔄 Token *changed*`
      : `ℹ️ Token *unchanged* (expected - app keeps the same token across logins)`;

    await ctx.replyText(
      `✅ *Session refreshed!*\n\n` +
      `🆔 *New sessionId:* \`${result.newSessionId}\`\n` +
      `${tokenNote}\n\n` +
      `_creds.json updated - next scan will use this automatically._`
    );
    await ctx.react("✅");

  } catch (err: any) {
    console.error("!refresh error:", err);
    await ctx.replyText(`❌ Unexpected error: ${err?.message ?? err}`);
    await ctx.react("❌");
  }
}

const command: Command = {
  name: "refresh",
  aliases: ["r"],
  description: "Re-login to get a fresh sessionId. ⚠️ Signs out the phone app.",
  usage: cmd("refresh"),
  requiresArgs: false,
  handler: handleRefresh,
};

export default command;
