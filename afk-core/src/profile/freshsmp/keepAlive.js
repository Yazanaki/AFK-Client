// afk-core/src/profile/freshsmp/keepAlive.js
"use strict";

// FreshSMP connection handshake / keepalive. We run keepAlive:false, so we echo
// Minecraft keep_alive ourselves. We do NOT manually pong the play-state ping —
// minecraft-protocol already auto-responds, and a duplicate pong was a past
// cause of "Invalid sequence". We also answer Velocity's cookie_request, which
// mineflayer does not handle (an unanswered cookie_request → SERVER ERROR kick).
//
// All writes use origWrite (pre-settings-interceptor) so they bypass the patch.

// OS-level idle probe delay. With SO_KEEPALIVE the kernel probes an idle
// connection and surfaces a dead one as a clean ECONNRESET (which we
// auto-reconnect) instead of letting it hang half-open until a much later
// timeout — and it keeps NAT/proxy mappings warm on a quiet, idle session.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60 * 1000;

function installKeepAlive(bot, entry, origWrite) {
  bot._client.once("connect", () => {
    try {
      const socket = bot._client.socket;
      if (socket && typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, TCP_KEEPALIVE_INITIAL_DELAY_MS);
        console.log(
          `[FreshSmpProfile] 🔌 [${entry.minecraftUser}] TCP keepalive enabled ` +
            `(idle probe after ${TCP_KEEPALIVE_INITIAL_DELAY_MS / 1000}s)`
        );
      }
    } catch (err) {
      console.warn(`[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] Could not set TCP keepalive:`, err.message);
    }
  });

  // Minecraft keep_alive echo (required because keepAlive:false).
  bot._client.on("keep_alive", (packet) => {
    try {
      origWrite("keep_alive", { keepAliveId: packet.keepAliveId });
    } catch (_) {
      // Session is closing — ignore.
    }
  });

  // play-state ping → pong: do NOT manually respond; defer to minecraft-protocol.
  // Log the first few so we can confirm it's still answering them.
  let _pingSeen = 0;
  bot._client.on("ping", (packet) => {
    if (++_pingSeen <= 3) {
      console.log(
        `[fresh-life] ${new Date().toISOString()} [${entry.minecraftUser}] ` +
        `(ping #${_pingSeen} id=${packet.id}) — pong handled by minecraft-protocol, not manually`
      );
    }
  });

  // Velocity cookie_request (1.20.5+) → empty cookie_response, else SERVER ERROR.
  bot._client.on("cookie_request", (packet) => {
    try {
      origWrite("cookie_response", { key: packet.key, payload: null });
      console.log(`[FreshSmpProfile] 🍪 [${entry.minecraftUser}] cookie_response sent for key=${packet.key}`);
    } catch (_) {}
  });
}

module.exports = { installKeepAlive };
