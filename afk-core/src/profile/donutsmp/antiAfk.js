// afk-core/src/profile/donutsmp/antiAfk.js
"use strict";

// DonutSMP anti-AFK-kick — a small periodic action so the server never marks the
// bot as idle. Timers are keyed by botId so multiple bots don't interfere.
//
// ── DESIGN: non-look + deliberately NON-metronomic ───────────────────────────
// Two hard constraints from the forensic history:
//   1. The anti-AFK head turn (`look`) was correlated with all four "Invalid
//      sequence" kicks, so we send NO `look` packets here.
//   2. A high-frequency, perfectly-timed packet stream is a botting signature —
//      a ~20/s `flying` flood got an account BANNED. So this stays LOW frequency
//      (one action every few minutes) AND randomized, so there is no fixed
//      pattern to fingerprint: random interval, random action, random duration.
//
// Action pool (both are ordinary human input, stateless, and touch neither the
// movement/look stream nor the held item, so they can't interfere with eating):
//   • SNEAK pulse   — setControlState -> entity_action start/stop sneaking
//   • ARM swing     — swingArm -> arm_animation
// The bot is frozen in place (position/position_look suppressed), so sneaking
// never actually moves it.

const ANTI_AFK_MIN_MS   = 150 * 1000; // 2.5 min — low end of the random interval
const ANTI_AFK_MAX_MS   = 390 * 1000; // 6.5 min — high end
const SNEAK_HOLD_MIN_MS = 350;        // randomized crouch duration
const SNEAK_HOLD_MAX_MS = 1900;

const _state = new Map(); // botId -> { timer, releaseTimer, bot }

const rand = (a, b) => a + Math.random() * (b - a);

function schedule(botId, entry, bot) {
  cancel(botId);
  const delayMs = rand(ANTI_AFK_MIN_MS, ANTI_AFK_MAX_MS);
  const timer = setTimeout(() => pulse(botId, entry, bot), delayMs);
  _state.set(botId, { timer, releaseTimer: null, bot });
}

function pulse(botId, entry, bot) {
  if (entry.status !== "online") return;
  if (!bot || bot._client?.ended) return;

  // Pick a random action so there's no fixed per-pulse signature.
  const action = Math.random() < 0.5 ? "sneak" : "swing";

  try {
    if (action === "swing") {
      bot.swingArm("right");
      console.log(`[DonutSmpProfile] 👋 [${entry.minecraftUser}] Anti-AFK swing`);
      schedule(botId, entry, bot); // stateless, no hold — reschedule now
      return;
    }

    // sneak: crouch for a randomized hold, then release and reschedule.
    bot.setControlState("sneak", true);
    const holdMs = Math.round(rand(SNEAK_HOLD_MIN_MS, SNEAK_HOLD_MAX_MS));
    console.log(`[DonutSmpProfile] 🧎 [${entry.minecraftUser}] Anti-AFK sneak (${holdMs}ms)`);

    const releaseTimer = setTimeout(() => {
      if (bot && !bot._client?.ended) {
        try { bot.setControlState("sneak", false); } catch (_) {}
      }
      if (entry.status === "online") schedule(botId, entry, bot);
    }, holdMs);

    _state.set(botId, { timer: null, releaseTimer, bot });
  } catch (err) {
    console.warn(`[DonutSmpProfile] ⚠️ [${entry.minecraftUser}] Anti-AFK action failed:`, err.message);
    try { bot.setControlState("sneak", false); } catch (_) {}
    schedule(botId, entry, bot); // never orphan the loop
  }
}

function cancel(botId) {
  const st = _state.get(botId);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  if (st.releaseTimer) clearTimeout(st.releaseTimer);
  // Make sure we never leave the bot stuck crouching.
  if (st.bot && !st.bot._client?.ended) {
    try { st.bot.setControlState("sneak", false); } catch (_) {}
  }
  _state.delete(botId);
}

module.exports = { schedule, cancel };
