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

// Forensic packet logging. Set FRESHSMP_DEBUG=forensic to log every outgoing
// and incoming packet (with the current connection state) so we can identify
// exactly which packet triggers a SERVER ERROR kick during a server transfer.
const FRESHSMP_DEBUG =
  String(process.env.FRESHSMP_DEBUG || "minimal").toLowerCase() === "forensic";

const FRESHSMP_GAMEMODES = {
  survival:  "survival",
  lifesteal: "lifesteal",
  skywars:   "skywars",
};

// Routine outgoing packets that an AFK bot sends constantly — excluded from the
// non-routine packet logger so the "Invalid sequence" culprit stands out.
const ROUTINE_OUTGOING = new Set([
  "pong", "keep_alive", "position", "position_look", "look", "flying",
  "settings", "client_information", "teleport_confirm", "chat_command",
  "chat_message", "chat", "arm_animation", "pong_play",
  "configuration_acknowledged", "finish_configuration", "select_known_packs",
  "chunk_batch_received", "chat_session_update", "custom_payload",
]);

/**
 * Build and write the correct client settings packet.
 *
 * Required fields for 1.21.11 (verified against minecraft-data protocol.json):
 *   locale, viewDistance, chatFlags, chatColors, skinParts, mainHand,
 *   enableTextFiltering, enableServerListing, particleStatus
 *
 * NOTE: enableServerListing is required in 1.21.3+ schemas. Omitting it
 * causes the serializer to throw silently — no packet is sent — which
 * triggers SERVER ERROR kicks on Paper-based / Canvas servers.
 *
 * particleStatus mappings: 0=all, 1=decreased, 2=minimal
 * This field is also required in 1.21.3+ schemas and is the field most
 * commonly omitted by mineflayer's internal auto-send.
 *
 * packetName: "settings" in PLAY state, "client_information" in CONFIGURATION
 * state (Velocity server transfers). We MUST pick the name that matches the
 * connection's CURRENT state — sending a configuration-state packet while in
 * play state (or vice versa) produces a malformed packet that Canvas rejects
 * with a generic SERVER ERROR kick. client.state tells us which state we're in.
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
  // Pick the packet name that matches the current connection state.
  const name = client.state === "configuration" ? "client_information" : "settings";
  client.write(name, payload);
}

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

    // ── Settings write interceptor ────────────────────────────────────────────
    // mineflayer automatically sends a client_information ("settings") packet
    // on login. In mineflayer 4.x for 1.21.x, this auto-sent packet may omit
    // `particleStatus`, which is required by the 1.21.3+ protocol schema.
    // Canvas (and Paper) throw an internal exception when this field is missing,
    // producing a SERVER ERROR kick.
    //
    // By intercepting ALL writes at the profile level (before botmanager's
    // use_item patch is applied), we guarantee that every "settings" packet —
    // whether sent by mineflayer internally, by onLogin, or by the transfer
    // listener below — always carries the full set of required fields.
    //
    // Fields are merged with defaults so any value the caller explicitly sets
    // is preserved; only genuinely missing fields are filled in.
    //
    // IMPORTANT: botmanager.js applies its own write proxy (use_item sequence)
    // AFTER onBotCreated returns. The final write chain is therefore:
    //   bot._client.write
    //     → useItemSequencePatch  (botmanager, applied after)
    //     → freshSmpSettingsPatch (this, applied now)
    //     → original write
    // Both patches operate on different packet names and do not interfere.
    const _origWrite = bot._client.write.bind(bot._client);
    bot._client.write = function freshSmpSettingsPatch(name, params) {
      // ── Drop movement packets during CONFIGURATION state ───────────────────
      // When /queue triggers a Velocity server transfer, the server sends
      // start_configuration and the connection re-enters CONFIGURATION state.
      // mineflayer's physics loop keeps ticking and fires movement packets
      // (flying / position / look / position_look) which are PLAY-state packets
      // and are INVALID during configuration. The vanilla client never sends
      // movement while configuring; Canvas treats the unexpected packet as
      // malformed and kicks with a generic SERVER ERROR.
      //
      // Suppressing these only while in configuration state lets the transfer
      // handshake complete cleanly, after which normal play-state movement
      // (which the server expects) resumes untouched.
      if (
        bot._client.state === "configuration" &&
        (name === "position" || name === "position_look" || name === "look" || name === "flying")
      ) {
        if (FRESHSMP_DEBUG) {
          console.log(`[fresh-pkt] → DROPPED ${name} (movement during configuration state)`);
        }
        return;
      }

      // minecraft-protocol names the ClientInformation packet differently depending
      // on the connection state:
      //   PLAY state         → "settings"
      //   CONFIGURATION state → "client_information"
      // Both require the same full field set in 1.21.3+. When Velocity does a
      // server transfer it puts the connection back into CONFIGURATION state, so
      // mineflayer's auto-send uses "client_information" — NOT "settings" — and
      // omits particleStatus/enableServerListing, causing a SERVER ERROR kick.
      // We guard both names here to cover both states.
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

      // ── Outgoing packet recorder ────────────────────────────────────────────
      // Feed EVERY outgoing packet into the ring buffer (dumped on transfer/kick)
      // so the packets just before an "Invalid sequence" are visible, including
      // routine position/flying/teleport_confirm. Also log non-routine packets
      // immediately so they stand out in real time.
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

    // ── Incoming packet logger (forensic mode only) ──────────────────────────
    if (FRESHSMP_DEBUG) {
      bot._client.on("packet", (data, meta) => {
        try {
          console.log(`[fresh-pkt] ← SERVER [${meta.state}]: ${meta.name}`, JSON.stringify(data).slice(0, 160));
        } catch {
          console.log(`[fresh-pkt] ← SERVER [${meta.state}]: ${meta.name} (binary)`);
        }
      });
    }

    // ── Lifecycle logger (ALWAYS ON) ─────────────────────────────────────────
    // Prints one loud, wall-clock-timestamped line per lifecycle event so the
    // in-game behaviour (player leaving/rejoining tab, avatar vanishing) can be
    // correlated with what actually happens on the connection. These events are
    // rare, so this is safe to leave on permanently — it is NOT gated by
    // FRESHSMP_DEBUG. Watch for these lines the moment you see the bot flicker:
    //   CONNECTION STATE → login/configuration/play  = real reconnect/transfer
    //   💀 DEATH / ♻️ RESPAWN                          = killed & respawning in place
    //   🔚 END / DISCONNECT                            = socket actually dropped
    const _life = (msg) =>
      console.log(`[fresh-life] ${new Date().toISOString()} [${entry.minecraftUser}] ${msg}`);

    // Flatten a prismarine-nbt chat component into readable plain text so we can
    // see what the server is actually saying (instead of the raw NBT tree).
    const chatText = (node) => {
      if (node == null) return "";
      if (typeof node === "string") return node;
      if (Array.isArray(node)) return node.map(chatText).join("");
      if (typeof node === "object") {
        if (typeof node.type === "string" && "value" in node) {
          if (node.type === "string") return String(node.value);
          return chatText(node.value); // compound / list / etc.
        }
        let out = "";
        if (node.translate !== undefined) out += chatText(node.translate);
        if (node.text     !== undefined) out += chatText(node.text);
        if (node.extra    !== undefined) out += chatText(node.extra);
        if (node.with     !== undefined) out += " " + chatText(node.with);
        return out;
      }
      return "";
    };

    // Ring buffer of the last outgoing packets, dumped on each transfer/kick so
    // we can see exactly what preceded an "Invalid sequence" — including the
    // routine movement/teleport_confirm packets normally filtered out.
    const _recentOut = [];
    entry._recentOut = _recentOut;

    bot._client.on("state", (s) => {
      _life(`CONNECTION STATE → ${s}`);
      // Entering configuration = we just got transferred/kicked. Dump what we
      // sent in the moments before, with millisecond timing.
      if (s === "configuration" && _recentOut.length) {
        _life(`── last ${_recentOut.length} outgoing packets before transfer/kick ──`);
        for (const e of _recentOut) {
          console.log(`[fresh-life]    ${e.t}  → ${e.name} ${e.brief}`);
        }
        _recentOut.length = 0;
      }
    });
    bot._client.on("disconnect", (p) => {
      try { _life(`DISCONNECT (config phase) reason=${JSON.stringify(p?.reason)}`); }
      catch { _life(`DISCONNECT (config phase)`); }
    });

    // Which backend server did we just land on? The play "login" packet carries
    // the dimension/world name — if the bot is bouncing survival↔lobby this will
    // change every transfer and pinpoint where it's being sent.
    bot._client.on("login", (packet) => {
      const world = packet?.worldName ?? packet?.dimension ?? "unknown";
      _life(`▶ JOINED world="${world}" (entityId=${packet?.entityId}, gamemode=${packet?.gameMode ?? packet?.previousGameMode})`);
    });

    // Velocity clientbound transfer packet — explicit "go to this server" command.
    bot._client.on("transfer", (p) => {
      _life(`➡️ TRANSFER packet → ${p?.host}:${p?.port}`);
    });

    // Any chat the server sends — the reason for an AFK/anti-bot relocation is
    // usually announced here ("You were moved…", "AFK", "kicked", etc.).
    // We extract readable text and skip empty/whitespace-only messages so the
    // meaningful lines stand out.
    bot._client.on("system_chat", (p) => {
      try {
        const txt = chatText(p?.content).replace(/§./g, "").replace(/\s+/g, " ").trim();
        if (!txt) return;
        // For kick/relocation messages, dump the FULL flattened text plus the raw
        // component so the reason after "kicked from Survival:" is never lost.
        if (/kick|afk|bot|ban|suspicious|moved|removed|slot|priority|full/i.test(txt)) {
          _life(`💬 CHAT[reason]: ${txt.slice(0, 500)}`);
          try { _life(`   raw: ${JSON.stringify(p?.content).slice(0, 600)}`); } catch (_) {}
        } else {
          _life(`💬 CHAT: ${txt.slice(0, 220)}`);
        }
      } catch (_) {}
    });
    bot.on("death", () => _life(`💀 DEATH — bot died (mineflayer will auto-respawn)`));
    bot.on("respawn", () => _life(`♻️ RESPAWN — respawn or dimension/world change`));
    bot.on("end", (r) => _life(`🔚 END — socket closed, reason=${r}`));
    // The server-side "you respawned / world changed" packet in PLAY state:
    bot._client.on("respawn", () => _life(`← server sent RESPAWN packet (gamemode/world change)`));
    bot._client.on("combat_death", (p) => {
      try { _life(`☠️ COMBAT_DEATH message=${JSON.stringify(p?.message)}`); }
      catch { _life(`☠️ COMBAT_DEATH`); }
    });

    // ── Manual Minecraft keep-alive echo ─────────────────────────────────────
    // Required because keepAlive: false disables minecraft-protocol's built-in
    // handler. The server expects the client to echo keep_alive packets within
    // ~30 seconds or it disconnects with "Timed out".
    //
    // Uses _origWrite (pre-patch) to guarantee the echo bypasses our settings
    // interceptor (which is irrelevant here but avoids any future ambiguity).
    bot._client.on("keep_alive", (packet) => {
      try {
        _origWrite("keep_alive", { keepAliveId: packet.keepAliveId });
      } catch (_) {
        // Session is closing — ignore.
      }
    });

    // ── ping/pong: do NOT manually respond ───────────────────────────────────
    // ROOT CAUSE of the "Invalid sequence" kick + flicker loop: minecraft-protocol
    // already auto-responds to the play-state `ping` transaction packet with a
    // `pong`. Our manual pong here was a DUPLICATE — the survival backend's
    // anti-cheat sends rapid ping probes and expects exactly one pong per ping;
    // receiving two pongs (mineflayer's + ours) registered as an out-of-order /
    // duplicate id and, after ~19s of accumulated violations, kicked the bot
    // with "Invalid sequence". Velocity then dropped it to lobby and the queue
    // re-sent it, producing the endless ~20s transfer/flicker cycle.
    //
    // We now defer entirely to minecraft-protocol's built-in pong. (The first
    // few pings are logged so we can confirm mineflayer is still answering them.)
    let _pingSeen = 0;
    bot._client.on("ping", (packet) => {
      if (++_pingSeen <= 3) {
        _life(`(ping #${_pingSeen} id=${packet.id}) — pong handled by minecraft-protocol, not manually`);
      }
    });

    // ── Cookie request (Velocity 1.20.5+) ────────────────────────────────────
    // Velocity proxies can send a cookie_request packet during login. The client
    // must respond with cookie_response (even if empty) or the proxy drops the
    // connection with a SERVER ERROR kick. mineflayer does not handle this
    // automatically, so we echo an empty response for every cookie requested.
    bot._client.on("cookie_request", (packet) => {
      try {
        _origWrite("cookie_response", {
          key:     packet.key,
          payload: null,
        });
        console.log(`[FreshSmpProfile] 🍪 [${entry.minecraftUser}] cookie_response sent for key=${packet.key}`);
      } catch (_) {}
    });

    // ── Client settings re-sent in PLAY after a server transfer ───────────────
    // CRITICAL ORDERING NOTE (learned from forensic packet traces):
    //
    // We must NOT send client_information during the CONFIGURATION state. The
    // working initial-login handshake never does — it only responds to
    // select_known_packs and finish_configuration during config, then sends
    // settings once it reaches PLAY. Every transfer attempt that sent
    // client_information during configuration was kicked by Pipeline (FreshSMP's
    // server software) with a generic "SERVER ERROR / internal error caused by
    // you" — whether sent early (kicked right after known_packs) or late (kicked
    // on entering play). Pipeline throws when it receives client_information mid-
    // configuration on a backend transfer.
    //
    // So we replicate the working pattern: do nothing during config (mineflayer's
    // built-in handler responds to select_known_packs / finish_configuration on
    // its own), and re-send settings only once we are back in PLAY state on the
    // new sub-server. _playEntryCount > 1 means a transfer completed (the first
    // PLAY entry is the initial login, already handled by onLogin).
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

    // ── Anti-AFK — start scheduling after login ───────────────────────────────
    // Wait for login so bot.entity is populated with a valid yaw/pitch, and so
    // we don't send look packets during the pre-login security screen.
    bot.once("login", () => {
      this._scheduleAntiAfk(botId, entry, bot);
    });
  }

  onLogin(bot, entry, botId, spawnBot, callbacks) {
    // Explicitly send client settings for the initial login.
    // The write interceptor applied in onBotCreated guarantees that even
    // mineflayer's own auto-send will be correct, so this is belt-and-suspenders.
    // Subsequent server transfers are handled by the bot._client.on("login")
    // listener registered in onBotCreated above.
    setTimeout(() => {
      if (!bot || bot._client?.ended) return;
      try {
        sendClientSettings(bot._client);
        console.log(`[FreshSmpProfile] ✅ [${entry.minecraftUser}] Client settings sent (initial login)`);
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

    if (lower.includes("server error") || lower.includes("internal error")) {
      console.warn(
        `[FreshSmpProfile] ⚠️ [${entry?.minecraftUser}] SERVER ERROR kick — ` +
        `FreshSMP rejected the connection (malformed or missing packet). ` +
        `Raw reason: ${reasonText}`
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