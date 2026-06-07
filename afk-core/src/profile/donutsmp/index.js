// afk-core/src/profile/donutsmp/index.js
"use strict";

// DonutSMP profile — orchestrates the self-contained behaviors in this folder:
//   movement.js      — freeze movement (anti-detection)
//   keepAlive.js     — keep_alive echo + ping/pong + TCP keepalive
//   antiAfk.js       — periodic head turn (anti-AFK-kick)
//   verification.js  — Discord-verification reconnect handling
//   hunger.js        — auto-eat (attached here once added)

const { BaseProfile } = require("../BaseProfile");
const { installMovementSuppression } = require("./movement");
const { installKeepAlive } = require("./keepAlive");
const antiAfk = require("./antiAfk");
const verification = require("./verification");

const DONUTSMP_VERSION = "1.21.11";

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
  }

  buildClientOptions(base) {
    // We handle keep_alive ourselves (keepAlive.js), so disable the built-in.
    return { ...base, keepAlive: false };
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    const origWrite = installMovementSuppression(bot);
    entry._donutOrigWrite = origWrite;

    installKeepAlive(bot, origWrite);

    // Wait for login so we have a valid entity yaw/pitch and aren't sending
    // look packets during the pre-login security screen.
    bot.once("login", () => {
      antiAfk.schedule(botId, entry, bot);
    });

    console.log(
      `[DonutSmpProfile] ✅ Handlers attached — movement block + manual keep-alive + ping/pong + anti-AFK + TCP keepalive active`
    );
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {}
  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    return verification.handleKick(entry, reasonText, spawnBot, DONUTSMP_VERSION);
  }

  onError(bot, entry, botId, err, spawnBot) {
    return verification.handleError(entry, err, spawnBot, DONUTSMP_VERSION);
  }

  onEnd(bot, entry, botId, reason, spawnBot) {
    return verification.handleEnd(entry, reason, spawnBot, DONUTSMP_VERSION);
  }

  onCleanup(botId) {
    antiAfk.cancel(botId);
  }
}

module.exports = { DonutSmpProfile, DONUTSMP_VERSION };
