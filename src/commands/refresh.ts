import { WAMessage } from "@whiskeysockets/baileys";
import { Command } from "./_types.js";
import { refreshToken } from "../lib/hi-hive/refresh-token.js";

/*
  !refresh

  Re-logins to the API to get a fresh sessionId. Mirrors exactly what
  scanner.py's `r` command does via do_login: POSTs to /chat/api/preLogin/login,
  validates responseCode === 1, and saves the new sessionId + token to creds.json.

  ⚠️  WARNING (from scanner.py): The app allows only ONE active session per
  account. Running this will sign out the phone app. Only use when the
  sessionId is stale and attendance shows "No record found".
*/

async function handleRefresh(sock: any, msg: WAMessage, _text: string) {
  if (!msg.key.remoteJid) return;

  const apiDomain = process.env["ATTENDANCE_QR_SCAN_API_DOMAIN"] ?? "";

  if (!apiDomain) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: "❌ *ATTENDANCE_QR_SCAN_API_DOMAIN* is not set in the environment.\nCannot reach the login endpoint."
    }, { quoted: msg });
    return;
  }

  // Warn the user up-front about the single-session policy (mirrors scanner.py do_login)
  await sock.sendMessage(msg.key.remoteJid, {
    text:
      "⚠️ *Warning*\n" +
      "Refreshing the session will *sign out the phone app*.\n" +
      "The token usually stays the same — only the sessionId changes.\n\n" +
      "⏳ Logging in..."
  }, { quoted: msg });

  await sock.sendMessage(msg.key.remoteJid, {
    react: { text: "⏳", key: msg.key }
  });

  try {
    const result = await refreshToken(apiDomain);

    if (!result.ok) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ *Refresh failed*\n${result.message}`
      }, { quoted: msg });
      await sock.sendMessage(msg.key.remoteJid, {
        react: { text: "❌", key: msg.key }
      });
      return;
    }

    const tokenNote = result.tokenChanged
      ? `🔄 Token *changed*`
      : `ℹ️ Token *unchanged* (expected — app keeps the same token across logins)`;

    await sock.sendMessage(msg.key.remoteJid, {
      text:
        `✅ *Session refreshed!*\n\n` +
        `🆔 *New sessionId:* \`${result.newSessionId}\`\n` +
        `${tokenNote}\n\n` +
        `_creds.json updated — next scan will use this automatically._`
    }, { quoted: msg });

    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: "✅", key: msg.key }
    });

  } catch (err: any) {
    console.error("!refresh error:", err);
    await sock.sendMessage(msg.key.remoteJid, {
      text: `❌ Unexpected error: ${err?.message ?? err}`
    }, { quoted: msg });
    await sock.sendMessage(msg.key.remoteJid, {
      react: { text: "❌", key: msg.key }
    });
  }
}

const command: Command = {
  name: "refresh",
  aliases: ["r"],
  description: "Re-login to get a fresh sessionId. ⚠️ Signs out the phone app.",
  usage: "!refresh",
  requiresArgs: false,
  handler: handleRefresh,
};

export default command;