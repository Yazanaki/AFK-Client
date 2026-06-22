// afk-core/src/profile/donutsmp/keepAlive.js
"use strict";

// DonutSMP connection keep-alive — keeps the socket and Minecraft session alive
// so the bot is never dropped for inactivity:
//   • TCP SO_KEEPALIVE      — surfaces a dead socket cleanly (ECONNRESET, not a
//                             mid-write EPIPE).
//   • Minecraft keep_alive  — we run with keepAlive:false, so we echo it ourselves
//                             (via origWrite, to bypass the movement proxy).
//   • play-state ping       — DonutSMP's transaction probe. We do NOT pong it
//                             ourselves: mineflayer auto-pongs every ping, and a
//                             second manual pong is a duplicate the anti-cheat
//                             rejects as "Invalid sequence". We only watch pings
//                             for liveness.

const { KEEP_ALIVE_DEBUG } = require("./movement");

// OS-level idle probe delay. Detects a silently-dropped TCP connection.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60 * 1000;

// If the server goes silent (no keep_alive AND no ping) for this long, treat the
// connection as dead and force a disconnect. We run mineflayer with
// keepAlive:false, so nothing else detects a silent server-side kick — without
// this the bot would stay stuck reporting "online" forever. 0 disables it.
const KEEPALIVE_LIVENESS_TIMEOUT_MS = parseInt(
  process.env.DONUTSMP_KEEPALIVE_TIMEOUT_MS || "60000",
  10
);

function installKeepAlive(bot, origWrite) {
  // ── Liveness watchdog ──────────────────────────────────────────────────────
  // Track the last keep_alive / ping from the server. While the bot is genuinely
  // in-world these arrive constantly (ping is ~per-tick), so if they stop for
  // KEEPALIVE_LIVENESS_TIMEOUT_MS the session is dead even though no
  // kicked/end/error event fired. Forcing bot.end() routes through botmanager's
  // end handler, which flips the bot off "online" and reconnects.
  let lastInboundAt = Date.now();
  let livenessInterval = null;
  const markAlive = () => { lastInboundAt = Date.now(); };
  const stopLiveness = () => {
    if (livenessInterval) { clearInterval(livenessInterval); livenessInterval = null; }
  };
  const startLiveness = () => {
    lastInboundAt = Date.now();
    if (KEEPALIVE_LIVENESS_TIMEOUT_MS <= 0 || livenessInterval) return;
    const checkEvery = Math.max(5000, Math.floor(KEEPALIVE_LIVENESS_TIMEOUT_MS / 4));
    livenessInterval = setInterval(() => {
      if (Date.now() - lastInboundAt <= KEEPALIVE_LIVENESS_TIMEOUT_MS) return;
      console.warn(
        `[DonutSmpProfile] ⚠️ No keep_alive/ping for ${KEEPALIVE_LIVENESS_TIMEOUT_MS / 1000}s — ` +
        `connection looks dead; forcing disconnect so it stops reporting "online".`
      );
      stopLiveness();
      try { bot.end("keepalive_timeout"); }
      catch { try { bot._client.end("keepalive_timeout"); } catch {} }
    }, checkEvery);
    if (livenessInterval.unref) livenessInterval.unref();
  };
  bot.once("login", startLiveness);
  bot.once("end", stopLiveness);

  bot._client.once("connect", () => {
    try {
      const socket = bot._client.socket;
      if (socket && typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
        console.log(
          `[DonutSmpProfile] 🔌 TCP keepalive enabled (idle probe after ${TCP_KEEPALIVE_INITIAL_DELAY_MS / 1000}s)`
        );
      }
    } catch (err) {
      console.warn(`[DonutSmpProfile] ⚠️ Could not set TCP keepalive:`, err.message);
    }
  });

  bot._client.on("keep_alive", (packet) => {
    markAlive();
    try {
      origWrite("keep_alive", { keepAliveId: packet.keepAliveId });
      if (KEEP_ALIVE_DEBUG) {
        console.log(`[DonutSmpProfile] 💓 keep_alive echo — id=${packet.keepAliveId}`);
      }
    } catch (err) {
      if (KEEP_ALIVE_DEBUG) {
        console.warn(`[DonutSmpProfile] ⚠️ keep_alive echo failed (session closing):`, err.message);
      }
    }
  });

  bot._client.on("ping", (packet) => {
    // Track liveness ONLY — do not send a pong here.
    //
    // mineflayer's game.js auto-responds to every `ping` with a `pong`
    // unconditionally (it is NOT gated by the keepAlive:false option — that flag
    // only disables minecraft-protocol's keep_alive auto-echo, which is why we
    // still echo keep_alive manually above). Sending our own pong on top means
    // the server receives TWO pongs for every ping — a duplicate the DonutSMP
    // transaction anti-cheat rejects as "Invalid sequence". It accumulates and
    // kicks the bot after ~30-60 min. This duplicate pong was the root cause of
    // the periodic "Invalid sequence" kicks.
    markAlive();
    if (KEEP_ALIVE_DEBUG) {
      console.log(`[donut-pkt] 🏓 ping id=${packet.id} (mineflayer auto-pongs)`);
    }
  });

  if (KEEP_ALIVE_DEBUG) {
    bot._client.on("packet", (data, meta) => {
      try {
        console.log(`[donut-pkt] ← SERVER: ${meta.name}`, JSON.stringify(data).slice(0, 120));
      } catch {
        console.log(`[donut-pkt] ← SERVER: ${meta.name} (binary)`);
      }
    });
  }

  bot._client.on("plugin_message", (packet) => {
    const channel = packet?.channel || "unknown";
    const dataLen = packet?.data?.length ?? 0;
    console.log(`[DonutSmpProfile] plugin_message channel=${channel} bytes=${dataLen}`);
  });
}

module.exports = { installKeepAlive };
