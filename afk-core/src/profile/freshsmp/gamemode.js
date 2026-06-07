// afk-core/src/profile/freshsmp/gamemode.js
"use strict";

// FreshSMP gamemode / queue flow. After login the bot waits for a gamemode
// selection (selectGamemode, called by botmanager via profiles.freshsmp), then
// sends /queue <gamemode>. Pending selections are keyed by botId.

const QUEUE_COMMAND_DELAY_MS = 2000;
const GAMEMODE_SELECTION_TIMEOUT_MS = 5 * 60 * 1000;

const FRESHSMP_GAMEMODES = {
  survival:  "survival",
  lifesteal: "lifesteal",
  skywars:   "skywars",
};

const _pending = new Map();

function _waitForGamemode(botId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _pending.delete(botId);
      reject(new Error("gamemode_selection_timeout"));
    }, GAMEMODE_SELECTION_TIMEOUT_MS);
    _pending.set(botId, { resolve, timer });
  });
}

async function runGamemodeFlow(botId, entry, bot, onFreshSmpSpawned) {
  if (typeof onFreshSmpSpawned === "function") {
    try { onFreshSmpSpawned(botId); } catch (err) { console.warn(`[FreshSmpProfile] ⚠️ onFreshSmpSpawned threw:`, err.message); }
  }

  let chosenGamemode;
  try {
    console.log(`[FreshSmpProfile] 🟢 [${entry.minecraftUser}] Waiting for gamemode selection...`);
    chosenGamemode = await _waitForGamemode(botId);
  } catch {
    console.warn(`[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] Gamemode selection timed out — bot stays connected but /queue not sent`);
    return;
  }

  if (!entry.bot || entry.bot !== bot || entry.status !== "online") return;
  await new Promise((r) => setTimeout(r, QUEUE_COMMAND_DELAY_MS));
  if (!entry.bot || entry.bot !== bot || entry.status !== "online") return;

  try {
    bot.chat(`/queue ${chosenGamemode}`);
    entry.freshSmpGamemode = chosenGamemode;
    entry.freshSmpQueueSent = true;
    console.log(`[FreshSmpProfile] 🟢 [${entry.minecraftUser}] Sent /queue ${chosenGamemode}`);
  } catch (err) {
    console.error(`[FreshSmpProfile] ❌ Failed to send /queue ${chosenGamemode}:`, err.message);
  }
}

function selectGamemode(botId, gamemode) {
  const key = String(gamemode || "").toLowerCase();
  const queueArg = FRESHSMP_GAMEMODES[key];
  if (!queueArg) return { success: false, reason: "unknown_gamemode" };
  const pending = _pending.get(botId);
  if (pending) {
    clearTimeout(pending.timer);
    _pending.delete(botId);
    pending.resolve(queueArg);
    console.log(`[FreshSmpProfile] 🎮 Gamemode "${queueArg}" selected for ${botId}`);
    return { success: true, gamemode: queueArg };
  }
  return { success: false, reason: "no_pending_selection" };
}

function sendQueueCommand(activeBots, botId, gamemode) {
  const key = String(gamemode || "").toLowerCase();
  const queueArg = FRESHSMP_GAMEMODES[key];
  if (!queueArg) return { success: false, reason: "unknown_gamemode" };
  const entry = activeBots.get(botId);
  if (!entry) return { success: false, reason: "bot_not_found" };
  if (!entry.bot) return { success: false, reason: "bot_instance_missing" };
  if (entry.status !== "online") return { success: false, reason: "bot_not_online" };
  try {
    entry.bot.chat(`/queue ${queueArg}`);
    entry.freshSmpGamemode = queueArg;
    entry.freshSmpQueueSent = true;
    console.log(`[FreshSmpProfile] 🎮 Sent /queue ${queueArg} for ${entry.minecraftUser}`);
    return { success: true, gamemode: queueArg };
  } catch (err) {
    return { success: false, reason: "chat_failed", error: err.message };
  }
}

function cancelPendingGamemode(botId) {
  const pending = _pending.get(botId);
  if (pending) { clearTimeout(pending.timer); _pending.delete(botId); }
}

module.exports = {
  FRESHSMP_GAMEMODES,
  runGamemodeFlow,
  selectGamemode,
  sendQueueCommand,
  cancelPendingGamemode,
};
