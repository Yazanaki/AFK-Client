// afk-core/src/profile/freshsmp/transfer.js
"use strict";

// FreshSMP server-transfer handling. When /queue triggers a Velocity transfer,
// the connection goes config → play on the new backend. We must re-send client
// settings once back in PLAY (NOT during configuration — Pipeline, FreshSMP's
// server software, kicks with SERVER ERROR if it gets client_information mid-
// config on a transfer). _playEntryCount > 1 means a transfer completed (the
// first PLAY entry is the initial login, handled by onLogin).

const { sendClientSettings } = require("./settings");

function installTransferHandler(bot, entry) {
  let _playEntryCount = 0;
  bot._client.on("state", (newState) => {
    if (newState !== "play") return;
    _playEntryCount++;
    if (_playEntryCount === 1) return; // initial login — handled by onLogin
    // Small delay so the server finishes its own play-state join sequence first.
    setTimeout(() => {
      if (!bot || bot._client?.ended || bot._client.state !== "play") return;
      try {
        sendClientSettings(bot._client); // picks "settings" in play state
        console.log(
          `[FreshSmpProfile] ✅ [${entry.minecraftUser}] settings re-sent in play after transfer #${_playEntryCount - 1}`
        );
      } catch (err) {
        console.warn(
          `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] Could not re-send settings after transfer:`,
          err.message
        );
      }
    }, 1000);
  });
}

module.exports = { installTransferHandler };
