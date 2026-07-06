// afk-core/src/profile/freshsmp/index.js
"use strict";

// FreshSMP profile — orchestrates the self-contained behaviors in this folder:
//   diagnostics.js forensic packet/state capture, dumped on every disconnect
//   settings.js   client_information field-filler + config-state movement drop
//   lifecycle.js  always-on lifecycle logger + ring-buffer dump on kick
//   keepAlive.js  keep_alive echo + ping logging + cookie_response
//   movement.js   per-tick flying keepalive (anti-detection)
//   transfer.js   re-send settings in PLAY after a Velocity transfer
//   chat.js       reset signed-chat acknowledgment state on transfer
//   antiAfk.js    idle-client mode (no anti-AFK actions sent)
//   gamemode.js   /queue gamemode flow
//   hunger.js     auto-eat (attached here once added)

const { BaseProfile } = require("../BaseProfile");
const diagnostics = require("./diagnostics");
const { installSettingsInterceptor, sendClientSettings } = require("./settings");
const { installLifecycleLogger } = require("./lifecycle");
const { installKeepAlive } = require("./keepAlive");
const { installPerTickMovement } = require("./movement");
const { installTransferHandler } = require("./transfer");
const { installChatSessionReset } = require("./chat");
const antiAfk = require("./antiAfk");
const gamemode = require("./gamemode");
const { attachHunger } = require("./hunger");
const reconnect = require("../reconnect");

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

    // Diagnostics FIRST — it wraps the RAW bot._client.write before the settings
    // interceptor rebinds it, so every actually-sent packet (settings-patched and
    // origWrite-bypassed alike) is captured for the forensic dump.
    diagnostics.installDiagnostics(bot, entry);

    // The settings interceptor wraps bot._client.write (capturing the diagnostics
    // writer as its origWrite) and returns that original (bound) write, which the
    // keepalive/movement handlers use to bypass the settings patch.
    const origWrite = installSettingsInterceptor(bot, entry);
    installLifecycleLogger(bot, entry);
    installKeepAlive(bot, entry, origWrite);
    installPerTickMovement(bot, entry, origWrite);
    installTransferHandler(bot, entry);
    installChatSessionReset(bot, entry);
    attachHunger(bot, entry);

    // Idle-client mode: no anti-AFK actions. schedule() is a documented no-op.
    bot.once("login", () => {
      antiAfk.schedule(botId, entry, bot);
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    // Send client settings for the initial login (belt-and-suspenders — the
    // write interceptor already guarantees mineflayer's auto-send is correct).
    // Only in PLAY: if a transfer is mid-flight at this 1s mark, sending
    // client_information during configuration SERVER-ERRORs us (transfer.js
    // re-sends settings once back in play).
    setTimeout(() => {
      if (!bot || bot._client?.ended || bot._client.state !== "play") return;
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
    diagnostics.dump(entry, reasonText);
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

  onError(bot, entry, botId, err, spawnBot) {
    diagnostics.dump(entry, err && err.message ? `error: ${err.message}` : "error");
    // A raw TCP drop (ECONNRESET / EPIPE / ETIMEDOUT) carries no kick reason —
    // auto-recover it with backoff instead of letting the bot go offline.
    if (reconnect.isSilentDropError(err)) {
      return reconnect.scheduleSilentReconnect(entry, botId, spawnBot, FRESHSMP_VERSION, err.code);
    }
    return false;
  }
  onEnd(bot, entry, botId, reason, spawnBot) {
    diagnostics.dump(entry, reason);
    // socketClosed / keepalive_timeout = the server or its Velocity proxy closed
    // the connection silently. Reconnect automatically with backoff.
    if (reconnect.isSilentDropReason(reason)) {
      return reconnect.scheduleSilentReconnect(entry, botId, spawnBot, FRESHSMP_VERSION, reason);
    }
    return false;
  }

  onCleanup(botId) {
    gamemode.cancelPendingGamemode(botId);
    antiAfk.cancel(botId);
    reconnect.cancel(botId);
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
