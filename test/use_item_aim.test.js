"use strict";

// ============================================================
// Offline regression test for the auto-eat use_item AIM.
//
// Guards the real fix for the DonutSMP "Invalid sequence"-while-eating kick.
//
// Root cause: mineflayer ≤4.37.0 hardcodes the use_item rotation to
//   { x: 0, y: 0 }   (PR #3840 fixed it in 4.37.1), but 1.21.11 support landed
// back in 4.35.0 — so a bot can speak 1.21.11 and still send a bogus eat aim on
// every bite. `use_item` is the only sequenced packet emitted exclusively while
// eating, so DonutSMP only ever kicks for it in hunger-draining worlds.
//
// donutsmp/movement.js corrects the aim in the outgoing-packet proxy
// (correctUseItemAim) to the bot's real notchian yaw/pitch, independent of the
// installed mineflayer version. These tests pin that:
//   1. a real (non-zero) look is NOT sent as { 0, 0 }
//   2. the conversion matches mineflayer's lib/conversions.js
//   3. the corrected packet still serializes against minecraft-data 1.21.11
//
// Run:  npm install && node test/use_item_aim.test.js
// ============================================================

const assert = require("assert");
const {
  correctUseItemAim,
  toNotchianYaw,
  toNotchianPitch,
} = require("../afk-core/src/profile/donutsmp/movement");

const TARGET_VERSION = "1.21.11";
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ❌ ${name}\n     ${err && err.message ? err.message : err}`);
  }
}

console.log(`\nuse_item eat-aim correction:`);

// ── 1. mineflayer's hardcoded { 0, 0 } is replaced with the real look ────────
test("correctUseItemAim overwrites { 0, 0 } with the bot's actual rotation", () => {
  const bot = { entity: { yaw: 2.4, pitch: -0.3 } };
  const params = { hand: 0, sequence: 7, rotation: { x: 0, y: 0 } };
  correctUseItemAim(bot, params);
  assert(
    !(params.rotation.x === 0 && params.rotation.y === 0),
    "rotation is still { 0, 0 } — the bogus eat aim was not corrected"
  );
  assert.strictEqual(params.rotation.x, toNotchianYaw(2.4));
  assert.strictEqual(params.rotation.y, toNotchianPitch(-0.3));
});

// ── 2. Conversion matches mineflayer's lib/conversions.js exactly ────────────
// toNotchianYaw = toDegrees(PI - yaw); toNotchianPitch = toDegrees(-pitch).
test("notchian conversion matches mineflayer (yaw 0 -> 180, look-down -> -90)", () => {
  assert.strictEqual(Math.round(toNotchianYaw(0)), 180);
  assert.strictEqual(Math.round(toNotchianPitch(Math.PI / 2)), -90);
});

// ── 3. Defensive guards: never throw / never corrupt without a real entity ───
test("correctUseItemAim is a no-op when entity / rotation is unavailable", () => {
  const p1 = { hand: 0, sequence: 1, rotation: { x: 0, y: 0 } };
  correctUseItemAim({}, p1); // no entity
  assert.deepStrictEqual(p1.rotation, { x: 0, y: 0 });
  correctUseItemAim({ entity: { yaw: NaN, pitch: 0 } }, p1); // NaN yaw
  assert.deepStrictEqual(p1.rotation, { x: 0, y: 0 });
});

// ── 4. The corrected packet still serializes against real 1.21.11 data ───────
test("corrected use_item serializes against minecraft-data 1.21.11", () => {
  let createSerializer, mcData;
  try {
    ({ createSerializer } = require("minecraft-protocol"));
    mcData = require("minecraft-data")(TARGET_VERSION);
  } catch (err) {
    console.log(`     ⏭️  skipped (minecraft-protocol/data not installed: ${err.message})`);
    return;
  }
  if (!mcData) {
    console.log(`     ⏭️  skipped (no minecraft-data for v${TARGET_VERSION})`);
    return;
  }
  const serializer = createSerializer({ state: "play", isServer: false, version: TARGET_VERSION });
  const bot = { entity: { yaw: 2.4, pitch: -0.3 } };
  const params = { hand: 0, sequence: 7, rotation: { x: 0, y: 0 } };
  correctUseItemAim(bot, params);
  const buf = serializer.createPacketBuffer({ name: "use_item", params });
  assert(Buffer.isBuffer(buf) && buf.length > 0, "no buffer produced");
});

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
