"use strict";

const { BaseProfile } = require("./BaseProfile");
const { _sendClientSettings } = require("./DefaultProfile");

// ─── DonutSMP constants ────────────────────────────────────────────────────────

/** Exact version DonutSMP requires. Never use "auto" for DonutSMP. */
const DONUTSMP_VERSION = "1.21.11";

/**
 * How many verification/EPIPE reconnect attempts to allow before giving up.
 * Each attempt has its own delay before re-spawning.
 */
const MAX_VERIFICATION_RETRIES = 10;

/** ms to wait between verification reconnect attempts */
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

/**
 * DonutSmpProfile
 *
 * Encapsulates ALL DonutSMP-specific quirks:
 *
 *   VERSION
 *     Always connects with 1.21.11 — no auto-detection.
 *
 *   MOVEMENT BLOCK
 *     Permanently intercepts bot._client.write() and drops any
 *     "position", "flying", or "look" packets for the entire session.
 *     An AFK bot has no legitimate reason to send these.
 *     "position_look" (teleport echo) is always allowed through.
 *
 *   PING / PONG
 *     Some Paper builds (including DonutSMP) send a `ping` packet as a
 *     secondary liveness probe. mineflayer does NOT auto-respond.
 *     We echo back `pong` immediately via the raw write bypass so the
 *     movement block cannot accidentally suppress it.
 *
 *   PACKET LOGGING
 *     All inbound server packets are logged to stdout for debugging.
 *     All outbound client writes (blocked or allowed) are also logged.
 *
 *   VERIFICATION RECONNECT
 *     DonutSMP runs a security check that disconnects the client shortly
 *     after the TCP handshake. We detect this via:
 *       - EPIPE errors (server closed socket during handshake)
 *       - "socketClosed" end-reason before login or within 30 s of login
 *     On detection we schedule a retry (up to MAX_VERIFICATION_RETRIES).
 *
 *   KEEP-ALIVE
 *     mineflayer's keep_alive echo is handled by Session.js / botmanager.
 *     We do NOT add a second echo here — a duplicate causes Paper to kick
 *     with "Invalid sequence".
 */
class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
  }

  // ── onBotCreated ────────────────────────────────────────────────────────────

  onBotCreated(bot, entry, botId, spawnBot) {
    entry.donutSmpVerificationRetries = entry.donutSmpVerificationRetries || 0;
    entry.donutSmpReadyAt = 0; // Set after quiet window elapses; 0 = stay quiet

    _installMovementBlock(bot, entry, botId, entry.minecraftUser);
    _installPacketLogger(bot);

    console.log(
      `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] ` +
      `Bot created — movement block + packet logger active`
    );
  }

  // ── onLogin ─────────────────────────────────────────────────────────────────

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    console.log(
      `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] ` +
      `Login OK (retry ${entry.donutSmpVerificationRetries}/${MAX_VERIFICATION_RETRIES}). ` +
      `Movement block active — monitoring for verification disconnect.`
    );

    const { onLinkVerified } = callbacks || {};
    if (typeof onLinkVerified === "function") {
      try { onLinkVerified(entry.discordId, entry.minecraftUser); } catch (_) {}
    }
  }

  // ── onSpawn ─────────────────────────────────────────────────────────────────

  onSpawn(bot, entry, botId) {
    console.log(
      `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] Spawn fired — movement block still active`
    );
  }

  // ── onKick ──────────────────────────────────────────────────────────────────

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, autoCandidates, autoVersionState) {
    if (_isVerificationKick(reasonText)) {
      console.log(
        `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] ` +
        `Verification kick detected — scheduling retry`
      );
      _scheduleVerificationRetry(botId, entry, spawnBot, "kick");
      return true; // handled
    }
    return false;
  }

  // ── onError ─────────────────────────────────────────────────────────────────

  onError(bot, entry, botId, err, spawnBot) {
    if (_isEpipe(err.code)) {
      const phase = entry.connectedSince === null ? "pre-login (EPIPE)" : "post-login (EPIPE)";
      console.log(
        `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] ` +
        `EPIPE detected (${phase}) — treating as verification disconnect`
      );
      _scheduleVerificationRetry(botId, entry, spawnBot, phase);
      return true; // handled
    }
    return false;
  }

  // ── onEnd ───────────────────────────────────────────────────────────────────

  onEnd(bot, entry, botId, reason, spawnBot) {
    if (_isVerificationDisconnect(reason, entry.connectedSince)) {
      const phase = entry.connectedSince === null ? "pre-login" : "post-login";
      _scheduleVerificationRetry(botId, entry, spawnBot, phase);
      return true; // handled
    }
    return false;
  }
}

// ─── Private helpers ───────────────────────────────────────────────────────────

/**
 * Permanently intercept bot._client.write() and suppress autonomous
 * position/flying/look packets. Also installs ping→pong via the raw bypass.
 */
function _installMovementBlock(bot, entry, botId, minecraftUser) {
  if (bot.physicsEnabled !== undefined) {
    bot.physicsEnabled = false;
  }

  const origWrite = bot._client.write.bind(bot._client);
  const BLOCKED = new Set(["position", "flying", "look"]);

  bot._client.write = function donutSmpMovementBlock(name, params) {
    if (BLOCKED.has(name)) {
      try {
        const preview = JSON.stringify(params);
        console.log(
          `[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`,
          (preview || "(non-serializable)").slice(0, 120)
        );
      } catch {
        console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED] (non-serializable)`);
      }
      return;
    }

    try {
      const preview = JSON.stringify(params);
      console.log(
        `[donut-pkt] → CLIENT sent: ${name}`,
        (preview || "(non-serializable)").slice(0, 120)
      );
    } catch {
      console.log(`[donut-pkt] → CLIENT sent: ${name} (non-serializable)`);
    }

    return origWrite(name, params);
  };

  // Ping/pong — use origWrite to bypass the movement block entirely
  bot._client.on("ping", (packet) => {
    try {
      origWrite("pong", { id: packet.id });
      console.log(`[donut-pkt] 🏓 ping received id=${packet.id} → pong sent`);
    } catch (err) {
      console.warn(`[DonutSmpProfile] ⚠️ [${minecraftUser}] Could not send pong:`, err.message);
    }
  });

  console.log(
    `[DonutSmpProfile] 🟠 [${minecraftUser}] ` +
    `Movement block installed — position/flying/look permanently suppressed`
  );
}

/**
 * Log every inbound server packet to stdout.
 */
function _installPacketLogger(bot) {
  bot._client.on("packet", (data, meta) => {
    try {
      const serialized = JSON.stringify(data);
      const preview = serialized ? serialized.slice(0, 120) : "(non-serializable)";
      console.log(`[donut-pkt] ← SERVER sent: ${meta.name}`, preview);
    } catch {
      console.log(`[donut-pkt] ← SERVER sent: ${meta.name} (binary/non-serializable)`);
    }
  });
}

/**
 * Returns true if the error code is EPIPE (server closed socket during handshake).
 */
function _isEpipe(errCode) {
  return errCode === "EPIPE";
}

/**
 * Returns true if the kick reason text looks like a DonutSMP verification kick.
 * Extend this list as new patterns are observed.
 */
function _isVerificationKick(reasonText) {
  if (!reasonText) return false;
  const r = reasonText.toLowerCase();
  return (
    r.includes("socketclosed") ||
    r.includes("verification") ||
    r.includes("please verify") ||
    r.includes("security check")
  );
}

/**
 * Returns true if an end-reason looks like the DonutSMP verification disconnect.
 * Covers both pre-login (connectedSince === null) and early post-login (< 30 s online).
 */
function _isVerificationDisconnect(reason, connectedSince) {
  if (!reason) return false;
  const r = (typeof reason === "string" ? reason : JSON.stringify(reason)).toLowerCase();
  if (!r.includes("socketclosed")) return false;

  if (connectedSince === null) return true; // Never made it past handshake

  const secondsOnline = Math.floor((Date.now() - connectedSince) / 1000);
  return secondsOnline < 30;
}

/**
 * Schedule a verification reconnect attempt, or give up if the retry limit is hit.
 * Mutates entry.donutSmpVerificationRetries and entry.status.
 *
 * @param {string}   botId
 * @param {object}   entry     - botmanager registry entry (mutable)
 * @param {Function} spawnBot  - function(version) provided by botmanager
 * @param {string}   phase     - label for logging only
 */
function _scheduleVerificationRetry(botId, entry, spawnBot, phase) {
  entry.donutSmpVerificationRetries = (entry.donutSmpVerificationRetries || 0) + 1;

  if (entry.donutSmpVerificationRetries > MAX_VERIFICATION_RETRIES) {
    console.error(
      `[DonutSmpProfile] ❌ [${entry.minecraftUser}] ` +
      `Verification retry limit (${MAX_VERIFICATION_RETRIES}) reached — giving up`
    );
    entry.status = "error";
    entry.errorCategory = "donutsmp_verification";
    entry.spawnError =
      "DonutSMP security check failed after maximum retries. " +
      "Please verify your account via the DonutSMP Discord bot, then try /mcbot start again.";
    return;
  }

  console.log(
    `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] ` +
    `Verification reconnect (${phase}) — ` +
    `attempt ${entry.donutSmpVerificationRetries}/${MAX_VERIFICATION_RETRIES} ` +
    `in ${VERIFICATION_RECONNECT_DELAY_MS}ms`
  );

  entry.status = "reconnecting";

  setTimeout(() => {
    // botmanager will have removed the entry if stopBot() was called — check first
    // We rely on botmanager's activeBots check inside spawnBot via the isCurrentBot guard
    spawnBot(DONUTSMP_VERSION);
  }, VERIFICATION_RECONNECT_DELAY_MS);
}

module.exports = { DonutSmpProfile, DONUTSMP_VERSION };