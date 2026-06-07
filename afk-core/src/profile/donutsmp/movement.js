// afk-core/src/profile/donutsmp/movement.js
"use strict";

// DonutSMP anti-detection: freeze the bot by dropping outgoing position/flying
// packets entirely. DonutSMP tolerates a perfectly still client; sending
// movement is what its checks dislike.
//
// We intentionally do NOT block "look" — mineflayer's bot.look() builds the
// correct 1.21.2+ packet (with movementFlags). Sending a raw "look" via
// origWrite would crash with a "SizeOf error for undefined" on 1.21.2+.

const KEEP_ALIVE_DEBUG =
  String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

const BLOCKED = new Set(["position", "flying"]);

// Replaces bot._client.write with a movement-suppressing proxy and returns the
// original (bound) write so other handlers can bypass the suppression.
function installMovementSuppression(bot) {
  const origWrite = bot._client.write.bind(bot._client);

  bot._client.write = function donutSmpMovementBlock(name, params) {
    if (BLOCKED.has(name)) {
      if (KEEP_ALIVE_DEBUG) {
        try {
          console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`, JSON.stringify(params).slice(0, 120));
        } catch {
          console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`);
        }
      }
      return;
    }
    if (KEEP_ALIVE_DEBUG) {
      try {
        console.log(`[donut-pkt] → CLIENT sent: ${name}`, JSON.stringify(params).slice(0, 120));
      } catch {
        console.log(`[donut-pkt] → CLIENT sent: ${name} (non-serializable)`);
      }
    }
    return origWrite(name, params);
  };

  return origWrite;
}

module.exports = { installMovementSuppression, KEEP_ALIVE_DEBUG, BLOCKED };
