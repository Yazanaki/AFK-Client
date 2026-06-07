// afk-core/src/profile/freshsmp/keepAlive.js
"use strict";

// FreshSMP connection handshake / keepalive. We run keepAlive:false, so we echo
// Minecraft keep_alive ourselves. We do NOT manually pong the play-state ping —
// minecraft-protocol already auto-responds, and a duplicate pong was a past
// cause of "Invalid sequence". We also answer Velocity's cookie_request, which
// mineflayer does not handle (an unanswered cookie_request → SERVER ERROR kick).
//
// All writes use origWrite (pre-settings-interceptor) so they bypass the patch.

function installKeepAlive(bot, entry, origWrite) {
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
