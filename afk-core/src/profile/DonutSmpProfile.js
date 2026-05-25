"use strict";

const { BaseProfile } = require("./BaseProfile");

const DONUTSMP_VERSION = "1.21.11";
const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

const KEEP_ALIVE_DEBUG =
  String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase() === "forensic";

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
  }

  /**
   * Called by botmanager before createBot() to allow profile-specific
   * client options. We disable minecraft-protocol's built-in keepAlive
   * checker entirely so it can't fire the "timed out after 10000ms" error.
   * We handle keep-alive ourselves in onBotCreated instead.
   */
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
    //
    // minecraft-protocol's built-in keepAlive handler is disabled via
    // keepAlive:false in buildClientOptions(). We take full ownership here.
    //
    // This listener fires on the raw _client — before AND after login —
    // so DonutSMP's pre-login security screen keep-alives are covered.
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

    console.log(
      `[DonutSmpProfile] ✅ Handlers attached — movement block + manual keep-alive + ping/pong active`
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
    // EPIPE and ECONNRESET both indicate the server forcibly closed the TCP
    // socket — this is normal during DonutSMP's pre-login security screen.
    // Treat both as verification reconnect events rather than fatal errors.
    if (DonutSmpProfile.isSocketResetError(err.code)) {
      DonutSmpProfile.scheduleVerificationRetry(entry, spawnBot, `${err.code || "socket_reset"}`);
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

  // ── Static helpers ───────────────────────────────────────────────────────────

  /**
   * Returns true for error codes that indicate the server forcibly reset the
   * TCP connection — expected during DonutSMP's pre-login security screen.
   *
   * EPIPE     — write on a half-closed socket (server closed its read end)
   * ECONNRESET — server sent TCP RST mid-stream ("write ECONNRESET")
   */
  static isSocketResetError(errCode) {
    return errCode === "EPIPE" || errCode === "ECONNRESET";
  }

  /** @deprecated Use isSocketResetError instead */
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