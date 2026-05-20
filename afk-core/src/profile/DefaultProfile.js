"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * DefaultProfile — used for any server that doesn't match a specific profile.
 *
 * Behaviour:
 *   - Version: "auto" (botmanager uses version cache / auto-detection)
 *   - Handles ping/pong for Paper servers
 *   - Sends client settings after login
 *   - No movement suppression
 */
class DefaultProfile extends BaseProfile {
  constructor() {
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

  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    return false; // let botmanager handle
  }

  onError(bot, entry, botId, err, spawnBot) {
    return false; // let botmanager handle
  }

  onEnd(bot, entry, botId, reason, spawnBot) {
    return false; // let botmanager handle
  }

  onCleanup(botId) {}
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