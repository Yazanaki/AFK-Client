// afk-core/src/profile/donutsmp/movement.js
"use strict";

// DonutSMP movement policy — block the packets that carry the player's POSITION
// (`position`, `position_look`) so the bot never transmits a coordinate, but
// ALLOW the position-less standing heartbeat (`flying`, just onGround) and
// rotation (`look`). The bot stands still on its own (it never sets a control
// state), so this keeps it pinned in place while presenting the normal per-tick
// "I'm here, on the ground" cadence that every real client sends.
//
// ── WHY `flying` IS NO LONGER BLOCKED (forensic evidence, two full dumps) ─────
// Two "Invalid sequence" kicks were captured end-to-end. They ruled out every
// earlier theory outright:
//   • mineflayer 4.37.1 is live and the use_item aim is corrected — yet it kicks
//   • the bot NEVER ate in the kicking session (use_item: never; food stayed
//     20/20 the whole 44 min) — so eating / sequenced packets are NOT required;
//     the "only kicks while hunger drains" correlation was a red herring
//   • ping:pong stayed strictly 1:1 — the duplicate-pong path is clean
// What BOTH dumps share: the kick lands ~130ms after an anti-AFK `look` nudge,
// and for the minutes before it the bot had sent ZERO movement packets because
// the old policy also blocked `flying`. A real client never goes silent and then
// emits a lone rotation; that movement-silent-then-isolated-look pattern is the
// only remaining anomaly. Restoring the `flying` heartbeat embeds the nudge in a
// normal movement-packet stream. Diagnostics stay armed to confirm.
//
// We do NOT block "look": mineflayer's bot.look() builds the correct 1.21.2+
// packet (with movementFlags); sending a raw "look" via origWrite would crash
// with a "SizeOf error for undefined" on 1.21.2+. With the flying heartbeat
// keeping mineflayer's last-sent position synced every tick, a look nudge
// serializes as a pure `look` (no position), so blocking `position_look` never
// suppresses a nudge.
//
// ── use_item AIM CORRECTION (kept; harmless, version-independent) ─────────────
// On 1.21.3+ the `use_item` packet carries the player's aim (`rotation: vec2f`).
// mineflayer hardcoded it to { x: 0, y: 0 } until 4.37.1 (PR #3840). We rewrite
// it to the bot's real notchian yaw/pitch at this outgoing-packet chokepoint so
// the correction holds on any installed mineflayer version. The forensic dumps
// proved this is NOT the kick's cause, but a correct aim is still the right thing
// to send whenever the bot does eat, so the correction stays.

const KEEP_ALIVE_DEBUG =
  String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

// Block only position-bearing movement packets; let `flying` (onGround heartbeat)
// and `look` (rotation) through. See the header note for the forensic rationale.
const BLOCKED = new Set(["position", "position_look"]);

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
