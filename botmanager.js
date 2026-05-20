// yazanaki/mcbot/botmanager.js (VPS-side)
// Manages mineflayer bots with Microsoft auth, device-code relay,
// link verification, version auto-detection, and auth error dedup.

"use strict";

const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

// ============================================================
// TOKEN CACHE — persists Microsoft tokens between restarts
//
// Each Minecraft account gets its OWN subdirectory:
//   ./tokens/<username>/
//
// prismarine-auth writes its hash-prefixed cache files
// (e.g. ab58c3_live-cache.json) into that subdirectory via
// the `profilesFolder` option passed to mineflayer.createBot().
//
// This isolation means cache files from account A can never
// bleed into account B, preventing invalid_grant errors.
// ============================================================
const TOKENS_ROOT = path.join(__dirname, "tokens");

if (!fs.existsSync(TOKENS_ROOT)) {
  fs.mkdirSync(TOKENS_ROOT, { recursive: true });
}

function accountTokenDir(username) {
  return path.join(TOKENS_ROOT, username.toLowerCase());
}

function markerPath(username) {
  return path.join(accountTokenDir(username), "_marker.json");
}

function ensureAccountDir(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Check whether valid Microsoft auth cache exists for this account.
 * Checks the account's own isolated directory only.
 */
function loadToken(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) return undefined;

  // 1. Check our own marker file
  try {
    const mp = markerPath(username);
    if (fs.existsSync(mp)) {
      const data = JSON.parse(fs.readFileSync(mp, "utf8"));
      if (data && typeof data === "object" && data.username) {
        return data;
      }
    }
  } catch {
    // fall through
  }

  // 2. Check for prismarine-auth hash-prefixed cache files.
  //    Safe to trust here because the directory is account-specific.
  try {
    const files = fs.readdirSync(dir);
    const prismarinePattern = /^[a-f0-9]+_(live|xbl|mca|msa|bedrock)-cache\.json$/i;
    if (files.some(f => prismarinePattern.test(f))) {
      return true;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function saveToken(username) {
  try {
    ensureAccountDir(username);
    const marker = { cachedAt: new Date().toISOString(), username: username.toLowerCase() };
    fs.writeFileSync(markerPath(username), JSON.stringify(marker, null, 2), "utf8");
    console.log(`[botmanager] 💾 Token marker saved for ${username}`);
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not save token marker for ${username}:`, err.message);
  }
}

/**
 * Clear ALL Microsoft auth state for a specific account.
 * Only touches that account's own subdirectory.
 */
function clearAuthCache(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) {
    console.log(`[botmanager] 🧹 No token directory found for ${username} — nothing to clear`);
    return;
  }

  try {
    const files = fs.readdirSync(dir);
    let deleted = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
        deleted++;
        console.log(`[botmanager] 🧹 Deleted auth cache file: ${username}/${file}`);
      } catch (e) {
        console.warn(`[botmanager] ⚠️ Could not delete ${username}/${file}:`, e.message);
      }
    }
    if (deleted === 0) {
      console.log(`[botmanager] 🧹 No auth cache files found for ${username}`);
    }
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not scan token directory for ${username}:`, err.message);
  }
}

// ============================================================
// IN-MEMORY BOT REGISTRY
//
// Key: botId = `${discordId}:${minecraftUser.toLowerCase()}`
// This allows multiple bots per Discord user (one per MC account).
// ============================================================
const activeBots = new Map();

// ============================================================
// RECENTLY ENDED BOTS — for Discord DM notifications
// Populated when a bot ends unexpectedly (not via manual stop).
// Cleared when GET /ended is called.
// ============================================================
const recentlyEndedBots = [];

// ============================================================
// FRESHSMP: pending gamemode selections
// Map<botId, { resolve: Function, timer: NodeJS.Timeout }>
// When the Discord bot POSTs a gamemode selection, we resolve
// the pending promise so the bot can send the /queue command.
// ============================================================
const pendingFreshSmpGamemode = new Map();
const FRESHSMP_GAMEMODE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to pick a gamemode

// Valid FreshSMP gamemodes and their /queue argument
const FRESHSMP_GAMEMODES = {
  survival: "survival",
  lifesteal: "lifesteal",
  skywars: "skywars",
};

function recordEndedBot(entry, endReason) {
  // Don't notify for manual stops
  if (endReason === "manual_stop" || endReason === "stopall" || endReason === "stop_user_all") return;

  recentlyEndedBots.push({
    botId:          entry.botId,
    discordId:      entry.discordId,
    minecraftUser:  entry.minecraftUser,
    serverHost:     entry.serverHost,
    serverPort:     entry.serverPort,
    version:        entry.version,
    endReason,
    spawnError:     entry.spawnError || null,
    lastKickReason: entry.lastKickReason || null,
    errorCategory:  entry.errorCategory || null,
    endedAt:        new Date().toISOString(),
  });
}

function getAndClearRecentlyEnded() {
  const snapshot = [...recentlyEndedBots];
  recentlyEndedBots.length = 0;
  return snapshot;
}

// ============================================================
// AUTH ERROR DEDUP GUARD
// Keyed by botId so each account has its own dedup state.
// ============================================================
const handledAuthErrors = new Set();
const AUTH_ERROR_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

const AUTO_RECONNECT = process.env.AUTO_RECONNECT === "true";
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_BOTS = parseInt(process.env.MAX_BOTS || "0", 10); // 0 = unlimited

// ============================================================
// KEEP-ALIVE TIMEOUT SETTINGS
//
// Root cause of the ~1hr timeout kick:
//   mineflayer's checkTimeoutInterval defaults to 30s, which races
//   with DonutSMP's server-side 30s keep-alive timeout window.
//   If there's any processing delay on either end, we lose the race
//   and get kicked with "disconnect.timeout".
//
// FIX: Set checkTimeoutInterval to 10s so mineflayer checks and
//   responds to keep-alive packets well within the server's window.
//   Also explicitly handle the `ping` packet (a separate mechanism
//   from `keep_alive` that some Paper servers use) by echoing it
//   back immediately via `pong`.
// ============================================================
const CHECK_TIMEOUT_INTERVAL_MS = 10 * 1000; // 10s — respond to keep-alives fast

// ============================================================
// DONUTSMP SETTINGS
// ============================================================
const DONUTSMP_HOST_PATTERNS = ["donutsmp.net", "donutsmp"];
// How many total retries before giving up
const DONUTSMP_MAX_VERIFICATION_RETRIES = 10;
const DONUTSMP_VERIFICATION_RECONNECT_DELAY_MS = 5000;
const DONUTSMP_STRICT_VERSION = "1.21.11";

function isDonutSmpHost(host) {
  if (!host) return false;
  const lower = host.toLowerCase();
  return DONUTSMP_HOST_PATTERNS.some(p => lower.includes(p));
}

function isFreshSmpHost(host) {
  if (!host) return false;
  const lower = host.toLowerCase();
  return FRESHSMP_HOST_PATTERNS.some(p => lower.includes(p));
}

/**
 * Detect if an error code looks like a DonutSMP verification connection reset.
 * EPIPE means the server closed the write end of the socket while our bot was
 * still sending handshake/login packets — DonutSMP's security check cutting
 * the connection early before login completes.
 */
function isDonutSmpEpipe(errCode) {
  return errCode === "EPIPE";
}

/**
 * Detect if a disconnect reason looks like the DonutSMP verification screen
 * disconnect. Handles both pre-login (connectedSince === null) and
 * post-login (connectedSince set, secondsOnline < 30) cases.
 */
function isDonutSmpVerificationDisconnect(reason, connectedSince) {
  if (!reason) return false;
  const r = typeof reason === "string" ? reason.toLowerCase() : JSON.stringify(reason).toLowerCase();
  if (!r.includes("socketclosed")) return false;

  // Pre-login: connectedSince is null — bot never made it past the handshake
  if (connectedSince === null) return true;

  // Post-login: bot was online for less than 30 seconds
  const secondsOnline = Math.floor((Date.now() - connectedSince) / 1000);
  return secondsOnline < 30;
}

// ============================================================
// VERSION CACHE
// ============================================================
const VERSION_CACHE_PATH = path.join(__dirname, "version-cache.json");
const versionCache = new Map();

const SUPPORTED_VERSIONS = new Set([
  "1.21.11", "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21",
  "1.20.6", "1.20.5", "1.20.4", "1.20.3", "1.20.2", "1.20.1", "1.20",
  "1.19.4", "1.19.3", "1.19.2", "1.19.1", "1.19",
  "1.18.2", "1.18.1", "1.18",
  "1.17.1", "1.17",
  "1.16.5", "1.16.4", "1.16.3", "1.16.2", "1.16.1", "1.16",
  "1.15.2", "1.15.1", "1.15",
  "1.14.4", "1.14.3", "1.14.2", "1.14.1", "1.14",
  "1.13.2", "1.13.1", "1.13",
  "1.12.2", "1.12.1", "1.12",
  "1.11.2", "1.11.1", "1.11",
  "1.10", "1.9.4", "1.9", "1.8.9", "1.8.8", "1.8",
]);

function loadVersionCache() {
  try {
    if (!fs.existsSync(VERSION_CACHE_PATH)) return;
    const raw = fs.readFileSync(VERSION_CACHE_PATH, "utf8");
    const json = JSON.parse(raw);
    for (const [host, ver] of Object.entries(json || {})) {
      if (typeof host === "string" && typeof ver === "string" && SUPPORTED_VERSIONS.has(ver)) {
        versionCache.set(host.toLowerCase(), ver);
      }
    }
  } catch {
    // ignore
  }
}

function saveVersionCache() {
  try {
    fs.writeFileSync(VERSION_CACHE_PATH, JSON.stringify(Object.fromEntries(versionCache), null, 2), "utf8");
  } catch {
    // ignore
  }
}

loadVersionCache();

// ============================================================
// HUNGER MANAGEMENT — food items the bot is allowed to eat.
// Dangerous items (pufferfish, spider_eye, rotten_flesh,
// poisonous_potato) are intentionally excluded.
// ============================================================
const BOT_FOOD_ITEMS = new Set([
  // Cooked meats (preferred — high saturation)
  "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
  "cooked_rabbit", "cooked_cod", "cooked_salmon",
  // Raw meats
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
  // Bread & baked goods
  "bread", "cookie", "pumpkin_pie",
  // Fruits & vegetables
  "apple", "golden_apple", "enchanted_golden_apple",
  "carrot", "golden_carrot", "melon_slice",
  "baked_potato", "potato", "beetroot",
  "sweet_berries", "glow_berries",
  // Fish & seafood
  "tropical_fish", "dried_kelp",
  // Misc
  "honey_bottle",
  // Stews (non-stackable but valid)
  "mushroom_stew", "beetroot_soup", "rabbit_stew",
  // Chorus fruit (teleports, but still fills hunger)
  "chorus_fruit",
]);

// ============================================================
// VERSION AUTO-DETECTION HELPERS
// ============================================================

function getAutoCandidatesForHost(hostLower) {
  return [
    "1.21.11", "1.21.4", "1.21.1", "1.21",
    "1.20.6", "1.20.4", "1.20.1",
    "1.19.4", "1.19.2",
    "1.18.2", "1.17.1", "1.16.5",
  ];
}

function shouldRotateVersionForReason(reasonText) {
  const t = (reasonText || "").toLowerCase();
  return (
    t.includes("outdated") ||
    t.includes("not supported") ||
    t.includes("unsupported version") ||
    t.includes("please update") ||
    t.includes("wrong version")
  );
}

// ============================================================
// SERVER ADDRESS PARSER
// ============================================================

function parseServerAddress(serverAddress) {
  const str = String(serverAddress || "").trim();
  const lastColon = str.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: str, port: 25565 };
  }
  const possiblePort = parseInt(str.slice(lastColon + 1), 10);
  if (!isNaN(possiblePort) && possiblePort > 0 && possiblePort <= 65535) {
    return { host: str.slice(0, lastColon), port: possiblePort };
  }
  return { host: str, port: 25565 };
}

// ============================================================
// FATAL ERROR DETECTION
// ============================================================

function isFatalNetworkError(errCode, errMessage) {
  const FATAL_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "EAI_NONAME",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ]);

  if (errCode && FATAL_CODES.has(errCode)) return true;

  const msg = (errMessage || "").toLowerCase();
  if (msg.includes("enotfound") || msg.includes("getaddrinfo")) return true;

  return false;
}

function getFatalErrorMessage(errCode, errMessage) {
  if (errCode === "ENOTFOUND" || (errMessage || "").toLowerCase().includes("getaddrinfo")) {
    return (
      `The server address could not be resolved (DNS lookup failed for the hostname). ` +
      `Check that the server address is spelled correctly and is currently online. ` +
      `Use /mcbot stop and try again with a valid address.`
    );
  }
  if (errCode === "ECONNREFUSED") {
    return (
      `The server refused the connection (port is closed or server is offline). ` +
      `Check that the server is running and the port is correct.`
    );
  }
  if (errCode === "ENETUNREACH" || errCode === "EHOSTUNREACH") {
    return (
      `The server is unreachable from this VPS. ` +
      `The server may be offline or blocking connections from this IP.`
    );
  }
  return `Network error: ${errMessage || errCode}. The server may be offline or unreachable.`;
}

// ============================================================
// DEVICE CODE HANDLER
// ============================================================

function handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse, botId) {
  const {
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval,
  } = deviceCodeResponse;

  const effectiveExpiresIn = expiresIn || 900;

  const entry = botId
    ? activeBots.get(botId)
    : [...activeBots.values()].find(
        (e) => e.minecraftUser === minecraftUser && e.status === "connecting",
      );

  // ── Guard: kill immediately if a second code fires ─────────
  if (entry && entry.deviceCodeEmitted) {
    console.warn(`[botmanager] 🛑 Second device code fired for ${minecraftUser} — killing bot. User must run /mcbot start again.`);

    clearAuthCache(minecraftUser);

    if (entry.spawnTimeoutId) {
      clearTimeout(entry.spawnTimeoutId);
      entry.spawnTimeoutId = null;
    }
    entry.status = "error";
    entry.spawnError =
      "Microsoft authentication failed — the sign-in session could not be completed. " +
      "Please run /mcbot start again to receive a fresh login code.";

    if (botId) {
      setTimeout(() => cleanupBot(botId, "auth_second_code"), 0);
    }
    return;
  }

  // ── First code — mark as emitted and extend spawn timeout ──
  if (entry) {
    entry.deviceCodeEmitted = true;

    if (entry.spawnTimeoutId) {
      clearTimeout(entry.spawnTimeoutId);
    }
    entry.spawnTimeoutId = setTimeout(() => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);
      if (e.status !== "connecting") return;
      console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after 300s (auth) — cleaning up`);
      e.spawnError =
        "Authentication timed out — the Microsoft device code was not redeemed in time. " +
        "Run /mcbot start again to get a new code.";
      e.status = "error";
      setTimeout(() => cleanupBot(botId, "spawn_timeout"), 30000);
    }, 5 * 60 * 1000);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🔐 Microsoft auth required for ${minecraftUser}`);
  console.log(`[botmanager] 🌐 Go to: ${verificationUri}`);
  console.log(`[botmanager] 🔑 Enter code: ${userCode}`);
  console.log(`[botmanager] ⏰ Expires in: ${Math.floor(effectiveExpiresIn / 60)} minutes`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (typeof onDeviceCode === "function") {
    try {
      onDeviceCode(userCode, verificationUri, effectiveExpiresIn);
    } catch (err) {
      console.warn(`[botmanager] ⚠️ onDeviceCode callback threw:`, err.message);
    }
  }
}

// ============================================================
// BOT ID HELPER
// ============================================================

/**
 * Compute the canonical bot key for the activeBots map.
 * Format: `${discordId}:${minecraftUser.toLowerCase()}`
 */
function makeBotId(discordId, minecraftUser) {
  return `${discordId}:${minecraftUser.toLowerCase()}`;
}

function sendClientSettings(bot, username, context) {
  const ctx = context || "unknown";
  console.log(`[botmanager] 📋 [${username}] Sending client settings (context: ${ctx})`);
  try {
    bot._client.write("settings", {
      locale: "en_US", viewDistance: 8, chatFlags: 0, chatColors: true,
      skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true,
    });
    console.log(`[botmanager] 📋 [${username}] Client settings sent successfully`);
  } catch (err) {
    console.warn(`[botmanager] ⚠️ [${username}] Could not send client settings:`, err.message);
  }
}

// ============================================================
// DONUTSMP MOVEMENT SUPPRESSION
//
// Permanently block autonomous position/flying/look packets for the
// entire session. An AFK bot has no reason to send them at all.
//   - `position`      = autonomous heartbeat (BLOCK FOREVER)
//   - `flying`        = on-ground heartbeat (BLOCK FOREVER)
//   - `look`          = head rotation (BLOCK FOREVER)
//   - `position_look` = teleport echo response (ALWAYS ALLOW)
// All other packets pass freely.
// ============================================================
function installDonutSmpMovementBlock(bot, entry, botId, minecraftUser) {
  entry.donutSmpReadyAt = 0;

  if (bot.physicsEnabled !== undefined) {
    bot.physicsEnabled = false;
  }

  const origWrite = bot._client.write.bind(bot._client);
  const BLOCK = new Set(["position", "flying", "look"]);

  bot._client.write = function donutSmpMovementBlock(name, params) {
    if (BLOCK.has(name)) {
      try {
        const preview = JSON.stringify(params);
        console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED]`, (preview != null ? preview : "(non-serializable)").slice(0, 120));
      } catch {
        console.log(`[donut-pkt] → CLIENT sent: ${name} [SUPPRESSED] (non-serializable)`);
      }
      return;
    }
    try {
      const preview = JSON.stringify(params);
      console.log(`[donut-pkt] → CLIENT sent: ${name}`, (preview != null ? preview : "(non-serializable)").slice(0, 120));
    } catch {
      console.log(`[donut-pkt] → CLIENT sent: ${name} (non-serializable)`);
    }
    return origWrite(name, params);
  };

  // ── Explicit ping/pong handler ──────────────────────────────────────────
  // Some Paper servers (including DonutSMP) send a `ping` packet as an
  // additional liveness check separate from `keep_alive`. mineflayer does
  // NOT automatically respond to this. If we don't pong, the server's
  // connection watchdog eventually kicks us with disconnect.timeout.
  //
  // We listen on the raw _client for the `ping` packet and immediately
  // write back a `pong` with the same id. This runs outside the movement
  // block since `pong` is not in the BLOCK set.
  bot._client.on("ping", (packet) => {
    try {
      origWrite("pong", { id: packet.id });
      console.log(`[donut-pkt] 🏓 ping received id=${packet.id} → pong sent`);
    } catch (err) {
      console.warn(`[botmanager] ⚠️ [${minecraftUser}] Could not send pong:`, err.message);
    }
  });

  console.log(
    `[botmanager] 🟠 [${minecraftUser}] DonutSMP movement block + ping/pong handler installed — ` +
    `position/flying/look permanently suppressed`
  );
}

// ============================================================
// FRESHSMP: Send gamemode queue command
// ============================================================
function sendFreshSmpQueueCommand(botId, gamemode) {
  const entry = activeBots.get(botId);
  if (!entry) {
    console.warn(`[botmanager] ⚠️ [FreshSMP] sendFreshSmpQueueCommand: bot ${botId} not found`);
    return { success: false, reason: "bot_not_found" };
  }

  if (!entry.bot) {
    console.warn(`[botmanager] ⚠️ [FreshSMP] sendFreshSmpQueueCommand: bot instance missing for ${botId}`);
    return { success: false, reason: "bot_instance_missing" };
  }

  if (entry.status !== "online") {
    console.warn(`[botmanager] ⚠️ [FreshSMP] sendFreshSmpQueueCommand: bot ${botId} is not online (status: ${entry.status})`);
    return { success: false, reason: "bot_not_online" };
  }

  const gamemodeKey = String(gamemode || "").toLowerCase();
  const queueArg = FRESHSMP_GAMEMODES[gamemodeKey];
  if (!queueArg) {
    console.warn(`[botmanager] ⚠️ [FreshSMP] Unknown gamemode: ${gamemode}`);
    return { success: false, reason: "unknown_gamemode" };
  }

  // Resolve the pending gamemode promise if one exists (from the spawn wait)
  const pending = pendingFreshSmpGamemode.get(botId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingFreshSmpGamemode.delete(botId);
    pending.resolve(queueArg);
    console.log(`[botmanager] 🎮 [FreshSMP] Gamemode resolved via pending promise for ${botId}: /${queueArg}`);
    return { success: true, gamemode: queueArg };
  }

  // No pending promise — send command directly (e.g. called after timeout or re-queue)
  try {
    entry.bot.chat(`/queue ${queueArg}`);
    entry.freshSmpGamemode = queueArg;
    console.log(`[botmanager] 🎮 [FreshSMP] Sent /queue ${queueArg} for ${entry.minecraftUser}`);
    return { success: true, gamemode: queueArg };
  } catch (err) {
    console.error(`[botmanager] ❌ [FreshSMP] Failed to send /queue ${queueArg} for ${entry.minecraftUser}:`, err.message);
    return { success: false, reason: "chat_failed", error: err.message };
  }
}

// ============================================================
// FRESHSMP: Wait for gamemode selection
// ============================================================
function waitForFreshSmpGamemode(botId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFreshSmpGamemode.delete(botId);
      reject(new Error("gamemode_selection_timeout"));
    }, FRESHSMP_GAMEMODE_TIMEOUT_MS);

    pendingFreshSmpGamemode.set(botId, { resolve, timer });
  });
}

function startBot(discordId, minecraftUser, serverAddress, version, onDeviceCode = null, onLinkVerified = null, onFreshSmpSpawned = null) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🤖 Starting bot`);
  console.log(`  Discord ID:   ${discordId}`);
  console.log(`  MC User:      ${minecraftUser}`);
  console.log(`  Server:       ${serverAddress}`);
  console.log(`  Version:      ${version}`);
  console.log(`  Auth mode:    microsoft`);

  const botId = makeBotId(discordId, minecraftUser);

  handledAuthErrors.delete(botId);

  if (activeBots.has(botId)) {
    const existing = activeBots.get(botId);
    console.warn(`[botmanager] ⚠️ Bot for ${minecraftUser} already active on ${existing.serverHost}:${existing.serverPort}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "already_running", serverAddress: `${existing.serverHost}:${existing.serverPort}` };
  }

  if (MAX_BOTS > 0 && activeBots.size >= MAX_BOTS) {
    console.warn(`[botmanager] ⚠️ Max bot limit reached (${MAX_BOTS})`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "max_bots_reached", max: MAX_BOTS };
  }

  const { host, port } = parseServerAddress(serverAddress);
  const hostLower = String(host || "").toLowerCase();
  const requestedVersion = (version || "1.21.11").trim();
  const autoMode = requestedVersion.toLowerCase() === "auto";
  const autoCandidates = autoMode ? getAutoCandidatesForHost(hostLower) : [];
  const cached = autoMode ? versionCache.get(hostLower) : null;
  let effectiveVersion = autoMode
    ? (cached || autoCandidates[0] || "1.21.11")
    : requestedVersion;

  let autoVersionIndex = autoMode
    ? Math.max(0, autoCandidates.indexOf(effectiveVersion))
    : -1;

  const tokenDir = ensureAccountDir(minecraftUser);

  // Track whether this is a DonutSMP server for special reconnect handling
  const isDonutSmp = isDonutSmpHost(hostLower);

  if (isDonutSmp && effectiveVersion !== DONUTSMP_STRICT_VERSION) {
    console.warn(`[botmanager] 🛡️ DonutSMP strict version override: ${effectiveVersion} -> ${DONUTSMP_STRICT_VERSION}`);
    effectiveVersion = DONUTSMP_STRICT_VERSION;
  }

  const entry = {
    botId,
    discordId,
    minecraftUser,
    serverHost: host,
    serverPort: port,
    version: effectiveVersion,
    startedAt: new Date().toISOString(),
    status: "connecting", spawnError: null, spawnTimeoutId: null,
    deviceCodeEmitted: false, bot: null, isDonutSmp,
    donutSmpVerificationRetries: 0, connectedSince: null,
    donutSmpQuietUntil: 0,
    donutSmpReadyAt: 0,
  };

  activeBots.set(botId, entry);

  // ── Hunger state — persists across reconnects for this bot session ──
  let isEating = false;
  let eatCooldownUntil = 0;

  const initialSpawnTimeoutMs = isDonutSmp ? 90000 : 30000;

  entry.spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(botId)) return;
    const e = activeBots.get(botId);
    if (e.status !== "connecting") return;
    if (e.deviceCodeEmitted) return; // auth timeout handled separately
    console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after ${Math.round(initialSpawnTimeoutMs / 1000)}s — cleaning up`);
    e.spawnError = isDonutSmp
      ? "DonutSMP security check timed out. Please confirm the login via the DonutSMP Discord bot DM, then try /mcbot start again."
      : "Bot failed to connect within 30 seconds. The server may be offline or unreachable.";
    e.status = "error";
    if (isDonutSmp) e.errorCategory = "donutsmp_verification";
    setTimeout(() => cleanupBot(botId, "spawn_timeout"), 30000);
  }, initialSpawnTimeoutMs);

  function spawnBot(versionToTry) {
    entry.version = versionToTry;
    // Reset connected timestamp on each spawn attempt
    entry.connectedSince = null;

    // ── Hard-destroy any previous bot instance before spawning a new one ──
    // This prevents zombie instances from continuing to fire events or
    // hold open keepalive timers after a reconnect cycle.
    if (entry.bot) {
      const oldBot = entry.bot;
      entry.bot = null;
      hardDestroyBot(oldBot);
    }

    let bot;
    try {
      bot = mineflayer.createBot({
        host,
        port,
        username: minecraftUser,
        version: versionToTry,
        auth: "microsoft",
        profilesFolder: tokenDir,
        onMsaCode: (data) => handleDeviceCode(minecraftUser, onDeviceCode, data, botId),
        // Use a shorter check interval so we respond to keep-alive packets
        // well within the server's timeout window (DonutSMP kicks at 30s).
        // 10s gives us 3x margin before the server would time us out.
        checkTimeoutInterval: CHECK_TIMEOUT_INTERVAL_MS,
      });
    } catch (err) {
      console.error(`[botmanager] ❌ mineflayer.createBot threw for ${minecraftUser}:`, err.message);
      entry.status = "error";
      entry.spawnError = `Failed to create bot: ${err.message}`;
      cleanupBot(botId, "create_error");
      return;
    }

    entry.bot = bot;

    // ── Guard: drop all events if this bot instance has been superseded ──
    // When spawnBot() is called for a reconnect, the old bot object may still
    // fire events (end, error, kicked) after we've already replaced entry.bot.
    // We check identity so stale events from the old instance are ignored.
    function isCurrentBot() {
      return activeBots.has(botId) && entry.bot === bot;
    }

    // ── Hunger / Eating behavior ────────────────────────────────

    async function tryEat() {
      if (isEating || Date.now() < eatCooldownUntil) return;
      if (!isCurrentBot()) return;
      if (bot.food >= 18) return;

      const foodItem = bot.inventory.items().find(
        (item) => item && BOT_FOOD_ITEMS.has(item.name)
      );
      if (!foodItem) return;

      isEating = true;
      try {
        await bot.equip(foodItem, "hand");
        await bot.consume();
        eatCooldownUntil = Date.now() + 1500;
        console.log(
          `[botmanager] 🍖 ${minecraftUser} ate ${foodItem.name} ` +
          `(food: ${bot.food}/20)`
        );
      } catch {
        // Ignore eating errors
      } finally {
        isEating = false;
      }
    }

    bot.on("health", () => {
      if (!isCurrentBot()) return;
      if (bot.food < 18) {
        tryEat().catch(() => {});
      }
    });

    // ── Standard bot events ─────────────────────────────────────

    bot.once("login", () => {
      if (!isCurrentBot()) return;
      console.log(`[botmanager] ✅ Bot logged in: ${minecraftUser} on ${host}:${port} (${versionToTry})`);
      const e = activeBots.get(botId);

      // Only clear the spawn timeout on first successful login —
      // not during DonutSMP verification retries (we want the outer
      // timeout to remain as the final safety net).
      if (!isDonutSmp && e.spawnTimeoutId) {
        clearTimeout(e.spawnTimeoutId);
        e.spawnTimeoutId = null;
      }

      e.status = "online";
      e.version = versionToTry;
      e.connectedSince = Date.now(); // record when we went online

      if (autoMode) {
        versionCache.set(hostLower, versionToTry);
        saveVersionCache();
      }

      saveToken(minecraftUser);

      if (isDonutSmp) {
        // Install movement block AND ping/pong handler.
        installDonutSmpMovementBlock(bot, e, botId, minecraftUser);
        console.log(`[botmanager] 🟠 DonutSMP login — movement block + ping/pong active. Monitoring for verification disconnect (retry ${e.donutSmpVerificationRetries}/${DONUTSMP_MAX_VERIFICATION_RETRIES})`);
      } else {
        // For non-DonutSMP servers, also handle ping/pong since some Paper
        // servers use it regardless of anti-cheat configuration.
        bot._client.on("ping", (packet) => {
          try {
            bot._client.write("pong", { id: packet.id });
          } catch (_) {}
        });

        setTimeout(() => {
          if (!activeBots.has(botId) || entry.bot !== bot) return;
          sendClientSettings(bot, minecraftUser, "post-login");
        }, 1000);
      }

      if (typeof onLinkVerified === "function") {
        try { onLinkVerified(discordId, minecraftUser); } catch (_) {}
      }
    });

    // ── DonutSMP: Full packet logger ─────────────────────────────────────────
    if (isDonutSmp) {
      bot._client.on("packet", (data, meta) => {
        try {
          const serialized = JSON.stringify(data);
          const preview = (serialized != null) ? serialized.slice(0, 120) : "(non-serializable)";
          console.log(`[donut-pkt] ← SERVER sent: ${meta.name}`, preview);
        } catch {
          console.log(`[donut-pkt] ← SERVER sent: ${meta.name} (binary/non-serializable)`);
        }
      });
    }

    // ── Spawn ─────────────────────────────────────────────────────────────────
    bot.once("spawn", () => {
      if (!activeBots.has(botId)) return;
      if (isDonutSmp) console.log(`[botmanager] 🟠 DonutSMP spawn fired for ${minecraftUser} — movement block active`);
    });

    // ── Kicked ───────────────────────────────────────────────────────────────
    bot.on("kicked", (reason) => {
      if (!isCurrentBot()) return;
      const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
      console.warn(`[botmanager] 🦵 Bot kicked (${minecraftUser}): ${reasonText}`);
      const e = activeBots.get(botId);
      if (entry.bot !== bot) return;
      if (e.status === "reconnecting" && !e.isDonutSmp) return;

      if (e.isDonutSmp && isDonutSmpVerificationKick(reasonText)) {
        console.log(`[botmanager] 🟠 DonutSMP verification kick for ${minecraftUser} — scheduling retry`);
        kickHandled = true;
        return;
      }

      if (autoMode && shouldRotateVersionForReason(reasonText)) {
        autoVersionIndex++;
        if (autoVersionIndex < autoCandidates.length) {
          const nextVersion = autoCandidates[autoVersionIndex];
          console.log(`[botmanager] 🔄 Auto-version rotate: trying ${nextVersion} for ${minecraftUser}`);
          spawnBot(nextVersion);
          return;
        }
      }

      const e = activeBots.get(botId);
      e.status = "error";
      e.spawnError = `Kicked: ${reasonText}`;

      if (AUTO_RECONNECT) {
        console.log(`[botmanager] 🔄 Reconnecting ${minecraftUser} in ${RECONNECT_DELAY_MS}ms...`);
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          spawnBot(e.version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "kicked");
      }
    });

    bot.on("error", (err) => {
      if (!isCurrentBot()) return;
      const e = activeBots.get(botId);

      const errCode = err.code;
      const errMessage = err.message || "";

      // ── DonutSMP EPIPE — server closed socket during handshake ──────────
      // EPIPE on a DonutSMP server means the security check rejected the
      // connection at the TCP level before login completed. Treat it as a
      // verification retry, not a fatal error.
      if (isDonutSmp && isDonutSmpEpipe(errCode)) {
        const phase = e.connectedSince === null ? "pre-login (EPIPE)" : "post-login (EPIPE)";
        console.log(`[botmanager] 🟠 DonutSMP EPIPE for ${minecraftUser} — treating as verification disconnect`);
        scheduleDonutSmpRetry(botId, e, spawnBot, phase);
        return;
      }

      console.error(`[botmanager] ❌ Bot error (${minecraftUser}):`, errMessage);

      // Cancel any pending FreshSMP gamemode wait
      if (isFreshSmp) {
        const pending = pendingFreshSmpGamemode.get(botId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingFreshSmpGamemode.delete(botId);
        }
      }

      // ── Auth error dedup ───────────────────────────────────────────────
      const isAuthError =
        errMessage.includes("invalid_grant") ||
        errMessage.includes("AADSTS") ||
        errMessage.includes("authentication") ||
        errMessage.toLowerCase().includes("token");

      if (isAuthError) {
        if (handledAuthErrors.has(botId)) {
          console.warn(`[botmanager] 🔇 Suppressing duplicate auth error for ${minecraftUser}`);
          return;
        }
        handledAuthErrors.add(botId);
        setTimeout(() => handledAuthErrors.delete(botId), AUTH_ERROR_DEDUP_TTL_MS);

        clearAuthCache(minecraftUser);
        e.status = "error";
        e.spawnError = "Microsoft authentication failed. Run /mcbot start again to sign in.";
        e.errorCategory = "auth_error";
        cleanupBot(botId, "auth_error");
        return;
      }

      if (isFatalNetworkError(errCode, errMessage)) {
        e.status = "error";
        e.spawnError = getFatalErrorMessage(errCode, errMessage);
        cleanupBot(botId, "fatal_network_error");
        return;
      }

      // Suppress keepalive timeout if we're already in a non-active state
      // (e.g. bot was stopped but the socket hadn't fully closed yet)
      if (errMessage.includes("timed out") && e.status !== "online" && e.status !== "connecting") {
        console.warn(`[botmanager] 🔇 Suppressing stale keepalive timeout for ${minecraftUser} (status: ${e.status})`);
        return;
      }

      e.status = "error";
      e.spawnError = errMessage;

      if (AUTO_RECONNECT) {
        console.log(`[botmanager] 🔄 Reconnecting ${minecraftUser} in ${RECONNECT_DELAY_MS}ms (error)...`);
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          spawnBot(e.version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "error");
      }
    });

    bot.on("end", (reason) => {
      if (!isCurrentBot()) return;
      const e = activeBots.get(botId);

      // Only act on end events when we're in an active state.
      // "reconnecting" means a retry is already scheduled — ignore.
      if (e.status !== "online" && e.status !== "connecting") return;

      console.log(`[botmanager] 🔌 Bot disconnected (${minecraftUser}): ${reason}`);

      // Cancel any pending FreshSMP gamemode wait
      if (isFreshSmp) {
        const pending = pendingFreshSmpGamemode.get(botId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingFreshSmpGamemode.delete(botId);
        }
      }

      // ── DonutSMP verification screen handling ──────────────────────────
      // Handles BOTH pre-login (connectedSince === null) and post-login
      // (connectedSince set, online < 30s) socketClosed disconnects.
      if (e.isDonutSmp && isDonutSmpVerificationDisconnect(reason, e.connectedSince)) {
        const phase = e.connectedSince === null ? "pre-login" : "post-login";
        scheduleDonutSmpRetry(botId, e, spawnBot, phase);
        return;
      }

      // ── Standard disconnect handling ───────────────────────────────────
      e.status = "error";
      e.spawnError = `Disconnected: ${reason}`;

      if (AUTO_RECONNECT) {
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          spawnBot(e.version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "end");
      }
    });
  }

  spawnBot(effectiveVersion);

  console.log(`[botmanager] 🚀 Bot spawned for ${minecraftUser} (botId: ${botId})`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  return { success: true, botId };
}

// ============================================================
// FRESHSMP GAMEMODE FLOW (async, fires after login)
//
// 1. Calls onFreshSmpSpawned so the Discord bot knows the bot
//    is online and can DM the gamemode selector embed.
// 2. Waits for the user to click a button (resolves the pending
//    promise via sendFreshSmpQueueCommand / waitForFreshSmpGamemode).
// 3. Sends /queue <gamemode> after a short stabilisation delay.
// 4. Marks freshSmpQueueSent on the entry so the status embed
//    can reflect which gamemode the bot is in.
// ============================================================
async function _handleFreshSmpGamemodeFlow(botId, minecraftUser, bot, onFreshSmpSpawned) {
  // Notify the Discord bot that we're online and need a gamemode selection
  if (typeof onFreshSmpSpawned === "function") {
    try { onFreshSmpSpawned(botId); }
    catch (err) { console.warn(`[botmanager] ⚠️ [FreshSMP] onFreshSmpSpawned callback threw:`, err.message); }
  }

  let chosenGamemode;
  try {
    console.log(`[botmanager] 🟢 [FreshSMP] Waiting for gamemode selection for ${minecraftUser}...`);
    chosenGamemode = await waitForFreshSmpGamemode(botId);
  } catch (err) {
    // Timed out — bot stays connected but /queue was never sent
    console.warn(`[botmanager] ⚠️ [FreshSMP] Gamemode selection timed out for ${minecraftUser}. Bot remains connected but /queue not sent.`);
    return;
  }

  // Check the bot is still active before sending
  if (!activeBots.has(botId)) {
    console.warn(`[botmanager] ⚠️ [FreshSMP] Bot ${botId} gone before /queue could be sent`);
    return;
  }

  const entry = activeBots.get(botId);
  if (entry.bot !== bot || entry.status !== "online") {
    console.warn(`[botmanager] ⚠️ [FreshSMP] Bot ${botId} no longer online, skipping /queue`);
    return;
  }

  // Short delay to let the server fully stabilise after login
  await new Promise(r => setTimeout(r, FRESHSMP_QUEUE_COMMAND_DELAY_MS));

  if (!activeBots.has(botId) || activeBots.get(botId).bot !== bot) return;

  try {
    bot.chat(`/queue ${chosenGamemode}`);
    entry.freshSmpGamemode = chosenGamemode;
    entry.freshSmpQueueSent = true;
    console.log(`[botmanager] 🟢 [FreshSMP] Sent /queue ${chosenGamemode} for ${minecraftUser}`);
  } catch (err) {
    console.error(`[botmanager] ❌ [FreshSMP] Failed to send /queue ${chosenGamemode} for ${minecraftUser}:`, err.message);
  }
}

// ============================================================
// STOP / CLEANUP
// ============================================================

/**
 * Stop a specific bot by discordId + minecraftUser.
 */
function stopBot(discordId, minecraftUser) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🛑 Stopping bot — discordId: ${discordId}, mc: ${minecraftUser}`);

  const botId = makeBotId(discordId, minecraftUser);
  const entry = activeBots.get(botId);
  if (!entry) {
    console.warn(`[botmanager] ⚠️ No bot running for ${botId}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "no_bot_running" };
  }
  cleanupBot(botId, "manual_stop");
  console.log(`[botmanager] ✅ Bot stopped for ${minecraftUser}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  return { success: true };
}

/**
 * Stop ALL bots for a given discordId (convenience).
 */
function stopBotsForUser(discordId) {
  console.log(`[botmanager] 🛑 Stopping all bots for discordId: ${discordId}`);
  const prefix = `${discordId}:`;
  let count = 0;
  for (const botId of [...activeBots.keys()]) {
    if (botId.startsWith(prefix)) { cleanupBot(botId, "stop_user_all"); count++; }
  }
  return { success: true, stopped: count };
}

function stopAllBots() {
  const count = activeBots.size;
  console.log(`[botmanager] 🚨 Stopping all ${count} bot(s)`);
  for (const botId of [...activeBots.keys()]) cleanupBot(botId, "stopall");
  return { success: true, stopped: count };
}

function cleanupBot(botId, reason) {
  const entry = activeBots.get(botId);
  if (!entry) return;

  if (entry.spawnTimeoutId) {
    clearTimeout(entry.spawnTimeoutId);
    entry.spawnTimeoutId = null;
  }

  // Remove from registry BEFORE destroying the bot so that any events
  // fired during destruction fail the isCurrentBot() / activeBots.has()
  // checks and are silently dropped.
  activeBots.delete(botId);

  // Record for the /ended endpoint (Discord bot polls this for offline DMs)
  recordEndedBot(entry, reason);

  // Hard-destroy the bot instance to kill the TCP socket and stop
  // minecraft-protocol's internal keepalive timer immediately.
  if (entry.bot) {
    const botToDestroy = entry.bot;
    entry.bot = null;
    hardDestroyBot(botToDestroy);
  }

  console.log(`[botmanager] 🧹 Cleaned up bot for ${entry.minecraftUser} (reason: ${reason})`);
}

// ============================================================
// STATUS / LIST
// ============================================================

/**
 * Get status for a specific (discordId, minecraftUser) bot.
 */
function getBotStatus(discordId, minecraftUser) {
  const botId = makeBotId(discordId, minecraftUser);
  const entry = activeBots.get(botId);
  if (!entry) return { found: false };

  return {
    found: true,
    bot: {
      botId: entry.botId,
      discordId: entry.discordId,
      minecraftUser: entry.minecraftUser,
      serverHost: entry.serverHost,
      serverPort: entry.serverPort,
      version: entry.version,
      startedAt: entry.startedAt,
      status: entry.status,
      spawnError: entry.spawnError || null,
      errorCategory: entry.errorCategory || null,
      uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
      // DonutSMP-specific info for debugging
      donutSmpVerificationRetries: entry.isDonutSmp ? entry.donutSmpVerificationRetries : undefined,
      // FreshSMP fields exposed to Discord bot
      isFreshSmp: entry.isFreshSmp || false,
      freshSmpGamemode: entry.freshSmpGamemode || null,
      freshSmpQueueSent: entry.freshSmpQueueSent || false,
    },
  };
}

/**
 * Get statuses for ALL bots belonging to a discordId.
 */
function getBotsForUser(discordId) {
  const prefix = `${discordId}:`;
  const bots = [];
  for (const [botId, entry] of activeBots.entries()) {
    if (botId.startsWith(prefix)) {
      bots.push({
        botId: entry.botId,
        discordId: entry.discordId,
        minecraftUser: entry.minecraftUser,
        serverHost: entry.serverHost,
        serverPort: entry.serverPort,
        version: entry.version,
        startedAt: entry.startedAt,
        status: entry.status,
        spawnError: entry.spawnError || null,
        errorCategory: entry.errorCategory || null,
        uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
        isFreshSmp: entry.isFreshSmp || false,
        freshSmpGamemode: entry.freshSmpGamemode || null,
        freshSmpQueueSent: entry.freshSmpQueueSent || false,
      });
    }
  }
  return bots;
}

function getBotCount() {
  return activeBots.size;
}

function listAllBots() {
  return [...activeBots.values()].map((entry) => ({
    botId: entry.botId,
    discordId: entry.discordId,
    minecraftUser: entry.minecraftUser,
    serverHost: entry.serverHost,
    serverPort: entry.serverPort,
    version: entry.version,
    startedAt: entry.startedAt,
    status: entry.status,
    uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
    isFreshSmp: entry.isFreshSmp || false,
    freshSmpGamemode: entry.freshSmpGamemode || null,
  }));
}

module.exports = {
  makeBotId, startBot, stopBot, stopBotsForUser, stopAllBots,
  getBotStatus, getBotsForUser, listAllBots, getBotCount, getAndClearRecentlyEnded,
};