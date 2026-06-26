// afk-core/src/profile/freshsmp/movement.js
"use strict";

// FreshSMP per-tick movement keepalive — NEUTRALIZED (no-op).
//
// History: this module flooded `flying` every 50ms (~20/s) on the theory that
// FreshSMP's backend wants a movement packet every tick like a real client. Once
// the keepalive was actually fixed to send (it had been throwing for ages), a
// forensic dump disproved that theory decisively: at 20/s the bot was "Invalid
// sequence"-kicked almost INSTANTLY (<1s, ~166ms on the Hub) on EVERY backend —
// versus the ~19s it lasted with NO artificial movement.
//
// The premise was simply wrong. A real vanilla client does NOT send a movement
// packet every tick while standing still — when fully idle it sends a position
// only ~once per second (the 20-tick "send anyway" rule). mineflayer already
// replicates that idle cadence, so flooding 20/s is grossly UNNATURAL and the
// anti-cheat flags it immediately. Sending nothing extra is strictly better.
//
// We therefore send NO artificial movement and let mineflayer's own physics emit
// the natural ~1/s idle position + the mandatory teleport_confirm responses.
// (Kept as a no-op so index.js's installPerTickMovement(...) call stays valid.)

function installPerTickMovement(bot, entry /*, origWrite */) {
  console.log(
    `[FreshSmpProfile] 🟰 [${entry.minecraftUser}] per-tick movement disabled ` +
    `(20/s flying caused instant "Invalid sequence"; idling like a real away client)`
  );
}

module.exports = { installPerTickMovement };
