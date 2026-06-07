// afk-core/src/profile/freshsmp/movement.js
"use strict";

// FreshSMP per-tick movement keepalive (anti-detection). FreshSMP's survival
// backend correlates its per-tick `ping` transactions (~20/s) with per-tick
// movement. A real vanilla client sends a movement packet EVERY tick even while
// standing still; mineflayer optimizes that away (~1/s when idle). We replicate
// vanilla by sending `flying` every 50ms while in PLAY state, using origWrite so
// it isn't dropped by the config-state movement filter and doesn't spam the ring
// buffer.
//
// IMPORTANT: 1.21.2+ movement packets carry a MovementFlags bitfield, NOT a bare
// `onGround` boolean. The old { onGround } shape threw "SizeOf error for
// undefined" on every tick (silently swallowed), so this keepalive never sent —
// exactly what let the transaction check kick us with "Invalid sequence". Send
// the correct { flags } shape (matches mineflayer's own physics writes).

function installPerTickMovement(bot, entry, origWrite) {
  let warned = false;
  let timer = setInterval(() => {
    if (!bot || !bot._client || bot._client.ended) {
      clearInterval(timer);
      timer = null;
      return;
    }
    if (bot._client.state !== "play") return;
    try {
      const og = (bot.entity && typeof bot.entity.onGround === "boolean")
        ? bot.entity.onGround : true;
      origWrite("flying", { flags: { onGround: og, hasHorizontalCollision: false } });
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn(
          `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] per-tick flying failed:`,
          err.message
        );
      }
    }
  }, 50);

  entry._tickMoveTimer = timer;
  bot.on("end", () => {
    if (timer) { clearInterval(timer); timer = null; }
  });
}

module.exports = { installPerTickMovement };
