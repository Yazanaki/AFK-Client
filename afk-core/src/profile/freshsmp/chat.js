// afk-core/src/profile/freshsmp/chat.js
"use strict";

// FreshSMP signed-chat acknowledgment reset across a Velocity transfer.
//
// minecraft-protocol tracks signed chat per CLIENT, not per backend: it keeps
// `client._lastSeenMessages` (an Array subclass) with a `.pending` counter, does
// `_lastSeenMessages.push(sig)` on every received `player_chat`, and when
// `pending > 64` sends `message_acknowledgement { count: pending }` then resets
// `pending = 0`. That state is initialised ONCE at client creation and is NEVER
// reset on a state change / transfer / login.
//
// A FreshSMP `/queue` is a Velocity backend switch on the SAME socket (only the
// `state` flips play→config→play). So `pending` carries the lobby count into the
// fresh survival backend; ~20 s of busy survival chat pushes it past 64; the bot
// then acknowledges a `count` the new backend never sent → the backend rejects it
// as "Invalid sequence" and the proxy bounces us to limbo. (~20 s = the time to
// accumulate >64 messages — matches the observed kick timing.)
//
// Fix: on every entry into PLAY (harmless no-op on the initial login, corrective
// on a transfer) reset the per-client chat-ack state SYNCHRONOUSLY — before any
// new-backend `player_chat` arrives — so the bot starts the new backend's chat
// session from a clean count. Every field touch is guarded so this is safe across
// minecraft-protocol versions (field shapes differ between 1.19.1–1.19.2 and
// 1.19.3+).

function installChatSessionReset(bot, entry) {
  bot._client.on("state", (newState) => {
    if (newState !== "play") return;
    const client = bot._client;
    if (!client) return;

    let pendingWas = null;
    try {
      const ls = client._lastSeenMessages;
      if (ls) {
        if (typeof ls.pending === "number") pendingWas = ls.pending;
        if (typeof ls.length === "number") ls.length = 0; // clear tracked signatures
        if ("pending" in ls) ls.pending = 0;
        if ("offset" in ls) ls.offset = 0; // 1.19.1–1.19.2 chained variant
      }
    } catch (_) { /* field shape differs — ignore */ }

    try { if ("_lastChatSignature" in client) client._lastChatSignature = null; } catch (_) {}
    try { if ("_lastRejectedMessage" in client) client._lastRejectedMessage = null; } catch (_) {}

    console.log(
      `[FreshSmpProfile] 🔁 [${entry.minecraftUser}] chat-ack state reset on play re-entry` +
      (pendingWas != null ? ` (pending was ${pendingWas})` : "")
    );
  });
}

module.exports = { installChatSessionReset };
