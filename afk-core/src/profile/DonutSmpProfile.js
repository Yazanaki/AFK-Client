// afk-core/src/profile/DonutSmpProfile.js
"use strict";

const { BaseProfile } = require("./BaseProfile");

const DONUTSMP_VERSION = "1.21.11";
const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

// A socket reset is only considered a verification event if:
//   - connectedSince is null (bot never made it past login), OR
//   - the session was younger than this threshold when the reset happened.
// After this window, EPIPE/ECONNRESET are treated as normal disconnects.
const VERIFICATION_WINDOW_SECONDS = 60;

// Anti-AFK head rotation — fires via origWrite to bypass the movement block.
// Interval is randomized each time to avoid a detectable pattern.
const ANTI_AFK_MIN_MS = 3 * 60 * 1000; // 3 minutes
const ANTI_AFK_MAX_MS = 6 * 60 * 1000; // 6 minutes
const ANTI_AFK_YAW_DELTA_MIN = 2;       // degrees
const ANTI_AFK_YAW_DELTA_MAX = 8;       // degrees
const ANTI_AFK_RETURN_DELAY_MS = 1500;  // ms before nudging back

const KEEP_ALIVE_DEBUG =
  String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
    // Map<botId, timeoutId> — one scheduled timeout per active bot
    this._antiAfkTimers = new Map();
  }

  buildClientOptions(base) {
    return {
      ...base,
      keepAlive: false,
    };
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    const origWrite = bot._client.write.bind(bot._client);
    const BLOCKED = new Set(["position", "flying", "look"]);

    // ── Movement suppression ─────────────────────────────────────────────────
    bot._client.write = function donutSmpMovementBlock(name, params) {
      if (BLOCKED.has(name)) {
        if (KEEP_ALIVE_DEBUG) {
          try {
            console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`, JSON.stringify(params).slice(0, 120));
          } catch {
            console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`);
          }
        }
        return;
      }
      if (KEEP_ALIVE_DEBUG) {
        try {
          console.log(`[donut-pkt] → CLIENT sent: ${name}`, JSON.stringify(params).slice(0, 120));
        } catch {
          console.log(`[donut-pkt] → CLIENT sent: ${name} (non-serializable)`);
        }
      }
      return origWrite(name, params);
    };

    entry._donutOrigWrite = origWrite;

    // ── Manual keep-alive echo ───────────────────────────────────────────────
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

    // ── Ping / pong ──────────────────────────────────────────────────────────
    bot._client.on("ping", (packet) => {
      try {
        origWrite("pong", { id: packet.id });
        console.log(`[donut-pkt] 🏓 ping id=${packet.id} → pong sent`);
      } catch (err) {
        console.warn(`[DonutSmpProfile] ⚠️ Could not send pong:`, err.message);
      }
    });

    // ── Packet logger (forensic mode only) ──────────────────────────────────
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

    // ── Anti-AFK head rotation — start scheduling after login ────────────────
    // We wait for login so we have a valid yaw to work from, and so we don't
    // send look packets during the pre-login security screen.
    bot.once("login", () => {
      this._scheduleAntiAfk(botId, entry, bot, origWrite);
    });

    console.log(
      `[DonutSmpProfile] ✅ Handlers attached — movement block + manual keep-alive + ping/pong + anti-AFK active`
    );
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {}
  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    if (DonutSmpProfile.isVerificationKick(reasonText)) {
      DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, "kick");
      return true;
    }
    return false;
  }

  onError(bot, entry, botId, err, spawnBot) {
    if (DonutSmpProfile.isSocketResetError(err.code)) {
      if (DonutSmpProfile.isWithinVerificationWindow(entry.connectedSince)) {
        DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, `${err.code || "socket_reset"}`);
        return true;
      }
      const uptimeSec = entry.connectedSince
        ? Math.floor((Date.now() - entry.connectedSince) / 1000)
        : null;
      console.log(
        `[DonutSmpProfile] 🔌 [${entry.minecraftUser}] ${err.code} after ${
          uptimeSec !== null ? uptimeSec + "s online" : "pre-login"
        } — not a verification event, deferring to botmanager`
      );
      return false;
    }
    return false;
  }

  onEnd(bot, entry, botId, reason, spawnBot) {
    if (DonutSmpProfile.isVerificationDisconnect(reason, entry.connectedSince)) {
      DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, "end");
      return true;
    }
    return false;
  }

  onCleanup(botId) {
    this._cancelAntiAfk(botId);
  }

  // ── Anti-AFK ─────────────────────────────────────────────────────────────────

  /**
   * Schedule the next anti-AFK head nudge for this bot.
   * Uses a randomized interval each time so the pattern isn't mechanical.
   */
  _scheduleAntiAfk(botId, entry, bot, origWrite) {
    this._cancelAntiAfk(botId);

    const delayMs =
      ANTI_AFK_MIN_MS +
      Math.floor(Math.random() * (ANTI_AFK_MAX_MS - ANTI_AFK_MIN_MS));

    const timerId = setTimeout(() => {
      this._antiAfkTimers.delete(botId);
      this._doAntiAfkNudge(botId, entry, bot, origWrite);
    }, delayMs);

    this._antiAfkTimers.set(botId, timerId);
  }

  /**
   * Perform a small random yaw nudge, then nudge back after a short delay.
   * Only fires if the bot is still online. Schedules the next nudge when done.
   */
  _doAntiAfkNudge(botId, entry, bot, origWrite) {
    // Bail if bot is no longer active or not online
    if (entry.status !== "online") return;
    if (!bot || bot._client?.ended) return;

    // Read current yaw from mineflayer's entity — falls back to 0 if unavailable
    const currentYaw = (bot.entity && typeof bot.entity.yaw === "number")
      ? bot.entity.yaw
      : 0;
    const currentPitch = (bot.entity && typeof bot.entity.pitch === "number")
      ? bot.entity.pitch
      : 0;

    // Random yaw delta in degrees, converted to radians, randomly left or right
    const deltaDeg =
      ANTI_AFK_YAW_DELTA_MIN +
      Math.random() * (ANTI_AFK_YAW_DELTA_MAX - ANTI_AFK_YAW_DELTA_MIN);
    const deltaRad = (deltaDeg * Math.PI) / 180;
    const direction = Math.random() < 0.5 ? 1 : -1;
    const nudgedYaw = currentYaw + direction * deltaRad;

    try {
      origWrite("look", {
        yaw: nudgedYaw,
        pitch: currentPitch,
        onGround: true,
      });
      console.log(
        `[DonutSmpProfile] 👀 [${entry.minecraftUser}] Anti-AFK nudge ` +
        `${direction > 0 ? "+" : ""}${(direction * deltaDeg).toFixed(1)}° yaw`
      );
    } catch (err) {
      console.warn(`[DonutSmpProfile] ⚠️ Anti-AFK write failed:`, err.message);
      // Don't reschedule if the socket is already dead
      return;
    }

    // Nudge back to original yaw after a short delay so it looks like a glance
    setTimeout(() => {
      if (entry.status !== "online") return;
      if (!bot || bot._client?.ended) return;
      try {
        origWrite("look", {
          yaw: currentYaw,
          pitch: currentPitch,
          onGround: true,
        });
      } catch {
        // Socket closed between nudge and return — not critical
      }

      // Schedule next nudge only after the full nudge+return cycle completes
      this._scheduleAntiAfk(botId, entry, bot, origWrite);
    }, ANTI_AFK_RETURN_DELAY_MS);
  }

  /**
   * Cancel any pending anti-AFK timer for this bot.
   */
  _cancelAntiAfk(botId) {
    const timerId = this._antiAfkTimers.get(botId);
    if (timerId != null) {
      clearTimeout(timerId);
      this._antiAfkTimers.delete(botId);
    }
  }

  // ── Static helpers ───────────────────────────────────────────────────────────

  static isSocketResetError(errCode) {
    return errCode === "EPIPE" || errCode === "ECONNRESET";
  }

  /** @deprecated Use isSocketResetError instead */
  static isEpipe(errCode) { return errCode === "EPIPE"; }

  static isWithinVerificationWindow(connectedSince) {
    if (connectedSince === null) return true;
    return (Date.now() - connectedSince) / 1000 < VERIFICATION_WINDOW_SECONDS;
  }

  static isVerificationDisconnect(reason, connectedSince) {
    if (!reason) return false;
    const r = (typeof reason === "string" ? reason : JSON.stringify(reason)).toLowerCase();
    if (!r.includes("socketclosed")) return false;
    return DonutSmpProfile.isWithinVerificationWindow(connectedSince);
  }

  static isVerificationKick(reasonText) {
    if (!reasonText) return false;
    const r = reasonText.toLowerCase();
    return (
      r.includes("socketclosed") ||
      r.includes("verification") ||
      r.includes("please verify") ||
      r.includes("security check")
    );
  }

  static scheduleVerificationRetry(entry, spawnBot, phase) {
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
    setTimeout(() => spawnBot(DONUTSMP_VERSION), VERIFICATION_RECONNECT_DELAY_MS);
  }
}

module.exports = { DonutSmpProfile, DONUTSMP_VERSION };