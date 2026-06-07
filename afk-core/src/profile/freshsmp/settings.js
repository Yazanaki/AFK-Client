// afk-core/src/profile/freshsmp/settings.js
"use strict";

// FreshSMP outgoing-write interceptor + client-settings builder.
//
//   1. Ensure every "settings"/"client_information" packet carries the full
//      1.21.3+ field set (mineflayer's auto-send omits particleStatus /
//      enableServerListing → Canvas/Paper SERVER ERROR kick).
//   2. Drop movement packets while in CONFIGURATION state (Velocity transfers) —
//      movement is a PLAY-state packet and is invalid mid-configuration.
//   3. Record every outgoing packet into entry._recentOut (ring buffer dumped by
//      lifecycle.js on transfer/kick) and log non-routine packets in real time.

const FRESHSMP_DEBUG =
  String(process.env.FRESHSMP_DEBUG || "minimal").toLowerCase() === "forensic";

// Routine outgoing packets an AFK bot sends constantly — excluded from the
// real-time non-routine logger so the "Invalid sequence" culprit stands out.
const ROUTINE_OUTGOING = new Set([
  "pong", "keep_alive", "position", "position_look", "look", "flying",
  "settings", "client_information", "teleport_confirm", "chat_command",
  "chat_message", "chat", "arm_animation", "pong_play",
  "configuration_acknowledged", "finish_configuration", "select_known_packs",
  "chunk_batch_received", "chat_session_update", "custom_payload",
]);

/**
 * Build and write the client settings packet for the CURRENT connection state.
 *   PLAY state          → "settings"
 *   CONFIGURATION state → "client_information"
 * Both require the same full field set in 1.21.3+.
 */
function sendClientSettings(client) {
  const payload = {
    locale:               "en_US",
    viewDistance:         8,
    chatFlags:            0,
    chatColors:           true,
    skinParts:            127,
    mainHand:             1,
    enableTextFiltering:  false,
    enableServerListing:  true,
    particleStatus:       0,
  };
  const name = client.state === "configuration" ? "client_information" : "settings";
  client.write(name, payload);
}

// Installs the write interceptor and returns the original (bound) write so other
// handlers (keep-alive, per-tick movement) can bypass it.
function installSettingsInterceptor(bot, entry) {
  const _origWrite = bot._client.write.bind(bot._client);

  bot._client.write = function freshSmpSettingsPatch(name, params) {
    // Drop movement packets during CONFIGURATION state (Velocity transfer).
    if (
      bot._client.state === "configuration" &&
      (name === "position" || name === "position_look" || name === "look" || name === "flying")
    ) {
      if (FRESHSMP_DEBUG) {
        console.log(`[fresh-pkt] → DROPPED ${name} (movement during configuration state)`);
      }
      return;
    }

    // Ensure the full client-settings field set in both PLAY and CONFIG states.
    if (name === "settings" || name === "client_information") {
      params = {
        locale:               (params && params.locale              != null) ? params.locale              : "en_US",
        viewDistance:         (params && params.viewDistance        != null) ? params.viewDistance        : 8,
        chatFlags:            (params && params.chatFlags           != null) ? params.chatFlags           : 0,
        chatColors:           (params && params.chatColors          != null) ? params.chatColors          : true,
        skinParts:            (params && params.skinParts           != null) ? params.skinParts           : 127,
        mainHand:             (params && params.mainHand            != null) ? params.mainHand            : 1,
        enableTextFiltering:  (params && params.enableTextFiltering != null) ? params.enableTextFiltering : false,
        enableServerListing:  (params && params.enableServerListing != null) ? params.enableServerListing : true,
        particleStatus:       0, // hard-force; required in 1.21.3+ schemas
      };
      console.log(`[FreshSmpProfile] ⚙️ [${entry.minecraftUser}] ${name} intercepted → fields ensured`);
    }

    if (FRESHSMP_DEBUG) {
      const st = bot._client.state;
      try {
        console.log(`[fresh-pkt] → CLIENT sent [${st}]: ${name}`, JSON.stringify(params).slice(0, 160));
      } catch {
        console.log(`[fresh-pkt] → CLIENT sent [${st}]: ${name} (non-serializable)`);
      }
    }

    // Outgoing packet recorder (ring buffer dumped by lifecycle.js on kick).
    {
      let brief = "";
      try { brief = JSON.stringify(params).slice(0, 120); } catch { brief = "(non-serializable)"; }
      const rec = entry._recentOut;
      if (rec) {
        rec.push({ t: new Date().toISOString().slice(11, 23), name, brief });
        if (rec.length > 25) rec.shift();
      }
      if (!ROUTINE_OUTGOING.has(name)) {
        console.log(`[fresh-life] ${new Date().toISOString()} [${entry.minecraftUser}] → SENT ${name} ${brief}`);
      }
    }

    return _origWrite(name, params);
  };

  return _origWrite;
}

module.exports = { sendClientSettings, installSettingsInterceptor, FRESHSMP_DEBUG, ROUTINE_OUTGOING };
