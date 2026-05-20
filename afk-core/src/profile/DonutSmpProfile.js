"use strict";

const { BaseProfile } = require("./BaseProfile");

const DONUTSMP_VERSION = "1.21.11";
const MAX_VERIFICATION_RETRIES = 10;
const VERIFICATION_RECONNECT_DELAY_MS = 5000;

class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", DONUTSMP_VERSION);
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    const origWrite = bot._client.write.bind(bot._client);
    const BLOCKED = new Set(["position", "flying", "look"]);

    bot._client.write = function donutSmpMovementBlock(name, params) {
      if (BLOCKED.has(name)) {
        try { console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`, JSON.stringify(params).slice(0, 120)); } catch { console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`); }
        return;
      }
      try { console.log(`[donut-pkt] → CLIENT sent: ${name}`, JSON.stringify(params).slice(0, 120)); } catch { console.log(`[donut-pkt] → CLIENT sent: ${name} (non-serializable)`); }
      return origWrite(name, params);
    };

    entry._donutOrigWrite = origWrite;

    bot._client.on("ping", (packet) => {
      try {
        origWrite("pong", { id: packet.id });
        console.log(`[donut-pkt] 🏓 ping id=${packet.id} → pong sent`);
      } catch (err) {
        console.warn(`[DonutSmpProfile] ⚠️ Could not send pong:`, err.message);
      }
    });

    bot._client.on("packet", (data, meta) => {
      try { console.log(`[donut-pkt] ← SERVER: ${meta.name}`, JSON.stringify(data).slice(0, 120)); }
      catch { console.log(`[donut-pkt] ← SERVER: ${meta.name} (binary)`); }
    });

    bot._client.on("plugin_message", (packet) => {
      const channel = packet?.channel || "unknown";
      const dataLen = packet?.data?.length ?? 0;
      console.log(`[DonutSmpProfile] plugin_message channel=${channel} bytes=${dataLen}`);
    });

    console.log(`[DonutSmpProfile] ✅ Handlers attached — movement block + ping/pong active`);
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
    return r.includes("socketclosed") || r.includes("verification") || r.includes("please verify") || r.includes("security check");
  }

  static scheduleVerificationRetry(entry, spawnBot, phase) {
    entry.donutSmpVerificationRetries = (entry.donutSmpVerificationRetries || 0) + 1;
    if (entry.donutSmpVerificationRetries > MAX_VERIFICATION_RETRIES) {
      console.error(`[DonutSmpProfile] ❌ [${entry.minecraftUser}] Verification retry limit reached — giving up`);
      entry.status = "error";
      entry.errorCategory = "donutsmp_verification";
      entry.spawnError = "DonutSMP security check failed after maximum retries. Please verify your account via the DonutSMP Discord bot, then try /mcbot start again.";
      return;
    }
    console.log(`[DonutSmpProfile] 🟠 [${entry.minecraftUser}] Verification reconnect (${phase}) — attempt ${entry.donutSmpVerificationRetries}/${MAX_VERIFICATION_RETRIES} in ${VERIFICATION_RECONNECT_DELAY_MS}ms`);
    entry.status = "reconnecting";
    setTimeout(() => spawnBot(DONUTSMP_VERSION), VERIFICATION_RECONNECT_DELAY_MS);
  }
}

module.exports = { DonutSmpProfile, DONUTSMP_VERSION };