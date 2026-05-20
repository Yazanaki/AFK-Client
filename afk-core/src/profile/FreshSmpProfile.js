"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * FreshSmpProfile
 *
 * ALL FreshSMP-specific logic lives here:
 *   - Version: always 1.21.11
 *   - Ping/pong handling
 *   - Hunger management via HungerHandler
 *   - Gamemode queue flow: waits for Discord user to pick a gamemode,
 *     then sends /queue <gamemode> after a stabilisation delay
 */

const FRESHSMP_VERSION = "1.21.11";
const QUEUE_COMMAND_DELAY_MS = 2000;
const GAMEMODE_SELECTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const FRESHSMP_GAMEMODES = {
  survival: "survival",
  lifesteal: "lifesteal",
  skywars: "skywars",
};

class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", [FRESHSMP_VERSION]);
    this._hungerHandler = null;
    // Map<botId, { resolve, timer }> — pending gamemode selections
    this._pendingGamemode = new Map();
  }

  // ── Version ────────────────────────────────────────────────────────────────

  getVersion() {
    return FRESHSMP_VERSION;
  }

  // ── buildClientOptions ─────────────────────────────────────────────────────

  buildClientOptions(baseOptions, session) {
    if (session) session.version = FRESHSMP_VERSION;
    return {
      ...baseOptions,
      version: FRESHSMP_VERSION,
      brand: "vanilla",
    };
  }

  // ── attachHandlers ─────────────────────────────────────────────────────────

  attachHandlers(client, session) {
    const version = FRESHSMP_VERSION;
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    // FreshSMP runs on Paper — handle ping/pong
    client.on("ping", (packet) => {
      try {
        client.write("pong", { id: packet.id });
      } catch (_) {}
    });

    client.on("plugin_message", () => {
      // Future: inspect FreshSMP-specific plugin channels if needed
    });
  }

  // ── tick ───────────────────────────────────────────────────────────────────

  tick(session, client, nowMs) {
    if (session.state !== "online") return;
    if (this._hungerHandler) this._hungerHandler.tick(client);
  }

  // ── Gamemode queue flow ────────────────────────────────────────────────────

  /**
   * Called by botmanager after login to kick off the gamemode selection flow.
   * Fires onFreshSmpSpawned so the Discord bot can show the selector embed,
   * then waits for selectGamemode() to be called before sending /queue.
   *
   * @param {string}   botId
   * @param {object}   entry        - botmanager registry entry
   * @param {object}   bot          - mineflayer bot instance
   * @param {Function} onFreshSmpSpawned
   */
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

  /**
   * Resolve the pending gamemode promise for a bot.
   * Called when the Discord user clicks a gamemode button.
   */
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

  /**
   * Send /queue directly when there's no pending promise (re-queue scenario).
   */
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

  /**
   * Cancel any pending gamemode wait for a bot (called on disconnect/cleanup).
   */
  cancelPendingGamemode(botId) {
    const pending = this._pendingGamemode.get(botId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingGamemode.delete(botId);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

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