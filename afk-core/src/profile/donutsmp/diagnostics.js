// afk-core/src/profile/donutsmp/diagnostics.js
"use strict";

// DonutSMP forensic capture — turns the next "Invalid sequence" kick into a
// definitive diagnosis instead of another guess.
//
// We keep a small in-memory ring buffer of the most recent inbound and outbound
// packets (cheap, bounded) and dump it the instant the bot is kicked / errors /
// ends. The dump shows, with millisecond timestamps relative to the disconnect:
//   • the mineflayer version actually loaded on this VPS (confirms whether the
//     use_item aim fix is even in effect)
//   • the last packets the bot SENT — including the exact use_item { sequence,
//     rotation } of the eat — and the last packets it RECEIVED
// so we can see precisely what the server rejected right before the kick.
//
// Recording is always on (it is just array pushes); the verbose per-packet
// console spam stays behind DONUTSMP_DEBUG=forensic in movement/keepAlive. Only
// the disconnect dump prints here, so this adds no steady-state log noise.

const RING_SIZE = 160;

// Packets whose params carry the fields that matter for an "Invalid sequence"
// diagnosis (block-interaction sequence, eat aim, movement rhythm, chat
// acknowledgment, transactions). For everything else we record the name only,
// so recording stays cheap even for ~20+ packets/sec.
const INTERESTING = new Set([
  // outbound
  "use_item", "block_dig", "block_place", "block_place_old",
  "position", "flying", "look", "position_look",
  "held_item_slot", "window_click", "set_creative_slot", "arm_animation",
  "keep_alive", "pong", "chat", "chat_message", "message_acknowledgment",
  "chat_command", "chat_command_signed", "tab_complete",
  // inbound
  "ping", "acknowledge_player_digging", "block_changed_ack", "block_break_animation",
  "set_cooldown", "entity_status", "system_chat", "player_chat", "profileless_chat",
  "disconnect", "kick_disconnect", "transaction", "set_slot", "window_items",
]);

function mineflayerVersion() {
  try {
    return require("mineflayer/package.json").version;
  } catch {
    return "unknown";
  }
}

function brief(name, data) {
  if (!INTERESTING.has(name) || data == null) return null;
  try {
    const s = JSON.stringify(data);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "(unserializable)";
  }
}

function installDiagnostics(bot, entry) {
  const ring = [];
  let inCount = 0;
  let outCount = 0;

  const record = (dir, name, data) => {
    const e = { t: Date.now(), dir, name, brief: brief(name, data) };
    ring.push(e);
    if (ring.length > RING_SIZE) ring.shift();
    if (dir === "IN") inCount++; else outCount++;
  };

  // ── Outbound: wrap the RAW client write FIRST, before movement suppression
  // rebinds it. Because installMovementSuppression() captures the current
  // bot._client.write as its `origWrite`, every actually-sent packet — proxied
  // (use_item, look) and origWrite-bypassed (keep_alive echo) alike — routes
  // through this recorder. (Suppressed position/flying never reach here, which
  // is fine: they are not sent, so they can't be what the server rejected.)
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
    const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
    const uptimeS = Math.floor((now - startedAt) / 1000);
    const lines = [];
    lines.push("");
    lines.push("════════════════ DonutSMP FORENSIC DUMP ════════════════");
    lines.push(`  user        : ${entry.minecraftUser}`);
    lines.push(`  mineflayer  : v${mineflayerVersion()}   (use_item aim fix is in 4.37.1+)`);
    lines.push(`  reason      : ${reasonText}`);
    lines.push(`  session     : ~${uptimeS}s online, ${outCount} sent / ${inCount} received`);
    lines.push(`  last ${ring.length} packets (Δms before disconnect, newest last):`);
    for (const e of ring) {
      const dt = now - e.t;
      const arrow = e.dir === "OUT" ? "→ SENT" : "← RECV";
      lines.push(`    -${String(dt).padStart(6)}ms ${arrow} ${e.name}${e.brief ? "  " + e.brief : ""}`);
    }
    lines.push("═════════════════════════════════════════════════════════");
    lines.push("");
    console.log(lines.join("\n"));
  };

  console.log(
    `[donutsmp/diagnostics] 🔬 Forensic capture armed for ${entry.minecraftUser} ` +
    `— mineflayer v${mineflayerVersion()} (dumps last ${RING_SIZE} packets on kick)`
  );
}

function dump(entry, reason) {
  if (entry && typeof entry._donutDump === "function") {
    try { entry._donutDump(reason); } catch {}
  }
}

module.exports = { installDiagnostics, dump };
