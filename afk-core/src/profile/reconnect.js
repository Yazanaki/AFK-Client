// afk-core/src/profile/reconnect.js
"use strict";

// Shared recovery policy for *silent* connection drops.
//
// A "silent drop" is a TCP socket that the server — or a proxy in front of it
// (Velocity / BungeeCord / a DDoS-protection layer) — closed WITHOUT sending a
// kick_disconnect packet. mineflayer surfaces these as:
//   • bot.on("end", "socketClosed")          — clean FIN, no kick reason
//   • bot.on("error", { code: "ECONNRESET" }) — forced TCP reset
//   • bot.on("error", { code: "EPIPE" })       — write to an already-closed socket
//   • bot.on("error", { code: "ETIMEDOUT" })   — OS gave up on a dead socket
//   • bot.on("end", "keepalive_timeout")       — our own liveness watchdog fired
//
// None of these carry a server-provided reason. They are almost always
// transient — a proxy read-timeout, a backend restart, a lag spike, or a
// network blip — and the correct response is to reconnect automatically rather
// than treat them as a fatal kick and notify the user.
//
// Why this is independent of the global AUTO_RECONNECT flag: a silent socket
// close is a NETWORK event, not something the operator or the server chose to
// tell us about. DonutSMP already auto-recovers pre-login socket resets this
// way (see donutsmp/verification.js); this module extends the same treatment to
// mid-session drops for every profile, with backoff so a genuinely-down server
// is not hammered. Set RECONNECT_ON_SOCKET_CLOSE=false to fall back to the old
// AUTO_RECONNECT-gated behaviour.

const ENABLED = String(process.env.RECONNECT_ON_SOCKET_CLOSE || "true").toLowerCase() !== "false";

// Backoff: base * 2^(attempt-1), capped, plus jitter. The counter RESETS after a
// healthy session (online past HEALTHY_MS) so an isolated blip reconnects fast
// while a flapping server backs off toward the cap.
const BASE_MS    = parseInt(process.env.SILENT_RECONNECT_BASE_MS    || "5000",  10);
const MAX_MS     = parseInt(process.env.SILENT_RECONNECT_MAX_MS     || "60000", 10);
const HEALTHY_MS = parseInt(process.env.SILENT_RECONNECT_HEALTHY_MS || "60000", 10);

// end-reason strings that mean "socket dropped, no kick".
const SILENT_END_REASONS = ["socketclosed", "socketclose", "keepalive_timeout"];
// error codes that mean the same at the TCP layer.
const SILENT_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT"]);

// Pending reconnect timers, keyed by botId, so a manual stop / cleanup can
// cancel a scheduled reconnect before it spawns a ghost bot.
const pendingTimers = new Map();

function isSilentDropReason(reason) {
  if (!reason) return false;
  const r = (typeof reason === "string" ? reason : JSON.stringify(reason)).toLowerCase();
  return SILENT_END_REASONS.some((s) => r.includes(s));
}

function isSilentDropError(err) {
  return !!(err && err.code && SILENT_ERROR_CODES.has(err.code));
}

function computeBackoff(attempt) {
  const exp = Math.min(MAX_MS, BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
  // Up to +30% jitter — de-synchronises many alts reconnecting off the same drop.
  return Math.round(exp + Math.random() * exp * 0.3);
}

/**
 * Schedule an automatic reconnect for a silent drop.
 *
 * @returns {boolean} true if a reconnect was scheduled (caller should treat the
 *   event as handled), false if silent-reconnect is disabled (caller should
 *   fall through to its default handling).
 */
function scheduleSilentReconnect(entry, botId, spawnBot, version, label) {
  if (!ENABLED) return false;

  // Reset the attempt counter if the last session was healthy — an isolated
  // drop should reconnect at the base delay, not inherit a long backoff.
  const wasHealthy =
    entry.connectedSince && Date.now() - entry.connectedSince >= HEALTHY_MS;
  if (wasHealthy) entry._silentReconnectAttempts = 0;

  entry._silentReconnectAttempts = (entry._silentReconnectAttempts || 0) + 1;
  const delay = computeBackoff(entry._silentReconnectAttempts);

  const uptimeSec = entry.connectedSince
    ? Math.floor((Date.now() - entry.connectedSince) / 1000)
    : null;
  console.log(
    `[reconnect] 🔌 [${entry.minecraftUser}] Silent drop (${label}) after ` +
      `${uptimeSec !== null ? uptimeSec + "s online" : "pre-login"} — ` +
      `auto-reconnecting in ${Math.round(delay / 1000)}s ` +
      `(attempt ${entry._silentReconnectAttempts})`
  );

  entry.status = "reconnecting";
  cancel(botId); // clear any earlier pending timer for this bot
  const timer = setTimeout(() => {
    pendingTimers.delete(botId);
    try {
      spawnBot(version);
    } catch (err) {
      console.error(`[reconnect] ❌ [${entry.minecraftUser}] reconnect spawn threw:`, err.message);
    }
  }, delay);
  if (timer.unref) timer.unref();
  pendingTimers.set(botId, timer);
  return true;
}

/** Cancel a pending reconnect (call from the profile's onCleanup). */
function cancel(botId) {
  const timer = pendingTimers.get(botId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(botId);
  }
}

module.exports = {
  isSilentDropReason,
  isSilentDropError,
  scheduleSilentReconnect,
  computeBackoff,
  cancel,
};
