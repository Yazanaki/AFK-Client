"use strict";

const { BaseProfile } = require("./BaseProfile");

const DONUTSMP_VERSION = "1.21.11";
const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

// ── Keep-alive constants ────────────────────────────────────────────────────────
//
// DonutSMP runs a security screen BEFORE the login event fires. During this
// window mineflayer's internal keep-alive responder may not yet be active,
// so the server receives no echo and kicks with "client timed out".
//
// We attach a raw packet listener on the underlying _client as soon as the
// bot is created (i.e. before login) and echo every keep_alive packet back
// ourselves. This runs in parallel with mineflayer's own handler — sending
// two echoes is harmless; missing even one causes a kick.
//
// KEEP_ALIVE_DEBUG: set env DONUTSMP_DEBUG=forensic to log every echo.
// ──────────────────────────────────────────────────────────────────────────────
const KEEP_ALIVE_DEBUG = String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    const origWrite = bot._client.write.bind(bot._client);
    const BLOCKED = new Set(["position", "flying", "look"]);

    // ── Movement suppression ────────────────────────────────────────────────
    // Suppress position/look packets that DonutSMP's anti-cheat flags, while
    // passing everything else through untouched (including keep_alive echoes).
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

    // ── Explicit keep-alive echo ────────────────────────────────────────────
    //
    // Attached to the raw _client so it fires even before the `login` event
    // (i.e. during DonutSMP's pre-login security screen). We use origWrite
    // directly — bypassing the movement-block patch — so the echo is always
    // sent regardless of what the patch might do in future.
    //
    // Why origWrite and not bot._client.write?
    //   The patched write above is a passthrough for non-blocked packets, so
    //   either would work today. Using origWrite is a defensive choice: it
    //   guarantees the echo is never accidentally suppressed if the blocked-
    //   set is ever widened.
    bot._client.on("keep_alive", (packet) => {
      try {
        origWrite("keep_alive", { keepAliveId: packet.keepAliveId });
        if (KEEP_ALIVE_DEBUG) {
          console.log(`[DonutSmpProfile] 💓 keep_alive echo — id=${packet.keepAliveId}`);
        }
      } catch (err) {
        // Session closing — suppress the error; the bot is going away anyway.
        if (KEEP_ALIVE_DEBUG) {
          console.warn(`[DonutSmpProfile] ⚠️ keep_alive echo failed:`, err.message);
        }
      }
    });

    // ── Ping / pong ─────────────────────────────────────────────────────────
    bot._client.on("ping", (packet) => {
      try {
        origWrite("pong", { id: packet.id });
        console.log(`[donut-pkt] 🏓 ping id=${packet.id} → pong sent`);
      } catch (err) {
        console.warn(`[DonutSmpProfile] ⚠️ Could not send pong:`, err.message);
      }
    });

    // ── Packet logger (forensic mode only) ─────────────────────────────────
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

    console.log(`[DonutSmpProfile] ✅ Handlers attached — movement block + keep-alive echo + ping/pong active`);
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
    if (DonutSmpProfile.isEpipe(err.code)) {
      DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, "epipe");
      return true;
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

  onCleanup(botId) {}

  // ── Static helpers ──────────────────────────────────────────────────────────

  static isEpipe(errCode) { return errCode === "EPIPE"; }

  static isVerificationDisconnect(reason, connectedSince) {
    if (!reason) return false;
    const r = (typeof reason === "string" ? reason : JSON.stringify(reason)).toLowerCase();
    if (!r.includes("socketclosed")) return false;
    if (connectedSince === null) return true;
    return Math.floor((Date.now() - connectedSince) / 1000) < 30;
  }

  static isVerificationKick(reasonText) {
    if (!reasonText) return false;
    const r = reasonText.toLowerCase();
    return (
      r.includes("socketclosed") ||
      r.includes("verification") ||
      r.includes("please verify") ||
      r.includes("security check") ||
      r.includes("timed out")          // treat timeout kicks as verification retries
    );
  }

  static scheduleVerificationRetry(entry, spawnBot, phase) {
    entry.donutSmpVerificationRetries = (entry.donutSmpVerificationRetries || 0) + 1;
    if (entry.donutSmpVerificationRetries > MAX_VERIFICATION_RETRIES) {
      console.error(`[DonutSmpProfile] ❌ [${entry.minecraftUser}] Verification retry limit reached — giving up`);
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