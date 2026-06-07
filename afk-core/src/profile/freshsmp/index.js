// afk-core/src/profile/freshsmp/index.js
"use strict";

// FreshSMP profile — orchestrates the self-contained behaviors in this folder:
//   settings.js   client_information field-filler + config-state movement drop
//   lifecycle.js  always-on lifecycle logger + ring-buffer dump on kick
//   keepAlive.js  keep_alive echo + ping logging + cookie_response
//   movement.js   per-tick flying keepalive (anti-detection)
//   transfer.js   re-send settings in PLAY after a Velocity transfer
//   antiAfk.js    periodic head turn (anti-AFK-kick)
//   gamemode.js   /queue gamemode flow
//   hunger.js     auto-eat (attached here once added)

const { BaseProfile } = require("../BaseProfile");
const { installSettingsInterceptor, sendClientSettings } = require("./settings");
const { installLifecycleLogger } = require("./lifecycle");
const { installKeepAlive } = require("./keepAlive");
const { installPerTickMovement } = require("./movement");
const { installTransferHandler } = require("./transfer");
const antiAfk = require("./antiAfk");
const gamemode = require("./gamemode");
const { attachHunger } = require("./hunger");

const FRESHSMP_VERSION = "1.21.11";

class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", FRESHSMP_VERSION);
  }

  // We handle keep_alive ourselves (keepAlive.js), so disable the built-in
  // handler to avoid its 30s timeout firing alongside ours.
  buildClientOptions(base) {
    return { ...base, keepAlive: false };
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    // Ring buffer shared by settings.js (writer) and lifecycle.js (dumper).
    entry._recentOut = [];

    // The settings interceptor MUST be installed first — it wraps bot._client.write
    // and returns the original (bound) write that the keepalive/movement handlers
    // use to bypass the patch.
    const origWrite = installSettingsInterceptor(bot, entry);
    installLifecycleLogger(bot, entry);
    installKeepAlive(bot, entry, origWrite);
    installPerTickMovement(bot, entry, origWrite);
    installTransferHandler(bot, entry);
    attachHunger(bot, entry);

    // Start anti-AFK after login (valid entity yaw/pitch; not during the
    // pre-login security screen).
    bot.once("login", () => {
      antiAfk.schedule(botId, entry, bot);
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    // Send client settings for the initial login (belt-and-suspenders — the
    // write interceptor already guarantees mineflayer's auto-send is correct).
    setTimeout(() => {
      if (!bot || bot._client?.ended) return;
      try {
        sendClientSettings(bot._client);
        console.log(`[FreshSmpProfile] ✅ [${entry.minecraftUser}] Client settings sent (initial login)`);
      } catch (err) {
        console.warn(`[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] Could not send client settings:`, err.message);
      }
    }, 1000);

    const { onFreshSmpSpawned } = callbacks || {};
    gamemode.runGamemodeFlow(botId, entry, bot, onFreshSmpSpawned).catch((err) => {
      console.warn(`[FreshSmpProfile] ⚠️ runGamemodeFlow error for ${entry.minecraftUser}:`, err.message);
    });
  }

  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    const lower = (reasonText || "").toLowerCase();
    if (lower.includes("server error") || lower.includes("internal error")) {
      console.warn(
        `[FreshSmpProfile] ⚠️ [${entry?.minecraftUser}] SERVER ERROR kick — ` +
        `FreshSMP rejected the connection (malformed or missing packet). ` +
        `Raw reason: ${reasonText}`
      );
      if (entry) entry.errorCategory = "freshsmp_server_error";
    }
    return false;
  }

  onError(bot, entry, botId, err, spawnBot) { return false; }
  onEnd(bot, entry, botId, reason, spawnBot) { return false; }

  onCleanup(botId) {
    gamemode.cancelPendingGamemode(botId);
    antiAfk.cancel(botId);
  }

  // ── Public gamemode API (called by botmanager via profiles.freshsmp) ────────
  selectGamemode(botId, gm) {
    return gamemode.selectGamemode(botId, gm);
  }

  sendQueueCommand(activeBots, botId, gm) {
    return gamemode.sendQueueCommand(activeBots, botId, gm);
  }
}

module.exports = {
  FreshSmpProfile,
  FRESHSMP_VERSION,
  FRESHSMP_GAMEMODES: gamemode.FRESHSMP_GAMEMODES,
};
