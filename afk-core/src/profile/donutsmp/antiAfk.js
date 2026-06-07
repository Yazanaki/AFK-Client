// afk-core/src/profile/donutsmp/antiAfk.js
"use strict";

// DonutSMP anti-AFK-kick — a small periodic head turn so the server never marks
// the bot as idle. Uses bot.look() (the correct 1.21.2+ packet) and returns to
// the original yaw shortly after. Timers are keyed by botId so multiple bots
// don't interfere.

const ANTI_AFK_MIN_MS = 3 * 60 * 1000;
const ANTI_AFK_MAX_MS = 6 * 60 * 1000;
const ANTI_AFK_YAW_DELTA_MIN = 2;
const ANTI_AFK_YAW_DELTA_MAX = 8;
const ANTI_AFK_RETURN_DELAY_MS = 1500;

const _timers = new Map();

function schedule(botId, entry, bot) {
  cancel(botId);

  const delayMs =
    ANTI_AFK_MIN_MS + Math.floor(Math.random() * (ANTI_AFK_MAX_MS - ANTI_AFK_MIN_MS));

  const timerId = setTimeout(() => {
    _timers.delete(botId);
    nudge(botId, entry, bot);
  }, delayMs);

  _timers.set(botId, timerId);
}

function nudge(botId, entry, bot) {
  if (entry.status !== "online") return;
  if (!bot || bot._client?.ended) return;

  const currentYaw = (bot.entity && typeof bot.entity.yaw === "number") ? bot.entity.yaw : 0;
  const currentPitch = (bot.entity && typeof bot.entity.pitch === "number") ? bot.entity.pitch : 0;

  const deltaDeg =
    ANTI_AFK_YAW_DELTA_MIN + Math.random() * (ANTI_AFK_YAW_DELTA_MAX - ANTI_AFK_YAW_DELTA_MIN);
  const deltaRad = (deltaDeg * Math.PI) / 180;
  const direction = Math.random() < 0.5 ? 1 : -1;
  const nudgedYaw = currentYaw + direction * deltaRad;

  bot.look(nudgedYaw, currentPitch, true);
  console.log(
    `[DonutSmpProfile] 👀 [${entry.minecraftUser}] Anti-AFK nudge ` +
    `${direction > 0 ? "+" : ""}${(direction * deltaDeg).toFixed(1)}° yaw`
  );

  setTimeout(() => {
    if (entry.status !== "online") return;
    if (!bot || bot._client?.ended) return;
    bot.look(currentYaw, currentPitch, true);
    schedule(botId, entry, bot);
  }, ANTI_AFK_RETURN_DELAY_MS);
}

function cancel(botId) {
  const timerId = _timers.get(botId);
  if (timerId != null) {
    clearTimeout(timerId);
    _timers.delete(botId);
  }
}

module.exports = { schedule, cancel };
