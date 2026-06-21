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
  // ONLY DonutSMP's genuine account-verification prompt — the one shown when a
  // login must be confirmed via the DonutSMP Discord bot (typically a first
  // login from a new IP). Keep this TIGHT and specific to that message.
  //
  // This matcher used to also include broad terms — "donutsmp", "invalid
  // sequence", "security check", bare "socketclosed" and bare "verification" —
  // which swallowed essentially EVERY kick into a silent verification reconnect.
  // That hid the real kick reason from the logs and skipped the user's "your bot
  // was kicked" DM entirely. Anything that is NOT this specific prompt must fall
  // through (return false) so botmanager surfaces the reason and notifies the
  // user. In particular an "invalid sequence" kick is a real kick, NOT
  // verification, and must be reported.
  return (
    r.includes("unauthorized login") ||
    r.includes("confirm it via") ||
    r.includes("discord dms") ||
    r.includes("direct messages enabled") ||
    r.includes("please verify") ||
    r.includes("verify your account")
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

  // Always surface the raw server-provided kick reason on stdout so it is never
  // hidden by classification below. (botmanager also logs it via console.warn /
  // stderr; this stdout copy is what shows up in the normal `pm2 logs` stream.)
  console.log(
    `[DonutSmpProfile] 🦵 [${entry.minecraftUser}] Kicked — server reason: ${reasonText || "(none provided)"}`
  );

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
