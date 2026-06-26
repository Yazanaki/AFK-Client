// afk-core/src/profile/freshsmp/diagnostics.js
"use strict";

// FreshSMP forensic capture — the strong dump (ported from donutsmp/diagnostics.js)
// adapted for FreshSMP's Velocity transfer flow, where the "Invalid sequence" kick
// fires RIGHT AFTER a /queue transfer (play → configuration → play onto the new
// backend).
//
// What this adds over the old lifecycle.js + entry._recentOut capture (which kept
// only 25 outgoing packets and WIPED them on entering configuration):
//   • a connection STATE / transfer TIMELINE (play↔config + transfer packets) with
//     ms timing — the pivotal event for the post-transfer kick
//   • last-of-each outbound ACTION packet (movement, settings, /queue chat,
//     use_item) with full params + age
//   • use_item/block SEQUENCE trajectory (catches a backward/zero/duplicate jump)
//   • last relevant INBOUND packets (login/respawn/position-teleport/game_state/
//     start+finish_configuration/abilities) with age
//   • a noise-filtered signal ring (drops the 20/s flying + ping/world spam) that
//     spans minutes, plus a raw tail for the instant of the kick
//   • the ring is one rolling window across the WHOLE episode — it is NOT cleared
//     on a transfer, so a post-transfer kick shows pre-transfer + transfer + post-
//     transfer packets together
//
// NOTE: a FreshSMP /queue is normally a transparent Velocity backend switch (same
// proxy socket, only the `state` changes), so these hooks on bot._client persist
// across the transfer. If it ever turns out to be a real `transfer`-packet
// reconnect (new socket), this capture would need re-installing on reconnect.

const { chatText } = require("./lifecycle"); // flatten chat NBT for kick-notice match

const RAW_RING_SIZE = 80;    // last-N of EVERYTHING — the instant-of-kick picture
const SIGNAL_RING_SIZE = 90; // last-N of interesting-only — spans minutes
const SEQ_LOG_SIZE = 16;     // last-N sequenced (use_item/block) sends
const STATE_LOG_SIZE = 14;   // last-N state/transfer transitions

// High-frequency packets with no diagnostic value here. `flying` is OURS (the
// ~20/s per-tick heartbeat) — excluded from the signal ring so it spans real time
// instead of the heartbeat, but still kept in the raw tail and the action snapshot.
const NOISE = new Set([
  "ping", "pong", "keep_alive", "bundle_delimiter", "flying",
  "entity_velocity", "entity_metadata", "entity_destroy",
  "rel_entity_move", "entity_move_look", "entity_look", "entity_head_rotation",
  "entity_update_attributes", "entity_equipment", "update_attributes",
  "world_event", "sound_effect", "named_sound_effect", "action_bar",
  "multi_block_change", "block_change", "block_action", "sync_entity_position",
  "map_chunk", "unload_chunk", "update_light", "chunk_batch_start",
  "chunk_batch_finish", "update_time", "playerlist_header",
  "player_info", "player_remove", "teams", "scoreboard_objective",
  "scoreboard_score", "spawn_entity", "entity_effect", "remove_entity_effect",
  "set_passengers", "animation", "collect", "damage_event",
]);

// Outbound action packets we always keep the most-recent of, with full params.
// FreshSMP is NOT frozen, so it really sends these movement packets.
const TRACK_OUT = [
  "use_item", "block_dig", "block_place", "block_place_old",
  "held_item_slot", "arm_animation", "entity_action",
  "look", "position_look", "position", "flying",
  "settings", "client_information", "chat", "chat_command", "chat_message",
  "message_acknowledgement", // British spelling — the signed-chat ack `count`
];

// Inbound packets whose timing matters for the transfer / sequence diagnosis.
const TRACK_IN = [
  "login", "respawn", "position", "set_health", "update_health",
  "game_state_change", "abilities", "held_item_slot",
  "start_configuration", "finish_configuration", "cookie_request",
  "acknowledge_player_digging", "block_changed_ack", "set_cooldown",
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
  if (dir === "EVT") return true; // state/transfer markers always
  if (NOISE.has(name)) return false;
  if (dir === "OUT") return true; // every real bot action (movement/settings/queue)
  return TRACK_IN.includes(name) || name === "kick_disconnect" || name === "disconnect"
    || name === "system_chat" || name === "player_chat" || name === "profileless_chat"
    || name === "transaction" || name === "set_slot" || name === "window_items"
    || name === "block_break_animation" || name === "transfer";
}

function installDiagnostics(bot, entry) {
  const rawRing = [];      // {t, dir, name}
  const signalRing = [];   // {t, dir, name, brief}
  const seqLog = [];       // {t, name, sequence, rotation}
  const stateLog = [];     // {t, label, brief}  — the transfer timeline
  const lastOut = {};      // name -> {t, brief}
  const lastIn = {};       // name -> {t, brief}
  let inCount = 0;
  let outCount = 0;
  let lastQueueAt = 0;       // last outbound /queue — distinguishes a wanted transfer from a kick
  let lastAutoDumpAt = 0;    // throttle for in-session auto-dumps (proxy-absorbed kick loop)
  let prevState = null;      // previous connection state — backstop only fires on play→config
  const AUTO_DUMP_THROTTLE_MS = 8000;

  const pushRing = (ring, item, max) => {
    ring.push(item);
    if (ring.length > max) ring.shift();
  };

  const record = (dir, name, data) => {
    const t = Date.now();
    pushRing(rawRing, { t, dir, name }, RAW_RING_SIZE);
    if (keepInSignal(dir, name)) {
      pushRing(signalRing, { t, dir, name, brief: safeStr(data) }, SIGNAL_RING_SIZE);
    }
    if (dir === "OUT") {
      outCount++;
      if (name.startsWith("chat_command") || name.startsWith("chat_message")) lastQueueAt = t;
      if (TRACK_OUT.includes(name)) lastOut[name] = { t, brief: safeStr(data) };
      if (SEQUENCED.has(name) && data) {
        pushRing(seqLog, { t, name, sequence: data.sequence, rotation: data.rotation }, SEQ_LOG_SIZE);
      }
    } else {
      inCount++;
      if (TRACK_IN.includes(name)) lastIn[name] = { t, brief: safeStr(data) };
    }
  };

  // Connection state changes + transfers — the pivotal events. Recorded into the
  // dedicated state timeline AND inline in both rings for context.
  const recordEvent = (label, data) => {
    const t = Date.now();
    pushRing(stateLog, { t, label, brief: safeStr(data) }, STATE_LOG_SIZE);
    pushRing(rawRing, { t, dir: "EVT", name: label }, RAW_RING_SIZE);
    pushRing(signalRing, { t, dir: "EVT", name: label, brief: safeStr(data) }, SIGNAL_RING_SIZE);
  };

  // ── Outbound: wrap the RAW client write FIRST, before settings.js's interceptor
  // rebinds it. installSettingsInterceptor() then captures this diagWrite as its
  // origWrite, so every actually-sent packet — patched (settings) and
  // origWrite-bypassed (keep_alive echo, per-tick flying) alike — routes through
  // this recorder.
  const rawWrite = bot._client.write.bind(bot._client);
  bot._client.write = function diagWrite(name, params) {
    try { record("OUT", name, params); } catch {}
    return rawWrite(name, params);
  };

  // ── Inbound: every decoded packet from the server.
  bot._client.on("packet", (data, meta) => {
    try { record("IN", meta.name, data); } catch {}
  });

  // ── In-session auto-dump (throttled). The "Invalid sequence" kick is absorbed by
  // the Velocity proxy (survival→limbo→survival on the SAME socket), so mineflayer
  // never emits "kicked" and the onKick→dump path never fires. These triggers fire
  // the dump from inside the live session instead. The rings are NOT cleared on a
  // transfer, so a late trigger still holds the full pre-kick history.
  const maybeAutoDump = (reason) => {
    const now = Date.now();
    if (now - lastAutoDumpAt < AUTO_DUMP_THROTTLE_MS) return; // one dump per kick cycle
    lastAutoDumpAt = now;
    if (typeof entry._freshDump === "function") {
      try { entry._freshDump(reason); } catch (_) {}
    }
  };

  // Primary trigger: the proxy's "You were kicked from X: <reason>" notice arrives
  // as system_chat (NOT player_chat), so a player typing "ban"/"kicked" can't
  // false-trigger it.
  const KICK_NOTICE = /you were kicked from|invalid sequence|you were removed/i;
  bot._client.on("system_chat", (p) => {
    try {
      const txt = chatText(p && p.content).replace(/§./g, "").replace(/\s+/g, " ").trim();
      if (txt && KICK_NOTICE.test(txt)) {
        maybeAutoDump("BACKEND KICK (proxy-absorbed): " + txt.slice(0, 300));
      }
    } catch (_) {}
  });

  // ── State / transfer timeline.
  bot._client.on("state", (s) => {
    try { recordEvent(`STATE→${s}`, null); } catch {}
    // Backstop: an unexpected drop from PLAY back to configuration that we did NOT
    // cause with a /queue (no chat_command in the last ~3s) is a kick — catches
    // kicks that arrive with no system_chat reason. Requiring prev==="play"
    // excludes the initial login→configuration handshake; the lastQueueAt guard
    // excludes the legitimate /queue backend switch.
    if (prevState === "play" && s === "configuration" && Date.now() - lastQueueAt > 3000) {
      maybeAutoDump("forced transfer to configuration (no /queue sent)");
    }
    prevState = s;
  });
  bot._client.on("transfer", (p) => {
    try { recordEvent("TRANSFER", { host: p?.host, port: p?.port }); } catch {}
  });

  const startedAt = Date.now();

  // Positive online-uptime heartbeat (log only — sends ZERO packets). Self-clears
  // on disconnect.
  const HEARTBEAT_MS = 10 * 60 * 1000;
  const heartbeat = setInterval(() => {
    if (!bot._client || bot._client.ended) { clearInterval(heartbeat); return; }
    const upMin = Math.floor((Date.now() - startedAt) / 60000);
    console.log(`[freshsmp/diagnostics] 💚 ${entry.minecraftUser} online ${upMin}m — no kick yet`);
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  bot._client.once("end", () => clearInterval(heartbeat));

  entry._freshDump = (reason) => {
    const now = Date.now();
    const age = (t) => (t ? `${String(now - t).padStart(6)}ms ago` : "       never");
    const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
    const uptimeS = Math.floor((now - startedAt) / 1000);
    const arrowOf = (dir) => (dir === "OUT" ? "→ SENT" : dir === "EVT" ? "•• EVENT" : "← RECV");
    const L = [];

    L.push("");
    L.push("════════════════ FRESHSMP FORENSIC DUMP ════════════════");
    L.push(`  user        : ${entry.minecraftUser}`);
    L.push(`  mineflayer  : v${mineflayerVersion()}`);
    L.push(`  reason      : ${reasonText}`);
    L.push(`  state now   : ${bot._client && bot._client.state}`);
    L.push(`  session     : ~${uptimeS}s online, ${outCount} sent / ${inCount} received`);

    // The transfer timeline — the pivotal signal for the post-/queue kick.
    L.push("  ── connection STATE / transfer timeline (newest last) ──");
    if (stateLog.length === 0) {
      L.push("    (no state transitions recorded — never transferred this session)");
    } else {
      for (const e of stateLog) {
        L.push(`    -${String(now - e.t).padStart(7)}ms  ${e.label}${e.brief ? "  " + e.brief : ""}`);
      }
    }

    // Movement / settings / queue — present no matter how long before the kick.
    L.push("  ── last outbound ACTION packets (most-recent of each) ──");
    for (const name of TRACK_OUT) {
      const e = lastOut[name];
      L.push(`    ${name.padEnd(20)} ${age(e && e.t)}${e && e.brief ? "  " + e.brief : ""}`);
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

    L.push("  ── last relevant INBOUND packets ──");
    for (const name of TRACK_IN) {
      const e = lastIn[name];
      L.push(`    ${name.padEnd(24)} ${age(e && e.t)}${e && e.brief ? "  " + e.brief : ""}`);
    }

    // Interesting-only history — spans minutes, drops the flying/ping/world spam.
    L.push(`  ── signal ring: last ${signalRing.length} interesting packets (newest last) ──`);
    for (const e of signalRing) {
      L.push(`    -${String(now - e.t).padStart(7)}ms ${arrowOf(e.dir)} ${e.name}${e.brief ? "  " + e.brief : ""}`);
    }

    // The raw instant of the kick (all packets).
    L.push(`  ── raw tail: last ${rawRing.length} packets of everything (newest last) ──`);
    for (const e of rawRing) {
      L.push(`    -${String(now - e.t).padStart(7)}ms ${arrowOf(e.dir)} ${e.name}`);
    }

    L.push("═════════════════════════════════════════════════════════");
    L.push("");
    console.log(L.join("\n"));
  };

  console.log(
    `[freshsmp/diagnostics] 🔬 Forensic capture armed for ${entry.minecraftUser} ` +
    `— mineflayer v${mineflayerVersion()} ` +
    `(transfer-aware: state timeline + sequence, signal ring ${SIGNAL_RING_SIZE} + raw ${RAW_RING_SIZE})`
  );
}

function dump(entry, reason) {
  if (entry && typeof entry._freshDump === "function") {
    try { entry._freshDump(reason); } catch {}
  }
}

module.exports = { installDiagnostics, dump };
