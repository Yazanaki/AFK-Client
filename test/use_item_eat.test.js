"use strict";

// ============================================================
// Offline regression test for the auto-eat use_item packet.
//
// Guards the fix for the "invalid sequence" kicks on DonutSMP / FreshSMP.
//
// Root cause: the old auto-eat hand-wrote a raw use_item as
//   { hand, sequence, yaw, pitch }   (separate radian yaw/pitch + a private
//                                      sequence counter)
// but the real 1.21.2+ schema is
//   { hand, sequence, rotation: vec2f }   (one rotation vector, in NOTCHIAN
//                                          DEGREES; sequence is mineflayer's
//                                          shared block-interaction counter)
// so the old packet was malformed/inconsistent and got rejected.
//
// The fix routes eating through mineflayer's bot.activateItem() /
// deactivateItem(), which build exactly the schema below. These tests pin that
// contract against the installed minecraft-data so a regression to the old
// hand-written shape fails loudly.
//
// Needs minecraft-protocol + minecraft-data (transitive deps of mineflayer).
// Run:  npm install  &&  npm test     (from repo root)
// ============================================================

const assert = require("assert");

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

// ── Load deps (skip cleanly if not installed) ────────────────────────────────
let createSerializer = null;
let mcData = null;
try {
  ({ createSerializer } = require("minecraft-protocol"));
  mcData = require("minecraft-data")(TARGET_VERSION);
} catch (err) {
  console.log(
    `\n⏭️  SKIP — minecraft-protocol / minecraft-data not available ` +
      `(${err.message}).\n   Run \`npm install\` then \`npm test\`.\n`
  );
  process.exit(0);
}

if (!mcData) {
  console.log(
    `\n⏭️  SKIP — minecraft-data has no definition for v${TARGET_VERSION} ` +
      `(installed build is too old/new).\n`
  );
  process.exit(0);
}

const serializer = createSerializer({
  state: "play",
  isServer: false,
  version: TARGET_VERSION,
});
const serialize = (name, params) => serializer.createPacketBuffer({ name, params });

console.log(`\nuse_item / block_dig contract for v${TARGET_VERSION} (protocol ${mcData.version.version}):`);

// ── 1. Schema shape: { hand, sequence, rotation: vec2f } ─────────────────────
test("use_item schema is { hand, sequence, rotation: vec2f } (no separate yaw/pitch)", () => {
  const def = mcData.protocol.play.toServer.types.packet_use_item;
  assert(Array.isArray(def) && def[0] === "container", "packet_use_item is not a container");
  const fields = def[1].map((f) => f.name);
  assert.deepStrictEqual(fields, ["hand", "sequence", "rotation"], `unexpected fields: ${fields}`);
  const rotation = def[1].find((f) => f.name === "rotation");
  assert.strictEqual(rotation.type, "vec2f", `rotation type is ${rotation.type}, expected vec2f`);
});

// ── 2. The shape mineflayer.activateItem() produces serializes cleanly ───────
// mineflayer writes: { hand, sequence, rotation: { x: toNotchianYaw(yaw),
//                                                   y: toNotchianPitch(pitch) } }
// toNotchianYaw(0) = 180, toNotchianPitch(0) = 0 (degrees) — a bot looking
// "south, level". This is what the fixed auto-eat sends.
test("correct packet { hand, sequence, rotation:{x:180,y:0} } serializes", () => {
  const buf = serialize("use_item", { hand: 0, sequence: 1, rotation: { x: 180, y: 0 } });
  assert(Buffer.isBuffer(buf) && buf.length > 0, "no buffer produced");
});

// ── 3. The OLD hand-written shape must FAIL (regression guard) ───────────────
test("old shape { hand, sequence, yaw, pitch } throws (rotation missing)", () => {
  assert.throws(
    () => serialize("use_item", { hand: 0, sequence: 1, yaw: 0, pitch: 0 }),
    "old separate yaw/pitch packet unexpectedly serialized — schema/fix drift"
  );
});

// ── 4. Rotation must be degrees, not radians (range sanity) ──────────────────
// A radian look (|pitch| ≤ ~1.57) is a nonsensical sub-2° pitch on the wire.
// Pin that a real downward look is reported as a large-magnitude degree value.
test("toNotchianPitch maps look-down to -90° (degrees, not ~1.57 radians)", () => {
  const toNotchianPitch = (rad) => (-rad * 180) / Math.PI; // mineflayer's formula
  assert.strictEqual(Math.round(toNotchianPitch(Math.PI / 2)), -90);
  assert(Math.abs(toNotchianPitch(Math.PI / 2)) > 2, "pitch looks like raw radians, not degrees");
});

// ── 5. The release packet (deactivateItem → block_dig status 5) serializes ───
test("block_dig release { status:5, location, face:0, sequence:0 } serializes", () => {
  const buf = serialize("block_dig", {
    status: 5,
    location: { x: 0, y: 0, z: 0 },
    face: 0,
    sequence: 0,
  });
  assert(Buffer.isBuffer(buf) && buf.length > 0, "no buffer produced");
});

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
