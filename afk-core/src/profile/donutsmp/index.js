// afk-core/src/profile/donutsmp/index.js
"use strict";

// DonutSMP profile — orchestrates the self-contained behaviors in this folder:
//   diagnostics.js   — forensic packet ring buffer, dumped on every disconnect
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
const { attachHunger } = require("./hunger");
const diagnostics = require("./diagnostics");
const reconnect = require("../reconnect");

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
    // Install diagnostics FIRST so it wraps the raw client write before movement
    // suppression rebinds it — that way every actually-sent packet is captured.
    diagnostics.installDiagnostics(bot, entry);

    const origWrite = installMovementSuppression(bot);
    entry._donutOrigWrite = origWrite;

    installKeepAlive(bot, origWrite);
    attachHunger(bot, entry);

    // Wait for login so we have a valid entity yaw/pitch and aren't sending
    // look packets during the pre-login security screen.
    bot.once("login", () => {
      antiAfk.schedule(botId, entry, bot);
    });

    console.log(
      `[DonutSmpProfile] ✅ Handlers attached — movement block + manual keep-alive + ping/pong + idle-client mode (no anti-AFK actions) + TCP keepalive + hunger active`
    );
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {}

  onSpawn(bot, entry, botId) {
    // A successful spawn means we cleared any verification gate. Reset the
    // per-episode verification retry counter so a later genuine verification
    // (e.g. a new IP) starts fresh — and so ordinary, unrelated kicks during a
    // healthy session never accumulate toward the "give up" limit.
    entry.donutSmpVerificationRetries = 0;
  }

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    diagnostics.dump(entry, reasonText);
    return verification.handleKick(entry, reasonText, spawnBot, DONUTSMP_VERSION);
  }

  onError(bot, entry, botId, err, spawnBot) {
    diagnostics.dump(entry, err && err.message ? `error: ${err.message}` : "error");
    // Pre-login socket resets are handled as verification retries; anything it
    // doesn't claim that is still a silent TCP drop is auto-recovered here.
    if (verification.handleError(entry, err, spawnBot, DONUTSMP_VERSION)) return true;
    if (reconnect.isSilentDropError(err)) {
      return reconnect.scheduleSilentReconnect(entry, botId, spawnBot, DONUTSMP_VERSION, err.code);
    }
    return false;
  }

  onEnd(bot, entry, botId, reason, spawnBot) {
    diagnostics.dump(entry, reason);
    // Verification-window socketClosed → verification retry (existing behaviour).
    if (verification.handleEnd(entry, reason, spawnBot, DONUTSMP_VERSION)) return true;
    // Any other silent socket close (mid-session) → auto-reconnect with backoff,
    // independent of AUTO_RECONNECT, so the bot doesn't drop offline for good.
    if (reconnect.isSilentDropReason(reason)) {
      return reconnect.scheduleSilentReconnect(entry, botId, spawnBot, DONUTSMP_VERSION, reason);
    }
    return false;
  }

  onCleanup(botId) {
    antiAfk.cancel(botId);
    reconnect.cancel(botId);
  }
}

module.exports = { DonutSmpProfile, DONUTSMP_VERSION };
