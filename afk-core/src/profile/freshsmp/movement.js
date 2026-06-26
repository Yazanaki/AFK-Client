// afk-core/src/profile/freshsmp/movement.js
"use strict";

// FreshSMP per-tick movement keepalive (anti-detection). FreshSMP's survival
// backend floods ~20/s `ping` transactions and expects a movement packet EVERY
// tick, like a real client. mineflayer optimizes idle movement away (~1/s), and a
// forensic dump proved that under-sending movement is what gets us kicked with
// "Invalid sequence" ~19s after joining. We replicate a stationary vanilla client
// by sending `flying` (status-only) every 50ms while in PLAY, via origWrite so it
// isn't dropped by the config-state movement filter and doesn't spam the ring.
//
// Two bugs the dump exposed in the previous version (both fixed here):
//   1. Wrong packet shape. It sent { flags: { onGround, hasHorizontalCollision } }
//      — missing the top-level `onGround` — which throws "SizeOf error" every tick
//      (swallowed), so NOTHING was ever sent. The shape mineflayer itself emits on
//      this server (protocol 774) is { onGround, flags: { onGround } }; use that.
//   2. Self-kill on transfer. It called clearInterval whenever bot._client.ended
//      was truthy; a transient `ended` during a Velocity transfer killed the
//      keepalive permanently so it never resumed on the new backend. Now the tick
//      only SKIPS when not ready and is cleared solely on the bot "end" event, and
//      we re-arm (idempotently) on every entry into PLAY.

function installPerTickMovement(bot, entry, origWrite) {
  let timer = null;
  let warned = false;

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  const start = () => {
    if (timer) return; // idempotent — one interval, re-armed safely
    timer = setInterval(() => {
      const c = bot && bot._client;
      if (!c || c.ended || c.state !== "play") return; // skip, never self-kill
      try {
        const og = (bot.entity && typeof bot.entity.onGround === "boolean")
          ? bot.entity.onGround : true;
        origWrite("flying", { onGround: og, flags: { onGround: og } });
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn(
            `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] per-tick flying failed:`,
            err.message
          );
        }
        // swallow — the next tick retries; a throw must not stop the keepalive
      }
    }, 50);
    if (timer.unref) timer.unref();
    entry._tickMoveTimer = timer;
  };

  // Re-arm on every transition into PLAY (survives Velocity transfers), and start
  // now in case we're already there.
  bot._client.on("state", (s) => { if (s === "play") start(); });
  start();

  bot.on("end", stop);
}

module.exports = { installPerTickMovement };
