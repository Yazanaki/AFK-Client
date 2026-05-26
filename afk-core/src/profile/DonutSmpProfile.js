// afk-core/src/profile/DonutSmpProfile.js
"use strict";

const { BaseProfile } = require("./BaseProfile");

const DONUTSMP_VERSION = "1.21.11";
const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

const VERIFICATION_WINDOW_SECONDS = 60;
const MID_SESSION_RECONNECT_DELAY_MS = 8000;

// Anti-AFK head rotation timings
const ANTI_AFK_MIN_MS = 3 * 60 * 1000;
const ANTI_AFK_MAX_MS = 6 * 60 * 1000;
const ANTI_AFK_YAW_DELTA_MIN = 2;
const ANTI_AFK_YAW_DELTA_MAX = 8;
const ANTI_AFK_RETURN_DELAY_MS = 1500;

// TCP keepalive — OS-level probes sent on idle connections.
// This detects when DonutSMP silently drops the TCP connection so we get a
// clean ECONNRESET before the next write, instead of an EPIPE mid-write.
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 60 * 1000;

const KEEP_ALIVE_DEBUG =
  String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
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

    // Block position and flying packets only.
    // We intentionally do NOT block "look" here — mineflayer's bot.look()
    // API handles the correct packet format for 1.21.11 (which changed from
    // the old {yaw, pitch, onGround} layout). Sending raw "look" packets via
    // origWrite causes a "SizeOf error for undefined" serialization crash on
    // 1.21.2+ because the schema now requires a movementFlags field.
    const BLOCKED = new Set(["position", "flying"]);

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

    // ── TCP keepalive — OS-level ─────────────────────────────────────────────
    // Enables SO_KEEPALIVE on the underlying TCP socket. The OS will send
    // tiny probe packets after TCP_KEEPALIVE_INITIAL_DELAY_MS of idle time.
    // If the server doesn't respond, the socket gets ECONNRESET cleanly
    // instead of us discovering the dead connection mid-write via EPIPE.
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

    // ── Manual Minecraft keep-alive echo ─────────────────────────────────────
    // We use origWrite (pre-movement-patch) to guarantee the echo is sent.
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

    // ── Anti-AFK — start scheduling after login ──────────────────────────────
    // Wait for login so we have a valid entity yaw/pitch to work from, and so
    // we don't send look packets during the pre-login security screen.
    bot.once("login", () => {
      this._scheduleAntiAfk(botId, entry, bot);
    });

    console.log(
      `[DonutSmpProfile] ✅ Handlers attached — movement block + manual keep-alive + ping/pong + anti-AFK + TCP keepalive active`
    );
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {}
  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    if (DonutSmpProfile.isVerificationKick(reasonText)) {
      console.log(
        `[DonutSmpProfile] 🔐 [${entry.minecraftUser}] Verification kick detected — scheduling reconnect`
      );
      DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, "kick");
      return true;
    }
    return false;
  }

  onError(bot, entry, botId, err, spawnBot) {
    if (!DonutSmpProfile.isSocketResetError(err.code)) return false;

    if (DonutSmpProfile.isWithinVerificationWindow(entry.connectedSince)) {
      // Pre-login or very early session — treat as verification reconnect.
      DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, `${err.code}`);
      return true;
    }

    // Mid-session drop — reconnect silently without incrementing the
    // verification retry counter and without letting botmanager record
    // this as an ended bot (which would DM the user).
    const uptimeSec = entry.connectedSince
      ? Math.floor((Date.now() - entry.connectedSince) / 1000)
      : null;
    console.log(
      `[DonutSmpProfile] 🔄 [${entry.minecraftUser}] Mid-session ${err.code} after ` +
      `${uptimeSec !== null ? uptimeSec + "s online" : "pre-login"} — reconnecting silently in ${MID_SESSION_RECONNECT_DELAY_MS}ms`
    );
    entry.status = "reconnecting";
    setTimeout(() => spawnBot(DONUTSMP_VERSION), MID_SESSION_RECONNECT_DELAY_MS);
    return true;
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

  _scheduleAntiAfk(botId, entry, bot) {
    this._cancelAntiAfk(botId);

    const delayMs =
      ANTI_AFK_MIN_MS +
      Math.floor(Math.random() * (ANTI_AFK_MAX_MS - ANTI_AFK_MIN_MS));

    const timerId = setTimeout(() => {
      this._antiAfkTimers.delete(botId);
      this._doAntiAfkNudge(botId, entry, bot);
    }, delayMs);

    this._antiAfkTimers.set(botId, timerId);
  }

  _doAntiAfkNudge(botId, entry, bot) {
    if (entry.status !== "online") return;
    if (!bot || bot._client?.ended) return;

    const currentYaw = (bot.entity && typeof bot.entity.yaw === "number")
      ? bot.entity.yaw : 0;
    const currentPitch = (bot.entity && typeof bot.entity.pitch === "number")
      ? bot.entity.pitch : 0;

    const deltaDeg =
      ANTI_AFK_YAW_DELTA_MIN +
      Math.random() * (ANTI_AFK_YAW_DELTA_MAX - ANTI_AFK_YAW_DELTA_MIN);
    const deltaRad = (deltaDeg * Math.PI) / 180;
    const direction = Math.random() < 0.5 ? 1 : -1;
    const nudgedYaw = currentYaw + direction * deltaRad;

    bot.look(nudgedYaw, currentPitch, true);
    console.log(
      `[DonutSmpProfile] 👀 [${entry.minecraftUser}] Anti-AFK nudge ` +
      `${direction > 0 ? "+" : ""}${(direction * deltaDeg).toFixed(1)}° yaw`
    );

    setTimeout(() => {
      if (entry.status !== "online") return;
      if (!bot || bot._client?.ended) return;
      bot.look(currentYaw, currentPitch, true);
      this._scheduleAntiAfk(botId, entry, bot);
    }, ANTI_AFK_RETURN_DELAY_MS);
  }

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
      // socketclosed / pre-login disconnects
      r.includes("socketclosed") ||
      // generic verification language
      r.includes("verification") ||
      r.includes("please verify") ||
      r.includes("security check") ||
      // DonutSMP's actual kick message (observed in logs)
      r.includes("unauthorized login") ||
      r.includes("blocked it") ||
      r.includes("confirm it via") ||
      r.includes("discord dms") ||
      r.includes("direct messages enabled") ||
      r.includes("donutsmp")
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