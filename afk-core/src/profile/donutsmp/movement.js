// afk-core/src/profile/donutsmp/movement.js
"use strict";

// DonutSMP anti-detection: freeze the bot by dropping outgoing position/flying
// packets entirely. DonutSMP tolerates a perfectly still client; sending
// movement is what its checks dislike.
//
// We intentionally do NOT block "look" — mineflayer's bot.look() builds the
// correct 1.21.2+ packet (with movementFlags). Sending a raw "look" via
// origWrite would crash with a "SizeOf error for undefined" on 1.21.2+.
//
// ── use_item AIM CORRECTION (the real "Invalid sequence"-while-eating fix) ───
// On 1.21.3+ the `use_item` packet carries the player's aim (`rotation: vec2f`,
// notchian degrees) so the server can validate where you were looking when you
// used the item. mineflayer hardcoded that rotation to { x: 0, y: 0 } on every
// activateItem() until the fix in PR #3840 (shipped in mineflayer 4.37.1).
// 1.21.11 support landed in 4.35.0, so a bot on 4.35.0 / 4.36.0 / 4.37.0 talks
// 1.21.11 *and* still sends the bogus { 0, 0 } aim.
//
// `use_item` is the ONLY sequenced packet that is emitted exclusively while
// eating, which is exactly why the kick only ever appears in hunger-draining
// worlds: every eat reports an aim of (south, level) that contradicts the bot's
// real facing (its spawn yaw plus the anti-AFK nudges, sent via real `look`
// packets). DonutSMP's anti-cheat accumulates that per-eat inconsistency and
// kicks after a few eats — matching the "~1h, scales with starting hunger"
// symptom (starting hunger just delays the first eat).
//
// Fix, here at the single outgoing-packet chokepoint so it is independent of the
// installed mineflayer version: rewrite use_item's rotation to the bot's actual
// notchian yaw/pitch (same convention mineflayer uses for movement/look, so the
// aim now agrees with what the server already tracks). bot.activateItem() still
// owns the `sequence` counter; we only correct the one bogus field in flight.

const KEEP_ALIVE_DEBUG =
  String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

const BLOCKED = new Set(["position", "flying"]);

// mineflayer's lib/conversions.js: toNotchianYaw = toDegrees(PI - yaw),
// toNotchianPitch = toDegrees(-pitch). Inlined so this stays self-contained.
const RAD_TO_DEG = 180 / Math.PI;
const toNotchianYaw = (yaw) => 180 - yaw * RAD_TO_DEG;
const toNotchianPitch = (pitch) => -pitch * RAD_TO_DEG;

// Replace a use_item packet's aim with the bot's real notchian rotation, in
// place. No-op (and harmless) on mineflayer ≥4.37.1, which already sends it.
function correctUseItemAim(bot, params) {
  const ent = bot.entity;
  if (!ent || !params || typeof ent.yaw !== "number" || typeof ent.pitch !== "number") {
    return;
  }
  if (!Number.isFinite(ent.yaw) || !Number.isFinite(ent.pitch)) return;
  params.rotation = { x: toNotchianYaw(ent.yaw), y: toNotchianPitch(ent.pitch) };
}

// Replaces bot._client.write with a movement-suppressing proxy and returns the
// original (bound) write so other handlers can bypass the suppression.
function installMovementSuppression(bot) {
  const origWrite = bot._client.write.bind(bot._client);

  bot._client.write = function donutSmpMovementBlock(name, params) {
    // Correct the eat-aim before anything else so the logged packet reflects
    // what actually goes on the wire.
    if (name === "use_item") correctUseItemAim(bot, params);

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

module.exports = {
  installMovementSuppression,
  KEEP_ALIVE_DEBUG,
  BLOCKED,
  // exported for the eat-aim regression test
  correctUseItemAim,
  toNotchianYaw,
  toNotchianPitch,
};
