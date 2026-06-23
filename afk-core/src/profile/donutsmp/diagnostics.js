// afk-core/src/profile/donutsmp/diagnostics.js
"use strict";

// DonutSMP forensic capture — turns the next "Invalid sequence" kick into a
// definitive diagnosis instead of another guess.
//
// WHY THE FIRST CAPTURE WAS INCONCLUSIVE
// On DonutSMP the server ping-floods (~26 ping/s) and streams ~250 packets/s of
// world/entity noise, so a flat 160-packet ring only spanned ~0.5s of wall
// clock — it proved mineflayer 4.37.1 + the use_item aim correction were live
// (rotation theory dead), but the *eat that triggers the kick had already rolled
// off the ring*. The established symptom (kicks ONLY in hunger-draining worlds,
// time-to-kick scales with starting hunger) pins the trigger on the eat /
// use_item path — the one sequenced packet the frozen bot ever sends. So this
// capture is built to hold onto the eat no matter how many seconds before the
// kick it fired.
//
// WHAT THIS DUMP NOW SHOWS
//   • mineflayer version actually loaded (confirms the aim fix is in effect)
//   • last-of-each outbound ACTION packet (use_item / block_dig / block_place /
//     held_item_slot / arm_animation / look) with full params + age — so the eat
//     is always present, with its { hand, sequence, rotation } AFTER our aim
//     correction, even if it was 30s ago
//   • the use_item / block sequence TRAJECTORY (last 16 sequenced sends) — so a
//     backward / zero / duplicate sequence jump (the literal "Invalid sequence")
//     is visible at a glance
//   • last relevant INBOUND packets (respawn / login / set_health / server
//     teleport / digging-acks) with age — a respawn or dimension change resets
//     mineflayer's sequence counter, which is the leading suspect for a later
//     eat sending a stale/low sequence the anti-cheat rejects
//   • a noise-filtered "signal ring" (drops ping/pong/keep_alive + world/entity
//     spam) that spans minutes, plus a short raw tail for the instant of the kick
//
// Recording is always on (cheap array pushes + a few map writes); verbose
// per-packet console spam still stays behind DONUTSMP_DEBUG=forensic elsewhere.
// Only the disconnect dump prints here, so steady-state log noise is unchanged.

const { BLOCKED } = require("./movement"); // which movement packets are suppressed

const RAW_RING_SIZE = 60; // last-N of EVERYTHING — the instant-of-kick picture
const SIGNAL_RING_SIZE = 90; // last-N of interesting-only — spans minutes
const SEQ_LOG_SIZE = 16; // last-N sequenced (use_item/block) sends

// High-frequency packets that carry no diagnostic value for "Invalid sequence".
// Excluded from the signal ring so it covers real time instead of ping spam.
const NOISE = new Set([
  "ping", "pong", "keep_alive", "bundle_delimiter",
  "entity_velocity", "entity_metadata", "entity_destroy",
  "rel_entity_move", "entity_move_look", "entity_look", "entity_head_rotation",
  "entity_update_attributes", "entity_equipment", "update_attributes",
  "world_event", "sound_effect", "named_sound_effect",
  "multi_block_change", "block_change", "block_action",
  "map_chunk", "unload_chunk", "update_light", "chunk_batch_start",
  "chunk_batch_finish", "update_time", "playerlist_header",
  "player_info", "player_remove", "teams", "scoreboard_objective",
  "scoreboard_score", "spawn_entity", "entity_effect", "remove_entity_effect",
  "set_passengers", "animation", "collect", "damage_event",
]);

// Outbound action packets we always keep the most-recent of, with full params.
const TRACK_OUT = [
  "use_item", "block_dig", "block_place", "block_place_old",
  "held_item_slot", "arm_animation", "entity_action", "look", "position_look",
  "position", "flying", // expected "never (suppressed)" — confirms the freeze
];

// Inbound packets whose timing matters (sequence resets, eat acks, health).
const TRACK_IN = [
  "login", "respawn", "set_health", "update_health", "position",
  "acknowledge_player_digging", "block_changed_ack", "set_cooldown",
  "entity_status", "game_state_change", "abilities", "held_item_slot",
];

// Sequenced outbound packets — these carry the `sequence` the server validates.
const SEQUENCED = new Set(["use_item", "block_dig", "block_place", "block_place_old"]);

function mineflayerVersion() {
  try {
    return require("mineflayer/package.json").version;
  } catch {
    return "unknown";
  }
}

function safeStr(data, max = 220) {
  if (data == null) return null;
  try {
    const s = JSON.stringify(data);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return "(unserializable)";
  }
}

function keepInSignal(dir, name) {
  if (NOISE.has(name)) return false;
  if (dir === "OUT") return true; // every real bot action (look/use_item/…)
  return TRACK_IN.includes(name) || name === "kick_disconnect" || name === "disconnect"
    || name === "system_chat" || name === "player_chat" || name === "profileless_chat"
    || name === "transaction" || name === "set_slot" || name === "window_items"
    || name === "block_break_animation";
}

function installDiagnostics(bot, entry) {
  const rawRing = [];      // {t, dir, name}
  const signalRing = [];   // {t, dir, name, brief}
  const seqLog = [];       // {t, name, sequence, rotation}
  const lastOut = {};      // name -> {t, brief}
  const lastIn = {};       // name -> {t, brief}
  let inCount = 0;
  let outCount = 0;

  const record = (dir, name, data) => {
    const t = Date.now();

    rawRing.push({ t, dir, name });
    if (rawRing.length > RAW_RING_SIZE) rawRing.shift();

    if (keepInSignal(dir, name)) {
      signalRing.push({ t, dir, name, brief: safeStr(data) });
      if (signalRing.length > SIGNAL_RING_SIZE) signalRing.shift();
    }

    if (dir === "OUT") {
      outCount++;
      if (TRACK_OUT.includes(name)) lastOut[name] = { t, brief: safeStr(data) };
      if (SEQUENCED.has(name) && data) {
        seqLog.push({ t, name, sequence: data.sequence, rotation: data.rotation });
        if (seqLog.length > SEQ_LOG_SIZE) seqLog.shift();
      }
    } else {
      inCount++;
      if (TRACK_IN.includes(name)) lastIn[name] = { t, brief: safeStr(data) };
    }
  };

  // ── Outbound: wrap the RAW client write FIRST, before movement suppression
  // rebinds it. installMovementSuppression() captures the current
  // bot._client.write as its `origWrite`, so every actually-sent packet —
  // proxied (use_item, look) and origWrite-bypassed (keep_alive echo) alike —
  // routes through this recorder, AND it sees use_item AFTER the aim correction
  // mutates it. (Suppressed position/flying never reach here — they aren't sent,
  // so they can't be what the server rejected; they show as "never" below.)
  const rawWrite = bot._client.write.bind(bot._client);
  bot._client.write = function diagWrite(name, params) {
    try { record("OUT", name, params); } catch {}
    return rawWrite(name, params);
  };

  // ── Inbound: every decoded packet from the server.
  bot._client.on("packet", (data, meta) => {
    try { record("IN", meta.name, data); } catch {}
  });

  const startedAt = Date.now();

  entry._donutDump = (reason) => {
    const now = Date.now();
    const age = (t) => (t ? `${String(now - t).padStart(6)}ms ago` : "       never");
    const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
    const uptimeS = Math.floor((now - startedAt) / 1000);
    const L = [];

    L.push("");
    L.push("════════════════ DonutSMP FORENSIC DUMP ════════════════");
    L.push(`  user        : ${entry.minecraftUser}`);
    L.push(`  mineflayer  : v${mineflayerVersion()}   (use_item aim fix is in 4.37.1+)`);
    L.push(`  reason      : ${reasonText}`);
    L.push(`  session     : ~${uptimeS}s online, ${outCount} sent / ${inCount} received`);

    // The eat and friends — present no matter how long before the kick they fired.
    L.push("  ── last outbound ACTION packets (most-recent of each) ──");
    for (const name of TRACK_OUT) {
      const e = lastOut[name];
      const label = BLOCKED.has(name) ? `${name} (suppressed)` : name;
      L.push(`    ${label.padEnd(22)} ${age(e && e.t)}${e && e.brief ? "  " + e.brief : ""}`);
    }

    // The literal "sequence" the server validates — watch for a backward / 0 jump.
    L.push("  ── use_item / block SEQUENCE trajectory (newest last) ──");
    if (seqLog.length === 0) {
      L.push("    (no sequenced packets sent this session — eat path never ran)");
    } else {
      let prev = null;
      for (const e of seqLog) {
        const flag = prev != null && typeof e.sequence === "number" && e.sequence <= prev
          ? "  ⚠️ NOT INCREASING" : "";
        L.push(
          `    -${String(now - e.t).padStart(7)}ms  ${e.name.padEnd(12)} ` +
          `seq=${e.sequence}  rot=${safeStr(e.rotation, 60)}${flag}`
        );
        if (typeof e.sequence === "number") prev = e.sequence;
      }
    }

    // Sequence-reset suspects: a respawn/dimension change/server teleport.
    L.push("  ── last relevant INBOUND packets ──");
    for (const name of TRACK_IN) {
      const e = lastIn[name];
      L.push(`    ${name.padEnd(28)} ${age(e && e.t)}${e && e.brief ? "  " + e.brief : ""}`);
    }

    // Interesting-only history — spans minutes, drops the ping/world spam.
    L.push(`  ── signal ring: last ${signalRing.length} interesting packets (newest last) ──`);
    for (const e of signalRing) {
      const arrow = e.dir === "OUT" ? "→ SENT" : "← RECV";
      L.push(`    -${String(now - e.t).padStart(7)}ms ${arrow} ${e.name}${e.brief ? "  " + e.brief : ""}`);
    }

    // The raw instant of the kick (all packets, ~0.5s).
    L.push(`  ── raw tail: last ${rawRing.length} packets of everything (newest last) ──`);
    for (const e of rawRing) {
      const arrow = e.dir === "OUT" ? "→ SENT" : "← RECV";
      L.push(`    -${String(now - e.t).padStart(7)}ms ${arrow} ${e.name}`);
    }

    L.push("═════════════════════════════════════════════════════════");
    L.push("");
    console.log(L.join("\n"));
  };

  console.log(
    `[donutsmp/diagnostics] 🔬 Forensic capture armed for ${entry.minecraftUser} ` +
    `— mineflayer v${mineflayerVersion()} ` +
    `(eat-aware: tracks use_item/sequence/respawn, signal ring ${SIGNAL_RING_SIZE} + raw ${RAW_RING_SIZE})`
  );
}

function dump(entry, reason) {
  if (entry && typeof entry._donutDump === "function") {
    try { entry._donutDump(reason); } catch {}
  }
}

module.exports = { installDiagnostics, dump };
