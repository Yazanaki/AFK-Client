// afk-core/src/profile/donutsmp/antiAfk.js
"use strict";

// DonutSMP anti-AFK — intentionally a NO-OP (idle-client mode).
//
// A genuinely AFK human — PC on, Minecraft running, player asleep — performs NO
// actions: no head turns, no crouching, no arm swings. Those periodic "nudges"
// are fake activity that reads as MORE bot-like, not less. Two facts from the
// forensic history back this up:
//   • the anti-AFK `look` nudge was correlated with all four "Invalid sequence"
//     kicks (kick landed ~130ms after a nudge, 4/4 times)
//   • a high-frequency movement stream (a ~20/s `flying` flood) is a botting
//     signature that previously got an account banned
//
// So we do the only thing that actually looks like a sleeping player's client:
// nothing. The bot stays connected and idle — keep-alive / pong only. If
// DonutSMP has an AFK-kick, the bot gets kicked exactly as a real idle client
// would (a benign, differently-named kick — NOT "Invalid sequence", NOT a ban)
// and reconnects. The forensic capture stays armed, and the uptime heartbeat
// shows whether it now survives past the ~43 min mark where it always died.
//
// (The previous action-based versions — look nudge, sneak/swing pulses — are in
// git history if a minimal keepalive is ever genuinely required.)

function schedule(botId, entry, bot) {
  // Intentionally idle. Log once per session so the behavior is explicit.
  console.log(
    `[DonutSmpProfile] 😴 [${entry.minecraftUser}] Idle-client mode — no anti-AFK actions sent ` +
    `(behaves like a real client with the player away)`
  );
}

function cancel(botId) {
  // Nothing to cancel in idle mode.
}

module.exports = { schedule, cancel };
