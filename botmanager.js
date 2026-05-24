// yazanaki/mcbot/botmanager.js (VPS-side)
// Generic bot lifecycle manager.
//
// Server-specific logic (anti-cheat, version pinning, movement suppression,
// verification retries, gamemode flows) lives in profiles/<ServerProfile>.js
// and is selected automatically via the profile registry in profiles/index.js.

"use strict";

const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

const { getProfileForHost } = require("./afk-core/src/index");

// ============================================================
// TOKEN CACHE — persists Microsoft tokens between restarts
//
// Each Minecraft account gets its own subdirectory:
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
 */
function loadToken(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) return undefined;

  try {
    const mp = markerPath(username);
    if (fs.existsSync(mp)) {
      const data = JSON.parse(fs.readFileSync(mp, "utf8"));
      if (data && typeof data === "object" && data.username) return data;
    }
  } catch {
    // fall through
  }

  try {
    const files = fs.readdirSync(dir);
    const prismarinePattern = /^[a-f0-9]+_(live|xbl|mca|msa|bedrock)-cache\.json$/i;
    if (files.some((f) => prismarinePattern.test(f))) return true;
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

function recordEndedBot(entry, endReason) {
  // Don't notify for manual stops
  if (
    endReason === "manual_stop" ||
    endReason === "stopall" ||
    endReason === "stop_user_all"
  ) return;

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
// ============================================================
const handledAuthErrors = new Set();
const AUTH_ERROR_DEDUP_TTL_MS = 10 * 60 * 1000;

// ============================================================
// CONFIGURATION
// ============================================================
const AUTO_RECONNECT = process.env.AUTO_RECONNECT === "true";
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_BOTS = parseInt(process.env.MAX_BOTS || "0", 10); // 0 = unlimited

// ============================================================
// VERSION CACHE — remembers which version worked per host
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

const AUTO_VERSION_CANDIDATES = [
  "1.21.11", "1.21.4", "1.21.1", "1.21",
  "1.20.6", "1.20.4", "1.20.1",
  "1.19.4", "1.19.2",
  "1.18.2", "1.17.1", "1.16.5",
];

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
    fs.writeFileSync(
      VERSION_CACHE_PATH,
      JSON.stringify(Object.fromEntries(versionCache), null, 2),
      "utf8"
    );
  } catch {
    // ignore
  }
}

loadVersionCache();

// ============================================================
// HUNGER MANAGEMENT
//
// Safe food items the bot will auto-eat.
// Dangerous items (pufferfish, spider_eye, rotten_flesh,
// poisonous_potato) are intentionally excluded.
// ============================================================
const BOT_FOOD_ITEMS = new Set([
  "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
  "cooked_rabbit", "cooked_cod", "cooked_salmon",
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
  "bread", "cookie", "pumpkin_pie",
  "apple", "golden_apple", "enchanted_golden_apple",
  "carrot", "golden_carrot", "melon_slice",
  "baked_potato", "potato", "beetroot",
  "sweet_berries", "glow_berries",
  "tropical_fish", "dried_kelp",
  "honey_bottle",
  "mushroom_stew", "beetroot_soup", "rabbit_stew",
  "chorus_fruit",
]);

// ============================================================
// HELPERS
// ============================================================

function parseServerAddress(serverAddress) {
  const str = String(serverAddress || "").trim();
  const lastColon = str.lastIndexOf(":");
  if (lastColon === -1) return { host: str, port: 25565 };
  const possiblePort = parseInt(str.slice(lastColon + 1), 10);
  if (!isNaN(possiblePort) && possiblePort > 0 && possiblePort <= 65535) {
    return { host: str.slice(0, lastColon), port: possiblePort };
  }
  return { host: str, port: 25565 };
}

function makeBotId(discordId, minecraftUser) {
  return `${discordId}:${minecraftUser.toLowerCase()}`;
}

function isFatalNetworkError(errCode, errMessage) {
  const FATAL_CODES = new Set([
    "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME",
    "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH",
  ]);
  if (errCode && FATAL_CODES.has(errCode)) return true;
  const msg = (errMessage || "").toLowerCase();
  return msg.includes("enotfound") || msg.includes("getaddrinfo");
}

function getFatalErrorMessage(errCode, errMessage) {
  if (errCode === "ENOTFOUND" || (errMessage || "").toLowerCase().includes("getaddrinfo")) {
    return (
      "The server address could not be resolved (DNS lookup failed). " +
      "Check the address is spelled correctly and the server is online."
    );
  }
  if (errCode === "ECONNREFUSED") {
    return "The server refused the connection (port closed or server offline).";
  }
  if (errCode === "ENETUNREACH" || errCode === "EHOSTUNREACH") {
    return "The server is unreachable from this VPS.";
  }
  return `Network error: ${errMessage || errCode}. The server may be offline.`;
}

function shouldRotateVersion(reasonText) {
  const t = (reasonText || "").toLowerCase();
  return (
    t.includes("outdated") ||
    t.includes("not supported") ||
    t.includes("unsupported version") ||
    t.includes("please update") ||
    t.includes("wrong version")
  );
}

/**
 * Forcibly destroy a mineflayer bot instance, stopping all timers and
 * closing the underlying socket. Safe to call multiple times.
 */
function hardDestroyBot(bot) {
  if (!bot) return;
  try { bot.quit(); } catch (_) {}
  try { bot._client?.end(); } catch (_) {}
  try { bot._client?.socket?.destroy(); } catch (_) {}
}

// ============================================================
// DEVICE CODE HANDLER
// ============================================================

function handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse, botId) {
  const {
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
  } = deviceCodeResponse;

  const effectiveExpiresIn = expiresIn || 900;
  const entry = activeBots.get(botId);

  // Guard: kill immediately if a second code fires — prismarine-auth bug
  if (entry && entry.deviceCodeEmitted) {
    console.warn(
      `[botmanager] 🛑 Second device code fired for ${minecraftUser} — killing bot.`
    );
    clearAuthCache(minecraftUser);
    if (entry.spawnTimeoutId) {
      clearTimeout(entry.spawnTimeoutId);
      entry.spawnTimeoutId = null;
    }
    entry.status = "error";
    entry.spawnError =
      "Microsoft authentication failed — the sign-in session could not be completed. " +
      "Please run /mcbot start again to receive a fresh login code.";
    setTimeout(() => cleanupBot(botId, "auth_second_code"), 0);
    return;
  }

  // First code — mark as emitted and extend the spawn timeout to cover auth
  if (entry) {
    entry.deviceCodeEmitted = true;
    if (entry.spawnTimeoutId) clearTimeout(entry.spawnTimeoutId);
    entry.spawnTimeoutId = setTimeout(() => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);
      if (e.status !== "connecting") return;
      console.warn(
        `[botmanager] ⏰ Auth timeout for ${minecraftUser} after 300s — cleaning up`
      );
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
    try { onDeviceCode(userCode, verificationUri, effectiveExpiresIn); }
    catch (err) {
      console.warn(`[botmanager] ⚠️ onDeviceCode callback threw:`, err.message);
    }
  }
}

// ============================================================
// START BOT
// ============================================================

function startBot(
  discordId,
  minecraftUser,
  serverAddress,
  version,
  onDeviceCode = null,
  onLinkVerified = null,
  onFreshSmpSpawned = null
) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🤖 Starting bot`);
  console.log(`  Discord ID : ${discordId}`);
  console.log(`  MC User    : ${minecraftUser}`);
  console.log(`  Server     : ${serverAddress}`);
  console.log(`  Version    : ${version}`);
  console.log(`  Auth mode  : microsoft`);

  const botId = makeBotId(discordId, minecraftUser);
  handledAuthErrors.delete(botId);

  if (activeBots.has(botId)) {
    const existing = activeBots.get(botId);
    console.warn(
      `[botmanager] ⚠️ Bot for ${minecraftUser} already active on ` +
      `${existing.serverHost}:${existing.serverPort}`
    );
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return {
      success: false,
      reason: "already_running",
      serverAddress: `${existing.serverHost}:${existing.serverPort}`,
    };
  }

  if (MAX_BOTS > 0 && activeBots.size >= MAX_BOTS) {
    console.warn(`[botmanager] ⚠️ Max bot limit reached (${MAX_BOTS})`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "max_bots_reached", max: MAX_BOTS };
  }

  const { host, port } = parseServerAddress(serverAddress);
  const hostLower = host.toLowerCase();

  // ── Version resolution ──────────────────────────────────────────────────────
  // Priority:
  //   1. Profile's fixed version (e.g. DonutSMP always uses 1.21.11)
  //   2. Explicit version passed by caller (if not "auto")
  //   3. Version cache (last known-good for this host)
  //   4. First auto-detection candidate

  const profile = getProfileForHost(hostLower);
  const profileVersion = profile.version; // "auto" or a fixed version string

  const requestedVersion = String(version || "auto").trim().toLowerCase();

  let effectiveVersion;
  let autoMode = false;

  if (profileVersion !== "auto") {
    // Profile mandates a fixed version — always use it, ignore caller's request
    effectiveVersion = profileVersion;
    if (requestedVersion !== "auto" && requestedVersion !== profileVersion) {
      console.warn(
        `[botmanager] 🛡️ Version override by profile (${profile.id}): ` +
        `caller requested ${requestedVersion} → using ${profileVersion}`
      );
    }
  } else if (requestedVersion !== "auto") {
    // Caller specified a concrete version and the profile has no preference
    effectiveVersion = requestedVersion;
  } else {
    // Full auto-detection
    autoMode = true;
    effectiveVersion = versionCache.get(hostLower) || AUTO_VERSION_CANDIDATES[0];
  }

  let autoVersionIndex = autoMode
    ? Math.max(0, AUTO_VERSION_CANDIDATES.indexOf(effectiveVersion))
    : -1;

  const tokenDir = ensureAccountDir(minecraftUser);

  const entry = {
    botId,
    discordId,
    minecraftUser,
    serverHost: host,
    serverPort: port,
    version: effectiveVersion,
    profile,
    startedAt: new Date().toISOString(),
    status: "connecting",
    spawnError: null,
    spawnTimeoutId: null,
    deviceCodeEmitted: false,
    bot: null,
    connectedSince: null,
    lastKickReason: null,
    errorCategory: null,
    // Profile-specific state — profiles may add their own fields to entry
    donutSmpVerificationRetries: 0,
    donutSmpReadyAt: 0,
    freshSmpGamemode: null,
    freshSmpQueueSent: false,
  };

  activeBots.set(botId, entry);

  // Hunger state persists across reconnects for this bot session
  let isEating = false;
  let eatCooldownUntil = 0;

  // Spawn timeout — longer for servers with a verification handshake (e.g. DonutSMP)
  const initialSpawnTimeoutMs = profile.id === "donutsmp" ? 90000 : 30000;

  entry.spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(botId)) return;
    const e = activeBots.get(botId);
    if (e.status !== "connecting") return;
    if (e.deviceCodeEmitted) return; // auth timeout handled separately
    console.warn(
      `[botmanager] ⏰ Spawn timeout for ${minecraftUser} after ` +
      `${Math.round(initialSpawnTimeoutMs / 1000)}s — cleaning up`
    );
    e.spawnError =
      profile.id === "donutsmp"
        ? "DonutSMP security check timed out. Please confirm the login via the " +
          "DonutSMP Discord bot DM, then try /mcbot start again."
        : "Bot failed to connect within 30 seconds. The server may be offline.";
    e.status = "error";
    if (profile.id === "donutsmp") e.errorCategory = "donutsmp_verification";
    setTimeout(() => cleanupBot(botId, "spawn_timeout"), 30000);
  }, initialSpawnTimeoutMs);

  // ── spawnBot ─────────────────────────────────────────────────────────────────
  function spawnBot(versionToTry) {
    entry.version = versionToTry;
    entry.connectedSince = null;

    // Hard-destroy any previous instance before spawning a new one
    if (entry.bot) {
      const old = entry.bot;
      entry.bot = null;
      hardDestroyBot(old);
    }

    // Base options shared by all profiles
    const baseOptions = {
      host,
      port,
      username: minecraftUser,
      version: versionToTry,
      auth: "microsoft",
      profilesFolder: tokenDir,
      onMsaCode: (data) => handleDeviceCode(minecraftUser, onDeviceCode, data, botId),
    };

    // Allow the profile to inject additional createBot options (e.g. keepAlive: false)
    const clientOptions = typeof profile.buildClientOptions === "function"
      ? profile.buildClientOptions(baseOptions)
      : baseOptions;

    let bot;
    try {
      bot = mineflayer.createBot(clientOptions);
    } catch (err) {
      console.error(
        `[botmanager] ❌ mineflayer.createBot threw for ${minecraftUser}:`,
        err.message
      );
      entry.status = "error";
      entry.spawnError = `Failed to create bot: ${err.message}`;
      cleanupBot(botId, "create_error");
      return;
    }

    entry.bot = bot;

    // Guard — ensures stale events from a superseded bot instance are ignored
    function isCurrentBot() {
      return activeBots.has(botId) && entry.bot === bot;
    }

    // ── Delegate to profile: post-creation setup ──────────────────────────────
    try {
      profile.onBotCreated(bot, entry, botId, spawnBot);
    } catch (err) {
      console.error(
        `[botmanager] ❌ profile.onBotCreated threw for ${minecraftUser}:`,
        err.message
      );
    }

    // ── Hunger ────────────────────────────────────────────────────────────────
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
          `[botmanager] 🍖 ${minecraftUser} ate ${foodItem.name} (food: ${bot.food}/20)`
        );
      } catch {
        // Ignore eating errors — not critical
      } finally {
        isEating = false;
      }
    }

    bot.on("health", () => {
      if (!isCurrentBot()) return;
      if (bot.food < 18) tryEat().catch(() => {});
    });

    // ── Login ─────────────────────────────────────────────────────────────────
    bot.once("login", () => {
      if (!isCurrentBot()) return;
      console.log(
        `[botmanager] ✅ Bot logged in: ${minecraftUser} on ${host}:${port} (${versionToTry})`
      );

      const e = activeBots.get(botId);

      // Clear spawn timeout on first successful login for non-DonutSMP servers.
      // DonutSMP leaves the outer timeout running until the verification window passes.
      if (profile.id !== "donutsmp" && e.spawnTimeoutId) {
        clearTimeout(e.spawnTimeoutId);
        e.spawnTimeoutId = null;
      }

      e.status = "online";
      e.version = versionToTry;
      e.connectedSince = Date.now();

      if (autoMode) {
        versionCache.set(hostLower, versionToTry);
        saveVersionCache();
      }

      saveToken(minecraftUser);

      // Delegate to profile: post-login setup, callbacks, etc.
      try {
        profile.onLogin(bot, e, botId, spawnBot, {
          onLinkVerified,
          onFreshSmpSpawned,
        });
      } catch (err) {
        console.error(
          `[botmanager] ❌ profile.onLogin threw for ${minecraftUser}:`,
          err.message
        );
      }
    });

    // ── Spawn ─────────────────────────────────────────────────────────────────
    bot.once("spawn", () => {
      if (!isCurrentBot()) return;
      try {
        profile.onSpawn(bot, activeBots.get(botId) || entry, botId);
      } catch (_) {}
    });

    // ── Kicked ────────────────────────────────────────────────────────────────
    bot.on("kicked", (reason) => {
      if (!isCurrentBot()) return;
      const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
      console.warn(`[botmanager] 🦵 Bot kicked (${minecraftUser}): ${reasonText}`);

      const e = activeBots.get(botId);

      // Record for status reporting
      e.lastKickReason = reasonText;

      // Delegate to profile first
      let profileHandled = false;
      try {
        const autoVersionState = { index: autoVersionIndex };
        profileHandled = profile.onKick(
          bot, e, botId, reasonText, spawnBot,
          autoMode, AUTO_VERSION_CANDIDATES, autoVersionState
        );
        autoVersionIndex = autoVersionState.index;
      } catch (err) {
        console.error(`[botmanager] ❌ profile.onKick threw:`, err.message);
      }

      if (profileHandled) return;

      // Default: try version rotation on "outdated" kicks, then reconnect/stop
      if (autoMode && shouldRotateVersion(reasonText)) {
        autoVersionIndex++;
        if (autoVersionIndex < AUTO_VERSION_CANDIDATES.length) {
          const nextVersion = AUTO_VERSION_CANDIDATES[autoVersionIndex];
          console.log(
            `[botmanager] 🔄 Auto-version rotate: trying ${nextVersion} for ${minecraftUser}`
          );
          spawnBot(nextVersion);
          return;
        }
      }

      e.status = "error";
      e.spawnError = `Kicked: ${reasonText}`;

      if (AUTO_RECONNECT) {
        console.log(
          `[botmanager] 🔄 Reconnecting ${minecraftUser} in ${RECONNECT_DELAY_MS}ms...`
        );
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          spawnBot(activeBots.get(botId).version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "kicked");
      }
    });

    // ── Error ─────────────────────────────────────────────────────────────────
    bot.on("error", (err) => {
      if (!isCurrentBot()) return;
      const e = activeBots.get(botId);
      const errCode = err.code;
      const errMessage = err.message || "";

      // Delegate to profile first
      let profileHandled = false;
      try {
        profileHandled = profile.onError(bot, e, botId, err, spawnBot);
      } catch (profileErr) {
        console.error(`[botmanager] ❌ profile.onError threw:`, profileErr.message);
      }

      if (profileHandled) return;

      console.error(`[botmanager] ❌ Bot error (${minecraftUser}):`, errMessage);

      // Auth error dedup
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
        e.spawnError =
          "Microsoft authentication failed. Run /mcbot start again to sign in.";
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

      // Suppress stale keepalive timeout when already in a non-active state
      if (
        errMessage.includes("timed out") &&
        e.status !== "online" &&
        e.status !== "connecting"
      ) {
        console.warn(
          `[botmanager] 🔇 Suppressing stale keepalive timeout for ${minecraftUser} ` +
          `(status: ${e.status})`
        );
        return;
      }

      e.status = "error";
      e.spawnError = errMessage;

      if (AUTO_RECONNECT) {
        console.log(
          `[botmanager] 🔄 Reconnecting ${minecraftUser} in ${RECONNECT_DELAY_MS}ms (error)...`
        );
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          spawnBot(activeBots.get(botId).version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "error");
      }
    });

    // ── End ───────────────────────────────────────────────────────────────────
    bot.on("end", (reason) => {
      if (!isCurrentBot()) return;
      const e = activeBots.get(botId);

      // Only act when in an active state; "reconnecting" means a retry is already scheduled
      if (e.status !== "online" && e.status !== "connecting") return;

      console.log(`[botmanager] 🔌 Bot disconnected (${minecraftUser}): ${reason}`);

      // Delegate to profile first
      let profileHandled = false;
      try {
        profileHandled = profile.onEnd(bot, e, botId, reason, spawnBot);
      } catch (profileErr) {
        console.error(`[botmanager] ❌ profile.onEnd threw:`, profileErr.message);
      }

      if (profileHandled) return;

      // Default disconnect handling
      e.status = "error";
      e.spawnError = `Disconnected: ${reason}`;

      if (AUTO_RECONNECT) {
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          spawnBot(activeBots.get(botId).version);
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
// STOP / CLEANUP
// ============================================================

function stopBot(discordId, minecraftUser) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(
    `[botmanager] 🛑 Stopping bot — discordId: ${discordId}, mc: ${minecraftUser}`
  );
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

function stopBotsForUser(discordId) {
  console.log(`[botmanager] 🛑 Stopping all bots for discordId: ${discordId}`);
  const prefix = `${discordId}:`;
  let count = 0;
  for (const botId of [...activeBots.keys()]) {
    if (botId.startsWith(prefix)) {
      cleanupBot(botId, "stop_user_all");
      count++;
    }
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

  // Remove from registry BEFORE destroying so events fired during destruction
  // fail the isCurrentBot() / activeBots.has() checks and are silently dropped
  activeBots.delete(botId);

  recordEndedBot(entry, reason);

  // Notify the profile so it can cancel its own pending timers/promises
  try {
    entry.profile.onCleanup(botId);
  } catch (_) {}

  if (entry.bot) {
    const botToDestroy = entry.bot;
    entry.bot = null;
    hardDestroyBot(botToDestroy);
  }

  console.log(
    `[botmanager] 🧹 Cleaned up bot for ${entry.minecraftUser} (reason: ${reason})`
  );
}

// ============================================================
// STATUS / LIST
// ============================================================

function getBotStatus(discordId, minecraftUser) {
  const botId = makeBotId(discordId, minecraftUser);
  const entry = activeBots.get(botId);
  if (!entry) return { found: false };

  return {
    found: true,
    bot: _entryToStatus(entry),
  };
}

function getBotsForUser(discordId) {
  const prefix = `${discordId}:`;
  const bots = [];
  for (const [botId, entry] of activeBots.entries()) {
    if (botId.startsWith(prefix)) bots.push(_entryToStatus(entry));
  }
  return bots;
}

function getBotCount() {
  return activeBots.size;
}

function listAllBots() {
  return [...activeBots.values()].map(_entryToStatus);
}

function _entryToStatus(entry) {
  return {
    botId:          entry.botId,
    discordId:      entry.discordId,
    minecraftUser:  entry.minecraftUser,
    serverHost:     entry.serverHost,
    serverPort:     entry.serverPort,
    version:        entry.version,
    profile:        entry.profile.id,
    startedAt:      entry.startedAt,
    status:         entry.status,
    spawnError:     entry.spawnError || null,
    errorCategory:  entry.errorCategory || null,
    lastKickReason: entry.lastKickReason || null,
    uptimeSeconds:  Math.floor(
      (Date.now() - new Date(entry.startedAt).getTime()) / 1000
    ),
    // DonutSMP-specific
    donutSmpVerificationRetries: entry.donutSmpVerificationRetries || undefined,
    // FreshSMP-specific
    freshSmpGamemode:   entry.freshSmpGamemode  || null,
    freshSmpQueueSent:  entry.freshSmpQueueSent || false,
  };
}

// ============================================================
// PROFILE-SPECIFIC PASS-THROUGHS
// ============================================================

function sendFreshSmpQueueCommand(botId, gamemode) {
  const { profiles } = require("./afk-core/src/index");
  const freshSmpProfile = profiles.freshsmp;

  // Try resolving the pending selection promise first
  const selectionResult = freshSmpProfile.selectGamemode(botId, gamemode);
  if (selectionResult.success) return selectionResult;

  // Promise already resolved or bot is past the selection window — send directly
  return freshSmpProfile.sendQueueCommand(activeBots, botId, gamemode);
}

module.exports = {
  makeBotId,
  startBot,
  stopBot,
  stopBotsForUser,
  stopAllBots,
  getBotStatus,
  getBotsForUser,
  listAllBots,
  getBotCount,
  getAndClearRecentlyEnded,
  sendFreshSmpQueueCommand,
};