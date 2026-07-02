// afk-core/src/profile/freshsmp/reconnect.js
"use strict";

// FreshSMP transient-kick reconnect.
//
// FreshSMP's transaction / anti-cheat check can kick with "Invalid sequence"
// during the login / Velocity-transfer window — a packet-timing race, NOT an
// anti-bot ban. Left alone it falls through to botmanager's generic kick path
// and the AntiBotClassifier records it as a rejection, killing the bot.
//
// This mirrors the reusable half of the DonutSMP fix
// (donutsmp/verification.js → scheduleVerificationRetry): treat the kick as
// transient and reconnect a bounded number of times with a short delay. We do
// NOT port DonutSMP's movement-freeze — FreshSMP *requires* per-tick movement
// (see movement.js), so freezing would be actively wrong here.
//
// Shared verbatim by the ElementalMC profile (elementalmc/reconnect.js).

const MAX_RECONNECT_RETRIES = 10;
const RECONNECT_DELAY_MS = 5000;
// A connection that stayed up at least this long counts as "stable": a later
// kick is a fresh transient drop, not part of a login-window loop.
const STABLE_SESSION_SECONDS = 60;

/**
 * Should this kick be treated as a transient drop we reconnect from, rather
 * than a fatal/anti-bot kick?
 * @param {string} reasonText
 * @param {number|null} connectedSince - entry.connectedSince (ms epoch) or null
 */
function isTransientKick(reasonText, connectedSince) {
  if (!reasonText) return false;
  const r = String(reasonText).toLowerCase();
  // Paper/Velocity rejects connections with a bad packet sequence number during
  // the auth/login/transfer window — the exact "invalid sequence" the DonutSMP
  // fix targets.
  if (r.includes("invalid sequence")) return true;
  // A bare socket close early in the session is usually a transient drop too.
  if (r.includes("socketclosed")) {
    if (connectedSince == null) return true;
    return (Date.now() - connectedSince) / 1000 < STABLE_SESSION_SECONDS;
  }
  return false;
}

/**
 * Schedule a bounded reconnect. Resets the consecutive-retry counter when the
 * previous connection was stable, so a long-running bot that hits one transient
 * kick after hours of uptime starts fresh instead of being one attempt from the
 * cap — while a tight login-window loop still accumulates toward it.
 */
function scheduleReconnect(entry, spawnBot, version) {
  if (
    entry.connectedSince &&
    (Date.now() - entry.connectedSince) / 1000 >= STABLE_SESSION_SECONDS
  ) {
    entry.profileReconnectRetries = 0;
  }

  entry.profileReconnectRetries = (entry.profileReconnectRetries || 0) + 1;
  if (entry.profileReconnectRetries > MAX_RECONNECT_RETRIES) {
    console.error(
      `[FreshSmpProfile] ❌ [${entry.minecraftUser}] Reconnect retry limit reached — giving up`
    );
    entry.status = "error";
    entry.errorCategory = "freshsmp_invalid_sequence";
    entry.spawnError =
      "FreshSMP kept rejecting the connection ('invalid sequence') after multiple " +
      "retries. Wait a moment and try /mcbot start again.";
    return;
  }

  console.log(
    `[FreshSmpProfile] 🟠 [${entry.minecraftUser}] Transient kick — reconnect ` +
    `attempt ${entry.profileReconnectRetries}/${MAX_RECONNECT_RETRIES} in ${RECONNECT_DELAY_MS}ms`
  );
  entry.status = "reconnecting";
  setTimeout(() => spawnBot(version), RECONNECT_DELAY_MS);
}

module.exports = {
  MAX_RECONNECT_RETRIES,
  RECONNECT_DELAY_MS,
  STABLE_SESSION_SECONDS,
  isTransientKick,
  scheduleReconnect,
};
