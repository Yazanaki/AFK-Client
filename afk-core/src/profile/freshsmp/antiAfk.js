// afk-core/src/profile/freshsmp/antiAfk.js
"use strict";

// FreshSMP anti-AFK — intentionally a NO-OP (idle-client mode).
//
// A genuinely AFK human (PC on, player asleep) performs NO actions: no head
// turns, no crouches, no swings. Those periodic "nudges" are fake activity that
// reads as MORE bot-like, not less. On DonutSMP the look-based nudge was proven
// (4/4 forensic dumps) to be the cause of its "Invalid sequence" kick, and going
// fully idle held a session online for 4.5h+. FreshSMP runs the same kind of look
// nudge, so we remove it here too — both to drop a known "Invalid sequence" cause
// and to de-risk diagnosing FreshSMP's separate, transfer-triggered kick (no
// rotation packets coinciding with the /queue transfer).
//
// The bot stays connected and idle; the forensic capture (diagnostics.js) and the
// uptime heartbeat show what actually happens around the transfer.
//
// (The previous look-nudge version is in git history if a minimal keepalive is
// ever genuinely required.)

function schedule(botId, entry, bot) {
  // Intentionally idle. Log once per session so the behavior is explicit.
  console.log(
    `[FreshSmpProfile] 😴 [${entry.minecraftUser}] Idle-client mode — no anti-AFK actions sent ` +
    `(behaves like a real client with the player away)`
  );
}

function cancel(botId) {
  // Nothing to cancel in idle mode.
}

module.exports = { schedule, cancel };
