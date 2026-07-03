"use strict";

// ============================================================
// Offline regression test for the "invalid sequence" reconnect fix.
//
// FreshSMP (and the FreshSMP-seeded ElementalMC profile) can be kicked with
// "Invalid sequence" during the login / Velocity-transfer window — a transient
// packet-timing race, not an anti-bot ban. The fix (profile/*/reconnect.js +
// each profile's onKick) treats that kick as transient and reconnects instead
// of letting botmanager's generic handler classify it as a rejection and kill
// the bot. This mirrors the reusable half of the DonutSMP verification fix.
//
// No external deps — loads the profile classes directly (they don't pull in
// mineflayer). Run:  node test/invalid_sequence_reconnect.test.js
// ============================================================

const assert = require("assert");

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

const freshReconnect = require("../afk-core/src/profile/freshsmp/reconnect");
const elemReconnect = require("../afk-core/src/profile/elementalmc/reconnect");
const { FreshSmpProfile } = require("../afk-core/src/profile/freshsmp");
const { ElementalMcProfile } = require("../afk-core/src/profile/elementalmc");

console.log("\ninvalid-sequence reconnect contract:");

// ── isTransientKick classification ───────────────────────────────────────────
for (const [label, mod] of [["freshsmp", freshReconnect], ["elementalmc", elemReconnect]]) {
  test(`[${label}] "Invalid sequence" is transient`, () => {
    assert.strictEqual(mod.isTransientKick("Disconnected: Invalid sequence", Date.now()), true);
  });
  test(`[${label}] a real ban is NOT transient`, () => {
    assert.strictEqual(mod.isTransientKick("You are permanently banned", Date.now()), false);
  });
  test(`[${label}] early socketClosed is transient, stable-session socketClosed is not`, () => {
    assert.strictEqual(mod.isTransientKick("socketClosed", Date.now()), true);
    const longAgo = Date.now() - (mod.STABLE_SESSION_SECONDS + 5) * 1000;
    assert.strictEqual(mod.isTransientKick("socketClosed", longAgo), false);
  });
}

// ── onKick wiring: transient → reconnect (returns true), ban → falls through ──
function fakeEntry() {
  return { minecraftUser: "tester", version: "1.21.11", connectedSince: null, profileReconnectRetries: 0 };
}

for (const [label, Profile] of [["freshsmp", FreshSmpProfile], ["elementalmc", ElementalMcProfile]]) {
  test(`[${label}] onKick("Invalid sequence") schedules reconnect and returns true`, () => {
    const p = new Profile();
    const entry = fakeEntry();
    let respawned = false;
    const handled = p.onKick(null, entry, "bot-1", "Kicked whilst connecting: Invalid sequence",
      () => { respawned = true; }, false, [], {});
    assert.strictEqual(handled, true, "onKick should return true to short-circuit botmanager");
    assert.strictEqual(entry.status, "reconnecting", "entry status should be 'reconnecting'");
    assert.strictEqual(entry.profileReconnectRetries, 1, "retry counter should increment");
  });

  test(`[${label}] onKick(real ban) returns false (falls through to generic handler)`, () => {
    const p = new Profile();
    const entry = fakeEntry();
    const handled = p.onKick(null, entry, "bot-1", "Banned: cheating", () => {}, false, [], {});
    assert.strictEqual(handled, false, "a real ban must not be swallowed as transient");
  });

  test(`[${label}] retry counter is capped (gives up after the limit)`, () => {
    const p = new Profile();
    const entry = fakeEntry();
    const max = freshReconnect.MAX_RECONNECT_RETRIES;
    for (let i = 0; i < max + 1; i++) {
      p.onKick(null, entry, "bot-1", "Invalid sequence", () => {}, false, [], {});
    }
    assert.strictEqual(entry.status, "error", "should give up (status 'error') past the retry cap");
  });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
