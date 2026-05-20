"use strict";

/**
 * BaseProfile — base class for all server-specific mineflayer bot profiles.
 *
 * Each profile encapsulates:
 *   - The Minecraft version(s) required for this server
 *   - Anti-cheat / movement suppression logic
 *   - Server-specific reconnect/retry logic
 *   - Any custom event handlers needed post-login
 *
 * Profiles are selected by botmanager via the profile registry (profiles/index.js)
 * which maps host patterns to profile instances.
 */
class BaseProfile {
  /**
   * @param {string} id         - Unique profile ID (e.g. "donutsmp", "freshsmp")
   * @param {string} version    - The exact Minecraft version string to use for this server
   */
  constructor(id, version) {
    this.id = id;
    this.version = version; // Concrete version — no "auto" at the profile level
  }

  /**
   * Called once immediately after mineflayer.createBot() succeeds.
   * Use this to install raw packet listeners, movement blocks, etc.
   *
   * @param {object} bot        - mineflayer bot instance
   * @param {object} entry      - botmanager registry entry for this bot
   * @param {string} botId      - canonical bot key
   * @param {Function} spawnBot - function(version) to trigger a reconnect attempt
   */
  // eslint-disable-next-line no-unused-vars
  onBotCreated(bot, entry, botId, spawnBot) {
    // no-op by default
  }

  /**
   * Called when the bot fires its "login" event (successfully authenticated).
   * Use this for post-login setup: client settings, timers, callbacks, etc.
   *
   * @param {object} bot
   * @param {object} entry
   * @param {string} botId
   * @param {Function} spawnBot
   * @param {{ onLinkVerified: Function|null, onFreshSmpSpawned: Function|null }} callbacks
   */
  // eslint-disable-next-line no-unused-vars
  onLogin(bot, entry, botId, spawnBot, callbacks) {
    // no-op by default
  }

  /**
   * Called when the bot fires "kicked".
   * Return true if the profile has fully handled the kick (botmanager won't apply
   * its default kick logic). Return false to fall through to default handling.
   *
   * @param {object} bot
   * @param {object} entry
   * @param {string} botId
   * @param {string} reasonText   - kick reason as a plain string
   * @param {Function} spawnBot
   * @param {boolean} autoMode
   * @param {string[]} autoCandidates
   * @param {{ index: number }} autoVersionState  - mutable object so profile can mutate index
   * @returns {boolean} handled
   */
  // eslint-disable-next-line no-unused-vars
  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, autoCandidates, autoVersionState) {
    return false;
  }

  /**
   * Called when the bot fires "error".
   * Return true if the profile has fully handled the error.
   *
   * @param {object} bot
   * @param {object} entry
   * @param {string} botId
   * @param {Error} err
   * @param {Function} spawnBot
   * @returns {boolean} handled
   */
  // eslint-disable-next-line no-unused-vars
  onError(bot, entry, botId, err, spawnBot) {
    return false;
  }

  /**
   * Called when the bot fires "end".
   * Return true if the profile has fully handled the disconnect.
   *
   * @param {object} bot
   * @param {object} entry
   * @param {string} botId
   * @param {string} reason
   * @param {Function} spawnBot
   * @returns {boolean} handled
   */
  // eslint-disable-next-line no-unused-vars
  onEnd(bot, entry, botId, reason, spawnBot) {
    return false;
  }

  /**
   * Called when the bot fires "spawn" (player entity spawned in world).
   *
   * @param {object} bot
   * @param {object} entry
   * @param {string} botId
   */
  // eslint-disable-next-line no-unused-vars
  onSpawn(bot, entry, botId) {
    // no-op by default
  }

  /**
   * Called when cleanupBot() removes this bot from the registry.
   * Use to cancel any pending timers or promises owned by the profile.
   *
   * @param {string} botId
   */
  // eslint-disable-next-line no-unused-vars
  onCleanup(botId) {
    // no-op by default
  }
}

module.exports = { BaseProfile };