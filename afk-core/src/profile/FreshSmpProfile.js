"use strict";

const { BaseProfile } = require("./BaseProfile");
const { _sendClientSettings } = require("./DefaultProfile");

// ─── FreshSMP constants ────────────────────────────────────────────────────────

/** Exact version FreshSMP requires. */
const FRESHSMP_VERSION = "1.21.11";

/**
 * ms to wait after login before sending /queue <gamemode>.
 * Gives the server time to fully initialise the player session.
 */
const QUEUE_COMMAND_DELAY_MS = 2000;

/** ms the bot waits for the Discord user to pick a gamemode before timing out */
const GAMEMODE_SELECTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Valid FreshSMP gamemodes → /queue argument */
const FRESHSMP_GAMEMODES = {
  survival: "survival",
  lifesteal: "lifesteal",
  skywars: "skywars",
};

/**
 * FreshSmpProfile
 *
 * Encapsulates ALL FreshSMP-specific quirks:
 *
 *   VERSION
 *     Always connects with 1.21.11 — no auto-detection.
 *
 *   GAMEMODE QUEUE FLOW
 *     1. onLogin fires → calls onFreshSmpSpawned callback so the Discord
 *        bot knows to show the gamemode selector embed.
 *     2. The bot then waits for a gamemode selection (resolved via
 *        selectGamemode(), called from the API route handler).
 *     3. After QUEUE_COMMAND_DELAY_MS it sends /queue <gamemode>.
 *
 *   PING / PONG
 *     Handled the same as DefaultProfile since FreshSMP also runs on Paper.
 */
class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", FRESHSMP_VERSION);

    /**
     * Map<botId, { resolve: Function, timer: NodeJS.Timeout }>
     * Pending gamemode selection promises, keyed by botId.
     */
    this._pendingGamemode = new Map();
  }

  // ── onBotCreated ────────────────────────────────────────────────────────────

  onBotCreated(bot, entry, botId, spawnBot) {
    // Handle ping/pong — FreshSMP runs on Paper
    bot._client.on("ping", (packet) => {
      try {
        bot._client.write("pong", { id: packet.id });
      } catch (_) {}
    });
  }

  // ── onLogin ─────────────────────────────────────────────────────────────────

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    _sendClientSettings(bot, entry.minecraftUser, "post-login");

    const { onLinkVerified, onFreshSmpSpawned } = callbacks || {};
    if (typeof onLinkVerified === "function") {
      try { onLinkVerified(entry.discordId, entry.minecraftUser); } catch (_) {}
    }

    // Kick off the async gamemode flow without blocking the login handler
    this._runGamemodeFlow(bot, entry, botId, onFreshSmpSpawned).catch((err) => {
      console.error(
        `[FreshSmpProfile] ❌ [${entry.minecraftUser}] Gamemode flow error:`,
        err.message
      );
    });
  }

  // ── onEnd / onError — cancel pending gamemode wait ──────────────────────────

  onEnd(bot, entry, botId, reason, spawnBot) {
    this._cancelPendingGamemode(botId);
    return false; // let botmanager apply default end handling
  }

  onError(bot, entry, botId, err, spawnBot) {
    this._cancelPendingGamemode(botId);
    return false; // let botmanager apply default error handling
  }

  // ── onCleanup ────────────────────────────────────────────────────────────────

  onCleanup(botId) {
    this._cancelPendingGamemode(botId);
  }

  // ── Public API — called by the server.js route handler ──────────────────────

  /**
   * Resolve the pending gamemode promise for a bot.
   * Called when the Discord user clicks a gamemode button.
   *
   * @param {string} botId
   * @param {string} gamemode  - one of "survival", "lifesteal", "skywars"
   * @returns {{ success: boolean, gamemode?: string, reason?: string }}
   */
  selectGamemode(botId, gamemode) {
    const gamemodeKey = String(gamemode || "").toLowerCase();
    const queueArg = FRESHSMP_GAMEMODES[gamemodeKey];

    if (!queueArg) {
      console.warn(`[FreshSmpProfile] ⚠️ Unknown gamemode requested: ${gamemode}`);
      return { success: false, reason: "unknown_gamemode" };
    }

    const pending = this._pendingGamemode.get(botId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingGamemode.delete(botId);
      pending.resolve(queueArg);
      console.log(
        `[FreshSmpProfile] 🎮 Gamemode "${queueArg}" selected for ${botId}`
      );
      return { success: true, gamemode: queueArg };
    }

    // No pending promise — bot is already past the selection window.
    // Try sending the command directly if the bot is still online.
    return { success: false, reason: "no_pending_selection" };
  }

  /**
   * Send /queue <gamemode> directly to an already-online bot (re-queue).
   * Used when selectGamemode() finds no pending promise.
   *
   * @param {object} activeBots - the botmanager activeBots Map (passed in)
   * @param {string} botId
   * @param {string} gamemode
   * @returns {{ success: boolean, gamemode?: string, reason?: string }}
   */
  sendQueueCommand(activeBots, botId, gamemode) {
    const gamemodeKey = String(gamemode || "").toLowerCase();
    const queueArg = FRESHSMP_GAMEMODES[gamemodeKey];

    if (!queueArg) {
      return { success: false, reason: "unknown_gamemode" };
    }

    const entry = activeBots.get(botId);
    if (!entry) return { success: false, reason: "bot_not_found" };
    if (!entry.bot) return { success: false, reason: "bot_instance_missing" };
    if (entry.status !== "online") return { success: false, reason: "bot_not_online" };

    try {
      entry.bot.chat(`/queue ${queueArg}`);
      entry.freshSmpGamemode = queueArg;
      entry.freshSmpQueueSent = true;
      console.log(
        `[FreshSmpProfile] 🎮 Sent /queue ${queueArg} for ${entry.minecraftUser}`
      );
      return { success: true, gamemode: queueArg };
    } catch (err) {
      console.error(
        `[FreshSmpProfile] ❌ Failed to send /queue ${queueArg} for ${entry.minecraftUser}:`,
        err.message
      );
      return { success: false, reason: "chat_failed", error: err.message };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  async _runGamemodeFlow(bot, entry, botId, onFreshSmpSpawned) {
    // Notify the Discord bot so it can show the gamemode selector
    if (typeof onFreshSmpSpawned === "function") {
      try { onFreshSmpSpawned(botId); }
      catch (err) {
        console.warn(
          `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] onFreshSmpSpawned callback threw:`,
          err.message
        );
      }
    }

    let chosenGamemode;
    try {
      console.log(
        `[FreshSmpProfile] 🟢 [${entry.minecraftUser}] ` +
        `Waiting for gamemode selection...`
      );
      chosenGamemode = await this._waitForGamemode(botId);
    } catch {
      // Timed out — bot stays connected but /queue was never sent
      console.warn(
        `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] ` +
        `Gamemode selection timed out. Bot remains connected but /queue not sent.`
      );
      return;
    }

    // Verify the bot is still active before sending
    if (!entry.bot || entry.bot !== bot || entry.status !== "online") {
      console.warn(
        `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] ` +
        `Bot no longer online after gamemode selection — skipping /queue`
      );
      return;
    }

    // Short stabilisation delay
    await new Promise((r) => setTimeout(r, QUEUE_COMMAND_DELAY_MS));

    // Check again after the delay
    if (!entry.bot || entry.bot !== bot || entry.status !== "online") return;

    try {
      bot.chat(`/queue ${chosenGamemode}`);
      entry.freshSmpGamemode = chosenGamemode;
      entry.freshSmpQueueSent = true;
      console.log(
        `[FreshSmpProfile] 🟢 [${entry.minecraftUser}] Sent /queue ${chosenGamemode}`
      );
    } catch (err) {
      console.error(
        `[FreshSmpProfile] ❌ [${entry.minecraftUser}] ` +
        `Failed to send /queue ${chosenGamemode}:`,
        err.message
      );
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

  _cancelPendingGamemode(botId) {
    const pending = this._pendingGamemode.get(botId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingGamemode.delete(botId);
    }
  }
}

module.exports = { FreshSmpProfile, FRESHSMP_VERSION, FRESHSMP_GAMEMODES };