"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * HypixelProfile — mineflayer profile for Hypixel.
 *
 * ALL Hypixel-specific logic lives here:
 *   - Version: 1.8.9 by default (also supports modern clients)
 *   - Ping/pong handling
 *
 * Extend with Watchdog-specific handling as needed.
 */

const HYPIXEL_VERSION = "1.8.9";

class HypixelProfile extends BaseProfile {
  constructor() {
    super("hypixel", HYPIXEL_VERSION);
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    bot._client.on("ping", (packet) => {
      try {
        bot._client.write("pong", { id: packet.id });
      } catch (_) {}
    });

    bot._client.on("plugin_message", () => {
      // Future: handle Hypixel channels if needed
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {}

  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    return false;
  }

  onError(bot, entry, botId, err, spawnBot) {
    return false;
  }

  onEnd(bot, entry, botId, reason, spawnBot) {
    return false;
  }

  onCleanup(botId) {}
}

module.exports = { HypixelProfile, HYPIXEL_VERSION };