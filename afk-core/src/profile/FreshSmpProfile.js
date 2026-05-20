"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * FreshSmpProfile — mineflayer profile for FreshSMP / ElementalMC.
 *
 * ALL FreshSMP-specific logic lives here:
 *   - Version: always 1.21.11
 *   - Ping/pong handling (Paper server)
 *   - Gamemode queue flow: waits for Discord user to pick a gamemode,
 *     then sends /queue <gamemode> after a stabilisation delay
 */

const FRESHSMP_VERSION = "1.21.11";
const QUEUE_COMMAND_DELAY_MS = 2000;
const GAMEMODE_SELECTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const FRESHSMP_GAMEMODES = {
  survival:  "survival",
  lifesteal: "lifesteal",
  skywars:   "skywars",
};

class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", FRESHSMP_VERSION);
    // Map<botId, { resolve, timer }> — pending gamemode selections
    this._pendingGamemode = new Map();
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    // FreshSMP runs on Paper — handle ping/pong
    bot._client.on("ping", (packet) => {
      try {
        bot._client.write("pong", { id: packet.id });
      } catch (_) {}
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    const { onFreshSmpSpawned } = callbacks || {};

    // Kick off the async gamemode selection flow — fire-and-forget
    this.runGamemodeFlow(botId, entry, bot, onFreshSmpSpawned).catch((err) => {
      console.warn(`[FreshSmpProfile] ⚠️ runGamemodeFlow error for ${entry.minecraftUser}:`, err.message);
    });
  }

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

  onCleanup(botId) {
    this.cancelPendingGamemode(botId);
  }

  // ── Gamemode queue flow ────────────────────────────────────────────────────

  async runGamemodeFlow(botId, entry, bot, onFreshSmpSpawned) {
    if (typeof onFreshSmpSpawned === "function") {
      try { onFreshSmpSpawned(botId); }
      catch (err) {
        console.warn(`[FreshSmpProfile] ⚠️ onFreshSmpSpawned threw:`, err.message);
      }
    }

    let chosenGamemode;
    try {
      console.log(`[FreshSmpProfile] 🟢 [${entry.minecraftUser}] Waiting for gamemode selection...`);
      chosenGamemode = await this._waitForGamemode(botId);
    } catch {
      console.warn(
        `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] ` +
        `Gamemode selection timed out — bot stays connected but /queue not sent`
      );
      return;
    }

    if (!entry.bot || entry.bot !== bot || entry.status !== "online") return;

    await new Promise((r) => setTimeout(r, QUEUE_COMMAND_DELAY_MS));

    if (!entry.bot || entry.bot !== bot || entry.status !== "online") return;

    try {
      bot.chat(`/queue ${chosenGamemode}`);
      entry.freshSmpGamemode = chosenGamemode;
      entry.freshSmpQueueSent = true;
      console.log(`[FreshSmpProfile] 🟢 [${entry.minecraftUser}] Sent /queue ${chosenGamemode}`);
    } catch (err) {
      console.error(`[FreshSmpProfile] ❌ Failed to send /queue ${chosenGamemode}:`, err.message);
    }
  }

  selectGamemode(botId, gamemode) {
    const key = String(gamemode || "").toLowerCase();
    const queueArg = FRESHSMP_GAMEMODES[key];
    if (!queueArg) return { success: false, reason: "unknown_gamemode" };

    const pending = this._pendingGamemode.get(botId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingGamemode.delete(botId);
      pending.resolve(queueArg);
      console.log(`[FreshSmpProfile] 🎮 Gamemode "${queueArg}" selected for ${botId}`);
      return { success: true, gamemode: queueArg };
    }

    return { success: false, reason: "no_pending_selection" };
  }

  sendQueueCommand(activeBots, botId, gamemode) {
    const key = String(gamemode || "").toLowerCase();
    const queueArg = FRESHSMP_GAMEMODES[key];
    if (!queueArg) return { success: false, reason: "unknown_gamemode" };

    const entry = activeBots.get(botId);
    if (!entry) return { success: false, reason: "bot_not_found" };
    if (!entry.bot) return { success: false, reason: "bot_instance_missing" };
    if (entry.status !== "online") return { success: false, reason: "bot_not_online" };

    try {
      entry.bot.chat(`/queue ${queueArg}`);
      entry.freshSmpGamemode = queueArg;
      entry.freshSmpQueueSent = true;
      console.log(`[FreshSmpProfile] 🎮 Sent /queue ${queueArg} for ${entry.minecraftUser}`);
      return { success: true, gamemode: queueArg };
    } catch (err) {
      return { success: false, reason: "chat_failed", error: err.message };
    }
  }

  cancelPendingGamemode(botId) {
    const pending = this._pendingGamemode.get(botId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingGamemode.delete(botId);
    }
  }

  _waitForGamemode(botId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingGamemode.delete(botId);
        reject(new Error("gamemode_selection_timeout"));
      }, GAMEMODE_SELECTION_TIMEOUT_MS);
      this._pendingGamemode.set(botId, { resolve, timer });
    });
  }
}

module.exports = { FreshSmpProfile, FRESHSMP_VERSION, FRESHSMP_GAMEMODES };