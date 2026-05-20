"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * DonutSmpProfile
 *
 * ALL DonutSMP-specific logic lives here:
 *   - Version: always 1.21.11, no auto-detection
 *   - Movement block: permanently suppresses position/flying/look packets
 *   - Ping/pong: echoes ping packets back as pong via raw write bypass
 *   - Packet logger: logs all inbound/outbound packets for debugging
 *   - Verification retry: handles EPIPE and socketClosed disconnects from
 *     DonutSMP's security check, retrying up to MAX_VERIFICATION_RETRIES times
 *   - Hunger management via HungerHandler
 */

const DONUTSMP_VERSION = "1.21.11";
const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", [DONUTSMP_VERSION]);
    this._hungerHandler = null;
  }

  // ── Version ────────────────────────────────────────────────────────────────

  /**
   * Always returns the fixed DonutSMP version regardless of what was requested.
   */
  getVersion() {
    return DONUTSMP_VERSION;
  }

  // ── buildClientOptions ─────────────────────────────────────────────────────

  buildClientOptions(baseOptions, session) {
    if (session) session.version = DONUTSMP_VERSION;
    return {
      ...baseOptions,
      version: DONUTSMP_VERSION,
      brand: "vanilla",
      hideErrors: false,
      skipValidation: false,
    };
  }

  // ── attachHandlers ─────────────────────────────────────────────────────────

  attachHandlers(client, session) {
    const version = DONUTSMP_VERSION;
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    // ── Movement block ───────────────────────────────────────────────────────
    // Permanently suppress position/flying/look — an AFK bot never needs these.
    // Uses origWrite bypass so ping/pong can still go through.
    const origWrite = client.write.bind(client);
    const BLOCKED = new Set(["position", "flying", "look"]);

    client.write = function donutSmpMovementBlock(name, params) {
      if (BLOCKED.has(name)) {
        try {
          console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`, JSON.stringify(params).slice(0, 120));
        } catch {
          console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`);
        }
        return;
      }
      try {
        console.log(`[donut-pkt] → CLIENT sent: ${name}`, JSON.stringify(params).slice(0, 120));
      } catch {
        console.log(`[donut-pkt] → CLIENT sent: ${name} (non-serializable)`);
      }
      return origWrite(name, params);
    };

    // ── Ping/pong ────────────────────────────────────────────────────────────
    // DonutSMP sends ping as a secondary liveness check. mineflayer/minecraft-
    // protocol does NOT auto-respond. Echo it back via origWrite (bypasses block).
    client.on("ping", (packet) => {
      try {
        origWrite("pong", { id: packet.id });
        console.log(`[donut-pkt] 🏓 ping id=${packet.id} → pong sent`);
      } catch (err) {
        console.warn(`[DonutSmpProfile] ⚠️ Could not send pong:`, err.message);
      }
    });

    // ── Inbound packet logger ────────────────────────────────────────────────
    client.on("packet", (data, meta) => {
      try {
        console.log(`[donut-pkt] ← SERVER: ${meta.name}`, JSON.stringify(data).slice(0, 120));
      } catch {
        console.log(`[donut-pkt] ← SERVER: ${meta.name} (binary)`);
      }
    });

    // ── Plugin message logger ────────────────────────────────────────────────
    client.on("plugin_message", (packet) => {
      const channel = packet?.channel || "unknown";
      const dataLen = packet?.data?.length ?? 0;
      console.log(`[DonutSmpProfile] plugin_message channel=${channel} bytes=${dataLen}`);
    });

    // ── Login: record version in cache ───────────────────────────────────────
    client.on("login", () => {
      if (session) session.version = DONUTSMP_VERSION;
    });

    console.log(`[DonutSmpProfile] ✅ Handlers attached — movement block + ping/pong active`);
  }

  // ── tick ───────────────────────────────────────────────────────────────────

  tick(session, client, nowMs) {
    if (session.state !== "online") return;
    if (this._hungerHandler) this._hungerHandler.tick(client);
  }

  // ── Verification retry logic ───────────────────────────────────────────────

  /**
   * Returns true if an error code looks like DonutSMP's security check
   * closing the socket during the handshake.
   */
  static isEpipe(errCode) {
    return errCode === "EPIPE";
  }

  /**
   * Returns true if an end-reason looks like the DonutSMP verification disconnect.
   * Covers pre-login (connectedSince === null) and post-login (< 30s online).
   */
  static isVerificationDisconnect(reason, connectedSince) {
    if (!reason) return false;
    const r = (typeof reason === "string" ? reason : JSON.stringify(reason)).toLowerCase();
    if (!r.includes("socketclosed")) return false;
    if (connectedSince === null) return true;
    return Math.floor((Date.now() - connectedSince) / 1000) < 30;
  }

  /**
   * Returns true if a kick reason text looks like a DonutSMP verification kick.
   */
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

  /**
   * Schedule a verification reconnect attempt, or give up if limit reached.
   * Mutates entry directly. Calls spawnBot(version) after the delay.
   */
  static scheduleVerificationRetry(entry, spawnBot, phase) {
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
    setTimeout(() => spawnBot(DONUTSMP_VERSION), VERIFICATION_RECONNECT_DELAY_MS);
  }
}

module.exports = { DonutSmpProfile, DONUTSMP_VERSION };