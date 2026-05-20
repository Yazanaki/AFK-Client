"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * DefaultProfile — used for any server that doesn't match a specific profile.
 *
 * Behaviour:
 *   - Uses the version provided by the caller (or auto-detection)
 *   - Handles ping/pong for Paper servers
 *   - Sends client settings after login
 *   - No movement suppression
 */
class DefaultProfile extends BaseProfile {
  constructor() {
    // "auto" signals botmanager to use version auto-detection for this profile
    super("default", "auto");
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    // Handle ping/pong — some Paper servers use this separate from keep_alive
    bot._client.on("ping", (packet) => {
      try {
        bot._client.write("pong", { id: packet.id });
      } catch (_) {}
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    // Send client settings 1s after login to let the server settle
    setTimeout(() => {
      if (!bot || bot._client?.ended) return;
      _sendClientSettings(bot, entry.minecraftUser, "post-login");
    }, 1000);

    const { onLinkVerified } = callbacks || {};
    if (typeof onLinkVerified === "function") {
      try { onLinkVerified(entry.discordId, entry.minecraftUser); } catch (_) {}
    }
  }
}

// ─── Shared utility ────────────────────────────────────────────────────────────

function _sendClientSettings(bot, username, context) {
  console.log(`[botmanager] 📋 [${username}] Sending client settings (context: ${context})`);
  try {
    bot._client.write("settings", {
      locale: "en_US",
      viewDistance: 8,
      chatFlags: 0,
      chatColors: true,
      skinParts: 127,
      mainHand: 1,
      enableTextFiltering: false,
      enableServerListing: true,
    });
  } catch (err) {
    console.warn(`[botmanager] ⚠️ [${username}] Could not send client settings:`, err.message);
  }
}

module.exports = { DefaultProfile, _sendClientSettings };