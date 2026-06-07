// afk-core/src/profile/donutsmp/keepAlive.js
"use strict";

// DonutSMP connection keep-alive — keeps the socket and Minecraft session alive
// so the bot is never dropped for inactivity:
//   • TCP SO_KEEPALIVE      — surfaces a dead socket cleanly (ECONNRESET, not a
//                             mid-write EPIPE).
//   • Minecraft keep_alive  — we run with keepAlive:false, so we echo it ourselves.
//   • play-state ping → pong — DonutSMP's transaction probe.
//
// All writes use origWrite (the pre-movement-suppression write) so they are
// never dropped by the movement proxy.

const { KEEP_ALIVE_DEBUG } = require("./movement");

// OS-level idle probe delay. Detects a silently-dropped TCP connection.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60 * 1000;

function installKeepAlive(bot, origWrite) {
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
    try {
      origWrite("pong", { id: packet.id });
      console.log(`[donut-pkt] 🏓 ping id=${packet.id} → pong sent`);
    } catch (err) {
      console.warn(`[DonutSmpProfile] ⚠️ Could not send pong:`, err.message);
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
