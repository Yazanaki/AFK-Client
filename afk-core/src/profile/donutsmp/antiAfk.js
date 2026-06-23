// afk-core/src/profile/donutsmp/antiAfk.js
"use strict";

// DonutSMP anti-AFK-kick — a small periodic action so the server never marks the
// bot as idle. Timers are keyed by botId so multiple bots don't interfere.
//
// ── WHY THIS NO LONGER USES bot.look() ───────────────────────────────────────
// Four "Invalid sequence" kicks were captured end-to-end. The ONLY thing
// correlated with every one was the anti-AFK head turn: the kick landed
// 130-138ms after a `look` nudge, 4 times out of 4, after ~10 nudges / ~40 min.
// Everything else was ruled out (no eating, ping:pong 1:1, keep-alive clean,
// mineflayer 4.37.1 with the aim fix). So we stop sending `look` packets for
// anti-AFK entirely and use a non-rotation action instead.
//
// We pulse SNEAK (setControlState -> `entity_action` start/stop sneaking): it is
// discrete player input the server counts as activity, it does not touch the
// movement/rotation packet stream that was correlated with the kick, and it is
// fully reversible. The bot is frozen in place (position/position_look are
// suppressed), so sneaking never actually moves it.

const ANTI_AFK_MIN_MS = 3 * 60 * 1000;
const ANTI_AFK_MAX_MS = 6 * 60 * 1000;
const ANTI_AFK_HOLD_MS = 1500; // hold sneak this long, then release

const _timers = new Map();

function schedule(botId, entry, bot) {
  cancel(botId);

  const delayMs =
    ANTI_AFK_MIN_MS + Math.floor(Math.random() * (ANTI_AFK_MAX_MS - ANTI_AFK_MIN_MS));

  const timerId = setTimeout(() => {
    _timers.delete(botId);
    pulse(botId, entry, bot);
  }, delayMs);

  _timers.set(botId, timerId);
}

function pulse(botId, entry, bot) {
  if (entry.status !== "online") return;
  if (!bot || bot._client?.ended) return;

  try {
    bot.setControlState("sneak", true);
    console.log(`[DonutSmpProfile] 🧎 [${entry.minecraftUser}] Anti-AFK sneak pulse`);

    setTimeout(() => {
      if (!bot || bot._client?.ended) return;
      try { bot.setControlState("sneak", false); } catch (_) {}
      if (entry.status !== "online") return;
      schedule(botId, entry, bot);
    }, ANTI_AFK_HOLD_MS);
  } catch (err) {
    console.warn(`[DonutSmpProfile] ⚠️ [${entry.minecraftUser}] Anti-AFK sneak failed:`, err.message);
    // Make sure sneak isn't left stuck on, and never orphan the loop.
    try { bot.setControlState("sneak", false); } catch (_) {}
    schedule(botId, entry, bot);
  }
}

function cancel(botId) {
  const timerId = _timers.get(botId);
  if (timerId != null) {
    clearTimeout(timerId);
    _timers.delete(botId);
  }
}

module.exports = { schedule, cancel };
