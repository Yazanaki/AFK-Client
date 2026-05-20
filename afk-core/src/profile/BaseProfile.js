"use strict";

/**
 * BaseProfile — mineflayer lifecycle base class.
 * All server-specific profiles extend this and override the hooks they need.
 */
class BaseProfile {
  constructor(id, version) {
    this.id = id;
    this.version = version || "auto";
  }

  // eslint-disable-next-line no-unused-vars
  onBotCreated(bot, entry, botId, spawnBot) {}
  // eslint-disable-next-line no-unused-vars
  onLogin(bot, entry, botId, spawnBot, callbacks) {}
  // eslint-disable-next-line no-unused-vars
  onSpawn(bot, entry, botId) {}
  // eslint-disable-next-line no-unused-vars
  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) { return false; }
  // eslint-disable-next-line no-unused-vars
  onError(bot, entry, botId, err, spawnBot) { return false; }
  // eslint-disable-next-line no-unused-vars
  onEnd(bot, entry, botId, reason, spawnBot) { return false; }
  // eslint-disable-next-line no-unused-vars
  onCleanup(botId) {}
}

module.exports = { BaseProfile };