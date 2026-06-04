"use strict";

const { BaseProfile } = require("./BaseProfile");

class DefaultProfile extends BaseProfile {
  constructor() {
    super("default", "auto");
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    bot._client.on("ping", (packet) => {
      try { bot._client.write("pong", { id: packet.id }); } catch (_) {}
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    setTimeout(() => {
      if (!bot || bot._client?.ended) return;
      try {
        // Required fields for 1.21.x (verified against minecraft-data protocol.json):
        //   locale, viewDistance, chatFlags, chatColors, skinParts, mainHand,
        //   enableTextFiltering, enableServerListing, particleStatus
        //
        // NOTE: enableServerListing is present and required in 1.21.3+ protocol schemas.
        // Omitting it causes the serializer to throw silently and no settings packet
        // is sent, which can trigger SERVER ERROR kicks on Paper-based servers.
        // particleStatus mappings: 0=all, 1=decreased, 2=minimal
        bot._client.write("settings", {
          locale:               "en_US",
          viewDistance:         8,
          chatFlags:            0,
          chatColors:           true,
          skinParts:            127,
          mainHand:             1,
          enableTextFiltering:  false,
          enableServerListing:  true,
          particleStatus:       0,
        });
      } catch (err) {
        console.warn(`[botmanager] ⚠️ [${entry.minecraftUser}] Could not send client settings:`, err.message);
      }
    }, 1000);

    const { onLinkVerified } = callbacks || {};
    if (typeof onLinkVerified === "function") {
      try { onLinkVerified(entry.discordId, entry.minecraftUser); } catch (_) {}
    }
  }

  onSpawn(bot, entry, botId) {}
  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) { return false; }
  onError(bot, entry, botId, err, spawnBot) { return false; }
  onEnd(bot, entry, botId, reason, spawnBot) { return false; }
  onCleanup(botId) {}
}

module.exports = { DefaultProfile };