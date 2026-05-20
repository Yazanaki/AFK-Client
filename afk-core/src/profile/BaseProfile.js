"use strict";

/**
 * BaseProfile — mineflayer lifecycle base class.
 *
 * All server-specific profiles extend this and override the hooks they need.
 * Every hook has a safe no-op default so profiles only implement what they need.
 *
 * Lifecycle hooks called by botmanager:
 *   onBotCreated(bot, entry, botId, spawnBot)
 *   onLogin(bot, entry, botId, spawnBot, callbacks)
 *   onSpawn(bot, entry, botId)
 *   onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) → bool
 *   onError(bot, entry, botId, err, spawnBot) → bool
 *   onEnd(bot, entry, botId, reason, spawnBot) → bool
 *   onCleanup(botId)
 */
class BaseProfile {
  /**
   * @param {string} id      - profile identifier (e.g. "default", "donutsmp")
   * @param {string} version - fixed version string, or "auto" to let botmanager decide
   */
  constructor(id, version) {
    this.id = id;
    // "auto" = botmanager uses version cache / auto-detection
    // anything else = botmanager always uses this exact version
    this.version = version || "auto";
  }

  // ── Lifecycle hooks ─────────────────────────────────────────────────────────

  /**
   * Called immediately after mineflayer.createBot() succeeds.
   * Good place to attach raw packet listeners that need to fire before login.
   */
  // eslint-disable-next-line no-unused-vars
  onBotCreated(bot, entry, botId, spawnBot) {}

  /**
   * Called on the bot's `login` event.
   * Good place to send callbacks, start timers, or do post-login setup.
   * @param {object} callbacks - { onLinkVerified, onFreshSmpSpawned }
   */
  // eslint-disable-next-line no-unused-vars
  onLogin(bot, entry, botId, spawnBot, callbacks) {}

  /**
   * Called on the bot's `spawn` event (world fully loaded).
   */
  // eslint-disable-next-line no-unused-vars
  onSpawn(bot, entry, botId) {}

  /**
   * Called when the bot is kicked.
   * Return true if the profile fully handled the kick (botmanager skips its default logic).
   * Return false to let botmanager apply its default reconnect/stop behaviour.
   *
   * @param {object}   autoVersionState - mutable { index } — increment to rotate version
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    return false;
  }

  /**
   * Called on bot error events.
   * Return true if fully handled, false to let botmanager apply default logic.
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  onError(bot, entry, botId, err, spawnBot) {
    return false;
  }

  /**
   * Called on the bot's `end` event.
   * Return true if fully handled, false to let botmanager apply default logic.
   * @returns {boolean}
   */
  // eslint-disable-next-line no-unused-vars
  onEnd(bot, entry, botId, reason, spawnBot) {
    return false;
  }

  /**
   * Called when botmanager fully removes this bot from the registry (any reason).
   * Use this to cancel pending timers or promises held by the profile instance.
   */
  // eslint-disable-next-line no-unused-vars
  onCleanup(botId) {}
}

module.exports = { BaseProfile };