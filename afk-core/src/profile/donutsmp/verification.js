// afk-core/src/profile/donutsmp/verification.js
"use strict";

// DonutSMP verification & reconnect handling. DonutSMP requires a Discord
// verification step; before it completes the server drops/kicks the connection
// in various ways. We detect those and reconnect (up to a limit) instead of
// treating them as fatal.

const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;
const VERIFICATION_WINDOW_SECONDS = 60;
const MID_SESSION_RECONNECT_DELAY_MS = 8000;
// "Already online" means our previous session is still alive server-side. Wait
// longer so the server can time out the ghost before we reconnect (typically
// 10-30s for Minecraft servers).
const ALREADY_ONLINE_RECONNECT_DELAY_MS = 20000;

function isSocketResetError(errCode) {
  return errCode === "EPIPE" || errCode === "ECONNRESET";
}

function isWithinVerificationWindow(connectedSince) {
  if (connectedSince === null) return true;
  return (Date.now() - connectedSince) / 1000 < VERIFICATION_WINDOW_SECONDS;
}

function isVerificationDisconnect(reason, connectedSince) {
  if (!reason) return false;
  const r = (typeof reason === "string" ? reason : JSON.stringify(reason)).toLowerCase();
  if (!r.includes("socketclosed")) return false;
  return isWithinVerificationWindow(connectedSince);
}

function isVerificationKick(reasonText) {
  if (!reasonText) return false;
  const r = reasonText.toLowerCase();
  return (
    // socketclosed / pre-login disconnects
    r.includes("socketclosed") ||
    // generic verification language
    r.includes("verification") ||
    r.includes("please verify") ||
    r.includes("security check") ||
    // DonutSMP's actual kick messages (observed in logs)
    r.includes("unauthorized login") ||
    r.includes("blocked it") ||
    r.includes("confirm it via") ||
    r.includes("discord dms") ||
    r.includes("direct messages enabled") ||
    r.includes("donutsmp") ||
    // Paper rejects connections with bad packet sequence numbers during the
    // auth/login window; treat it as transient and retry like other verification kicks.
    r.includes("invalid sequence")
  );
}

function scheduleVerificationRetry(entry, spawnBot, phase, version) {
  entry.donutSmpVerificationRetries = (entry.donutSmpVerificationRetries || 0) + 1;
  if (entry.donutSmpVerificationRetries > MAX_VERIFICATION_RETRIES) {
    console.error(
      `[DonutSmpProfile] ❌ [${entry.minecraftUser}] Verification retry limit reached — giving up`
    );
    entry.status = "error";
    entry.errorCategory = "donutsmp_verification";
    entry.spawnError =
      "DonutSMP security check failed after maximum retries. Please verify your account via the DonutSMP Discord bot, then try /mcbot start again.";
    return;
  }
  console.log(
    `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] Verification reconnect (${phase}) — ` +
    `attempt ${entry.donutSmpVerificationRetries}/${MAX_VERIFICATION_RETRIES} in ${VERIFICATION_RECONNECT_DELAY_MS}ms`
  );
  entry.status = "reconnecting";
  setTimeout(() => spawnBot(version), VERIFICATION_RECONNECT_DELAY_MS);
}

// ── Lifecycle-hook handlers (called from index.js) ───────────────────────────

function handleKick(entry, reasonText, spawnBot, version) {
  const r = (reasonText || "").toLowerCase();

  // "Already online" — wait for the ghost session to clear, then retry.
  if (r.includes("already online")) {
    entry.donutSmpVerificationRetries = (entry.donutSmpVerificationRetries || 0) + 1;
    if (entry.donutSmpVerificationRetries > MAX_VERIFICATION_RETRIES) {
      console.error(
        `[DonutSmpProfile] ❌ [${entry.minecraftUser}] Retry limit reached on "already online" — giving up`
      );
      entry.status = "error";
      entry.errorCategory = "donutsmp_verification";
      entry.spawnError =
        "DonutSMP reported 'already online' too many times. Please verify your account via the DonutSMP Discord bot, then try /mcbot start again.";
      return true;
    }
    console.log(
      `[DonutSmpProfile] 🟠 [${entry.minecraftUser}] "Already online" kick — ` +
      `waiting ${ALREADY_ONLINE_RECONNECT_DELAY_MS}ms for ghost session to clear ` +
      `(attempt ${entry.donutSmpVerificationRetries}/${MAX_VERIFICATION_RETRIES})`
    );
    entry.status = "reconnecting";
    setTimeout(() => spawnBot(version), ALREADY_ONLINE_RECONNECT_DELAY_MS);
    return true;
  }

  if (isVerificationKick(reasonText)) {
    console.log(
      `[DonutSmpProfile] 🔐 [${entry.minecraftUser}] Verification kick detected — scheduling reconnect`
    );
    scheduleVerificationRetry(entry, spawnBot, "kick", version);
    return true;
  }
  return false;
}

function handleError(entry, err, spawnBot, version) {
  if (!isSocketResetError(err.code)) return false;

  if (isWithinVerificationWindow(entry.connectedSince)) {
    // Pre-login or very early session — treat as a verification reconnect.
    scheduleVerificationRetry(entry, spawnBot, `${err.code}`, version);
    return true;
  }

  // Mid-session drop — reconnect silently without bumping the verification
  // counter and without letting botmanager record this as an ended bot.
  const uptimeSec = entry.connectedSince
    ? Math.floor((Date.now() - entry.connectedSince) / 1000)
    : null;
  console.log(
    `[DonutSmpProfile] 🔄 [${entry.minecraftUser}] Mid-session ${err.code} after ` +
    `${uptimeSec !== null ? uptimeSec + "s online" : "pre-login"} — reconnecting silently in ${MID_SESSION_RECONNECT_DELAY_MS}ms`
  );
  entry.status = "reconnecting";
  setTimeout(() => spawnBot(version), MID_SESSION_RECONNECT_DELAY_MS);
  return true;
}

function handleEnd(entry, reason, spawnBot, version) {
  if (isVerificationDisconnect(reason, entry.connectedSince)) {
    scheduleVerificationRetry(entry, spawnBot, "end", version);
    return true;
  }
  return false;
}

module.exports = {
  handleKick,
  handleError,
  handleEnd,
  // exported for completeness / potential reuse
  isSocketResetError,
  isWithinVerificationWindow,
  isVerificationDisconnect,
  isVerificationKick,
  scheduleVerificationRetry,
};
