"use strict";

const { BaseProfile } = require("./BaseProfile");
const { _sendClientSettings } = require("./DefaultProfile");

// ─── Hypixel constants ─────────────────────────────────────────────────────────

/**
 * Hypixel supports both 1.8.9 and modern clients.
 * Default to 1.8.9 for lowest-latency/broadest compatibility.
 * If you need a specific version override, pass it via the /start API.
 */
const HYPIXEL_VERSION = "1.8.9";

/**
 * HypixelProfile
 *
 * Stub profile for Hypixel.
 * Hypixel has a strict anti-cheat (Watchdog) — this profile is the dedicated
 * place to add any Hypixel-specific packet handling, timing, or behaviour.
 *
 * Current behaviour (minimal — extend as needed):
 *   - Connects with 1.8.9 by default
 *   - Sends client settings after login
 *   - Handles ping/pong
 *   - No movement suppression (Hypixel expects normal player behaviour)
 */
class HypixelProfile extends BaseProfile {
  constructor() {
    super("hypixel", HYPIXEL_VERSION);
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    // Hypixel runs on a custom server, but some builds still send ping packets
    bot._client.on("ping", (packet) => {
      try {
        bot._client.write("pong", { id: packet.id });
      } catch (_) {}
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
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

module.exports = { HypixelProfile, HYPIXEL_VERSION };