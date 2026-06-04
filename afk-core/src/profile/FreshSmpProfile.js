// afk-core/src/profile/FreshSmpProfile.js
"use strict";

const { BaseProfile } = require("./BaseProfile");

const FRESHSMP_VERSION = "1.21.11";
const QUEUE_COMMAND_DELAY_MS = 2000;
const GAMEMODE_SELECTION_TIMEOUT_MS = 5 * 60 * 1000;

// Anti-AFK head rotation timings — same conservative approach as DonutSmpProfile.
// bot.look() is used (not raw look packets) to correctly handle the movementFlags
// field required by 1.21.2+ protocol without risking a serialization crash.
const ANTI_AFK_MIN_MS          = 3 * 60 * 1000;
const ANTI_AFK_MAX_MS          = 6 * 60 * 1000;
const ANTI_AFK_YAW_DELTA_MIN   = 2;
const ANTI_AFK_YAW_DELTA_MAX   = 8;
const ANTI_AFK_RETURN_DELAY_MS = 1500;

const FRESHSMP_GAMEMODES = {
  survival:  "survival",
  lifesteal: "lifesteal",
  skywars:   "skywars",
};

class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", FRESHSMP_VERSION);
    this._pendingGamemode = new Map();
    this._antiAfkTimers   = new Map();
  }

  // ── Disable minecraft-protocol's built-in keep-alive handler ─────────────────
  // minecraft-protocol's internal keepalive.js sends its own keep_alive echo and
  // runs a 30-second timeout. We handle keep_alive manually in onBotCreated, so
  // we must set keepAlive: false to prevent the two handlers from conflicting —
  // otherwise the internal timeout fires and kicks the bot with
  // "client timed out after 30000 milliseconds".
  buildClientOptions(base) {
    return {
      ...base,
      keepAlive: false,
    };
  }

  onBotCreated(bot, entry, botId, spawnBot) {
    // ── Manual Minecraft keep-alive echo ─────────────────────────────────────
    // Required because keepAlive: false disables minecraft-protocol's built-in
    // handler. The server expects the client to echo keep_alive packets within
    // ~30 seconds or it disconnects with "Timed out".
    bot._client.on("keep_alive", (packet) => {
      try {
        bot._client.write("keep_alive", { keepAliveId: packet.keepAliveId });
      } catch (_) {
        // Session is closing — ignore.
      }
    });

    bot._client.on("ping", (packet) => {
      try { bot._client.write("pong", { id: packet.id }); } catch (_) {}
    });

    // Schedule anti-AFK after login so bot.entity is populated with a valid
    // yaw/pitch. The timer fires 3-6 minutes later and self-reschedules,
    // keeping the bot alive through both lobby waiting and post-queue time.
    bot.once("login", () => {
      this._scheduleAntiAfk(botId, entry, bot);
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    // Send client settings explicitly in play state.
    //
    // FreshSMP (Paper 1.21.11) expects all fields of packet_common_settings.
    // Missing any field causes the serializer to throw silently, meaning no
    // settings packet is sent at all — which triggers the SERVER ERROR kick.
    //
    // Required fields for 1.21.11 (verified against minecraft-data protocol.json):
    //   locale, viewDistance, chatFlags, chatColors, skinParts, mainHand,
    //   enableTextFiltering, enableServerListing, particleStatus
    //
    // particleStatus mappings: 0=all, 1=decreased, 2=minimal
    setTimeout(() => {
      if (!bot || bot._client?.ended) return;
      try {
        bot._client.write("settings", {
          locale:               "en_US",
          viewDistance:         8,
          chatFlags:            0,
          chatColors:           true,
          skinParts:            127,
          mainHand:             1,
          enableTextFiltering:  false,
          enableServerListing:  true,
          particleStatus:       0,
        });
        console.log(`[FreshSmpProfile] ✅ [${entry.minecraftUser}] Client settings sent`);
      } catch (err) {
        console.warn(
          `[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] Could not send client settings:`,
          err.message
        );
      }
    }, 1000);

    const { onFreshSmpSpawned } = callbacks || {};
    this.runGamemodeFlow(botId, entry, bot, onFreshSmpSpawned).catch((err) => {
      console.warn(`[FreshSmpProfile] ⚠️ runGamemodeFlow error for ${entry.minecraftUser}:`, err.message);
    });
  }

  onSpawn(bot, entry, botId) {}

  onKick(bot, entry, botId, reasonText, spawnBot, autoMode, candidates, autoVersionState) {
    const lower = (reasonText || "").toLowerCase();

    // Log FreshSMP's "SERVER ERROR" kick specifically so it is easy to spot
    // in PM2 logs. The error category is set so botmonitor can surface it.
    // Return false — botmanager handles cleanup/reconnect via AUTO_RECONNECT.
    if (lower.includes("server error") || lower.includes("internal error")) {
      console.warn(
        `[FreshSmpProfile] ⚠️ [${entry?.minecraftUser}] SERVER ERROR kick — ` +
        `FreshSMP rejected the connection (malformed or missing packet). ` +
        `Check PM2 logs for serialization errors above this line.`
      );
      if (entry) entry.errorCategory = "freshsmp_server_error";
    }

    return false;
  }

  onError(bot, entry, botId, err, spawnBot) { return false; }
  onEnd(bot, entry, botId, reason, spawnBot) { return false; }

  onCleanup(botId) {
    this.cancelPendingGamemode(botId);
    this._cancelAntiAfk(botId);
  }

  // ── Anti-AFK ────────────────────────────────────────────────────────────────

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

    const currentYaw   = (bot.entity && typeof bot.entity.yaw   === "number") ? bot.entity.yaw   : 0;
    const currentPitch = (bot.entity && typeof bot.entity.pitch === "number") ? bot.entity.pitch : 0;

    const deltaDeg  = ANTI_AFK_YAW_DELTA_MIN + Math.random() * (ANTI_AFK_YAW_DELTA_MAX - ANTI_AFK_YAW_DELTA_MIN);
    const deltaRad  = (deltaDeg * Math.PI) / 180;
    const direction = Math.random() < 0.5 ? 1 : -1;
    const nudgedYaw = currentYaw + direction * deltaRad;

    try {
      bot.look(nudgedYaw, currentPitch, true);
      console.log(
        `[FreshSmpProfile] 👀 [${entry.minecraftUser}] Anti-AFK nudge ` +
        `${direction > 0 ? "+" : ""}${(direction * deltaDeg).toFixed(1)}° yaw`
      );

      setTimeout(() => {
        if (entry.status !== "online") return;
        if (!bot || bot._client?.ended) return;
        try { bot.look(currentYaw, currentPitch, true); } catch (_) {}
        this._scheduleAntiAfk(botId, entry, bot);
      }, ANTI_AFK_RETURN_DELAY_MS);
    } catch (err) {
      console.warn(`[FreshSmpProfile] ⚠️ [${entry.minecraftUser}] Anti-AFK look failed:`, err.message);
      // Reschedule regardless so the timer loop is never orphaned
      this._scheduleAntiAfk(botId, entry, bot);
    }
  }

  _cancelAntiAfk(botId) {
    const timerId = this._antiAfkTimers.get(botId);
    if (timerId != null) {
      clearTimeout(timerId);
      this._antiAfkTimers.delete(botId);
    }
  }

  // ── Gamemode flow ────────────────────────────────────────────────────────────

  async runGamemodeFlow(botId, entry, bot, onFreshSmpSpawned) {
    if (typeof onFreshSmpSpawned === "function") {
      try { onFreshSmpSpawned(botId); } catch (err) { console.warn(`[FreshSmpProfile] ⚠️ onFreshSmpSpawned threw:`, err.message); }
    }

    let chosenGamemode;
    try {
      console.log(`[FreshSmpProfile] 🟢 [${entry.minecraftUser}] Waiting for gamemode selection...`);
      chosenGamemode = await this._waitForGamemode(botId);
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

  selectGamemode(botId, gamemode) {
    const key = String(gamemode || "").toLowerCase();
    const queueArg = FRESHSMP_GAMEMODES[key];
    if (!queueArg) return { success: false, reason: "unknown_gamemode" };
    const pending = this._pendingGamemode.get(botId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pendingGamemode.delete(botId);
      pending.resolve(queueArg);
      console.log(`[FreshSmpProfile] 🎮 Gamemode "${queueArg}" selected for ${botId}`);
      return { success: true, gamemode: queueArg };
    }
    return { success: false, reason: "no_pending_selection" };
  }

  sendQueueCommand(activeBots, botId, gamemode) {
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

  cancelPendingGamemode(botId) {
    const pending = this._pendingGamemode.get(botId);
    if (pending) { clearTimeout(pending.timer); this._pendingGamemode.delete(botId); }
  }

  _waitForGamemode(botId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingGamemode.delete(botId);
        reject(new Error("gamemode_selection_timeout"));
      }, GAMEMODE_SELECTION_TIMEOUT_MS);
      this._pendingGamemode.set(botId, { resolve, timer });
    });
  }
}

module.exports = { FreshSmpProfile, FRESHSMP_VERSION, FRESHSMP_GAMEMODES };