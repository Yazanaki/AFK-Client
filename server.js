// yazanaki/mcbot/server.js (VPS-side)
// Express API server — receives bot commands from KenzAI Discord Bot.
//
// This file is intentionally free of server-specific logic (version overrides,
// host pattern checks, anti-cheat behaviour). All of that lives in the profile
// files under profiles/. Add a new server by creating profiles/YourProfile.js
// and registering it in profiles/index.js.

"use strict";

// ============================================================
// SUPPRESS PARTIAL-PACKET NOISE FROM node-minecraft-protocol
// ============================================================
const _origLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("Chunk size is")) return;
  _origLog(...args);
};
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("Chunk size is")) return;
  _origWarn(...args);
};

require("dotenv").config();

const express = require("express");

const {
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
} = require("./botmanager");

const { getProfileForHost } = require("./profiles/index");

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "4823", 10);
const API_KEY = process.env.API_KEY;

if (!API_KEY || API_KEY.trim() === "" || API_KEY === "REPLACE_WITH_A_LONG_RANDOM_SECRET") {
  console.error("❌ FATAL: API_KEY is not set in .env. Refusing to start.");
  process.exit(1);
}

// ============================================================
// PENDING DEVICE CODES
// Map<botId, { userCode, verificationUri, expiresAt }>
// ============================================================
const pendingDeviceCodes = new Map();

// ============================================================
// PENDING LINK VERIFICATION
// Map<discordId, { mcUsername, createdAt }>
// ============================================================
const pendingLinkVerified = new Map();
const LINK_VERIFIED_EXPIRY_MS = 5 * 60 * 1000;

// ============================================================
// PENDING FRESHSMP SPAWNED NOTIFICATIONS
// Map<botId, { discordId, minecraftUser, serverHost, createdAt }>
// Consumed once by the Discord bot's poll loop.
// ============================================================
const pendingFreshSmpSpawned = new Map();
const FRESHSMP_SPAWNED_EXPIRY_MS = 10 * 60 * 1000;

// ============================================================
// MIDDLEWARE — API Key Auth
// ============================================================

function requireApiKey(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  if (!token || token !== API_KEY) {
    console.warn(`[server] 🚫 Unauthorized request from ${req.ip} — ${req.method} ${req.path}`);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

app.use(requireApiKey);

// ============================================================
// ROUTE: Health Check
// GET /ping
// ============================================================

app.get("/ping", (req, res) => {
  res.json({ ok: true, activeBots: getBotCount(), timestamp: new Date().toISOString() });
});

// ============================================================
// ROUTE: Start Bot
// POST /start
// Body: { discordId, minecraftUser, serverAddress, version?, forLinkVerification? }
//
// `version` is optional. If omitted or "auto", the profile for the target
// server decides the version (fixed or auto-detected). If provided and the
// profile has a fixed version, the profile's version always wins — a warning
// is logged in botmanager.
// ============================================================

app.post("/start", (req, res) => {
  const { discordId, minecraftUser, serverAddress, version, forLinkVerification } = req.body;

  console.log(
    `[server] 📥 POST /start — discordId=${discordId} mc=${minecraftUser} ` +
    `server=${serverAddress} v=${version || "auto"} linkOnly=${!!forLinkVerification}`
  );

  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }
  if (!minecraftUser || typeof minecraftUser !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid minecraftUser" });
  }
  if (!serverAddress || typeof serverAddress !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid serverAddress" });
  }

  const botId = makeBotId(discordId.trim(), minecraftUser.trim());

  // Clear stale pending state from any previous run for this bot
  pendingDeviceCodes.delete(botId);
  pendingFreshSmpSpawned.delete(botId);

  // ── Callbacks ──────────────────────────────────────────────────────────────

  const onDeviceCode = (userCode, verificationUri, expiresIn) => {
    // Enforce a 5-minute maximum TTL regardless of what the auth server says
    const ENFORCED_TTL_SEC = 5 * 60;
    const effectiveExpiresIn = Math.min(
      typeof expiresIn === "number" ? expiresIn : ENFORCED_TTL_SEC,
      ENFORCED_TTL_SEC
    );
    const expiresAt = Date.now() + effectiveExpiresIn * 1000;
    const existing = pendingDeviceCodes.get(botId);
    if (existing && existing.userCode !== userCode) {
      console.log(
        `[server] 🔄 Updated device code for ${botId}: ${existing.userCode} → ${userCode}`
      );
    }
    pendingDeviceCodes.set(botId, { userCode, verificationUri, expiresAt });
    console.log(`[server] 🔐 Device code stored for ${botId}: ${userCode}`);
  };

  const onLinkVerified = forLinkVerification
    ? (did, mcUsername) => {
        pendingLinkVerified.set(String(did).trim(), {
          mcUsername,
          createdAt: Date.now(),
        });
        console.log(`[server] 🔗 Link verified for ${did}: MC username ${mcUsername}`);
      }
    : null;

  // Determine whether this server uses a FreshSMP profile so we know
  // whether to set up the spawned-notification callback.
  const serverProfile = getProfileForHost(serverAddress.trim());
  const onFreshSmpSpawned =
    serverProfile.id === "freshsmp"
      ? (firedBotId) => {
          pendingFreshSmpSpawned.set(firedBotId, {
            discordId:    discordId.trim(),
            minecraftUser: minecraftUser.trim(),
            serverHost:   serverAddress.trim(),
            createdAt:    Date.now(),
          });
          console.log(
            `[server] 🟢 FreshSMP bot spawned and ready for gamemode selection: ${firedBotId}`
          );
        }
      : null;

  // ── Start the bot ──────────────────────────────────────────────────────────

  const result = startBot(
    discordId.trim(),
    minecraftUser.trim(),
    serverAddress.trim(),
    version ? String(version).trim() : "auto",
    onDeviceCode,
    onLinkVerified,
    onFreshSmpSpawned
  );

  if (!result.success) {
    const statusCode = result.reason === "already_running" ? 409 : 500;
    return res.status(statusCode).json({ ok: false, ...result });
  }

  return res.status(200).json({
    ok: true,
    message: "Bot started",
    discordId,
    minecraftUser,
    profile: serverProfile.id,
  });
});

// ============================================================
// ROUTE: Check for Pending Device Code
// GET /devicecode/:discordId/:minecraftUser
// ============================================================

app.get("/devicecode/:discordId/:minecraftUser", (req, res) => {
  const discordId    = req.params.discordId.trim();
  const minecraftUser = req.params.minecraftUser.trim();
  const botId = makeBotId(discordId, minecraftUser);

  console.log(`[server] 📥 GET /devicecode/${botId}`);

  const entry = pendingDeviceCodes.get(botId);
  if (!entry) return res.status(404).json({ ok: false, pending: false });

  if (Date.now() > entry.expiresAt) {
    pendingDeviceCodes.delete(botId);
    return res.status(404).json({ ok: false, pending: false, reason: "expired" });
  }

  return res.status(200).json({
    ok: true,
    pending: true,
    userCode:        entry.userCode,
    verificationUri: entry.verificationUri,
    expiresAt:       entry.expiresAt,
  });
});

// ============================================================
// ROUTE: Clear Device Code
// DELETE /devicecode/:discordId/:minecraftUser
// ============================================================

app.delete("/devicecode/:discordId/:minecraftUser", (req, res) => {
  const botId = makeBotId(
    req.params.discordId.trim(),
    req.params.minecraftUser.trim()
  );
  pendingDeviceCodes.delete(botId);
  return res.status(200).json({ ok: true });
});

// ============================================================
// ROUTE: Get link verification result
// GET /link/verified/:discordId
// ============================================================

app.get("/link/verified/:discordId", (req, res) => {
  const discordId = req.params.discordId.trim();
  const entry = pendingLinkVerified.get(discordId);

  if (!entry) return res.status(404).json({ ok: false, reason: "no_result" });

  if (Date.now() - entry.createdAt > LINK_VERIFIED_EXPIRY_MS) {
    pendingLinkVerified.delete(discordId);
    return res.status(404).json({ ok: false, reason: "expired" });
  }

  pendingLinkVerified.delete(discordId);
  return res.status(200).json({ ok: true, mcUsername: entry.mcUsername });
});

// ============================================================
// ROUTE: Check for FreshSMP gamemode selector trigger
// GET /freshsmp/spawned/:discordId/:minecraftUser
//
// Consume-once — entry is deleted on successful read.
// ============================================================

app.get("/freshsmp/spawned/:discordId/:minecraftUser", (req, res) => {
  const botId = makeBotId(
    req.params.discordId.trim(),
    req.params.minecraftUser.trim()
  );

  const entry = pendingFreshSmpSpawned.get(botId);
  if (!entry) return res.status(404).json({ ok: false, pending: false });

  if (Date.now() - entry.createdAt > FRESHSMP_SPAWNED_EXPIRY_MS) {
    pendingFreshSmpSpawned.delete(botId);
    return res.status(404).json({ ok: false, pending: false, reason: "expired" });
  }

  pendingFreshSmpSpawned.delete(botId);
  console.log(`[server] 📥 GET /freshsmp/spawned/${botId} — consumed`);

  return res.status(200).json({
    ok:           true,
    pending:      true,
    discordId:    entry.discordId,
    minecraftUser: entry.minecraftUser,
    serverHost:   entry.serverHost,
  });
});

// ============================================================
// ROUTE: Send FreshSMP gamemode selection
// POST /freshsmp/gamemode
// Body: { discordId, minecraftUser, gamemode }
// ============================================================

app.post("/freshsmp/gamemode", (req, res) => {
  const { discordId, minecraftUser, gamemode } = req.body;

  console.log(
    `[server] 📥 POST /freshsmp/gamemode — ` +
    `discordId=${discordId} mc=${minecraftUser} gamemode=${gamemode}`
  );

  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }
  if (!minecraftUser || typeof minecraftUser !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid minecraftUser" });
  }
  if (!gamemode || typeof gamemode !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid gamemode" });
  }

  const result = sendFreshSmpQueueCommand(
    makeBotId(discordId.trim(), minecraftUser.trim()),
    gamemode.trim().toLowerCase()
  );

  if (!result.success) {
    const statusCode = result.reason === "bot_not_found" ? 404 : 400;
    return res.status(statusCode).json({ ok: false, ...result });
  }

  return res.status(200).json({ ok: true, gamemode: result.gamemode });
});

// ============================================================
// ROUTE: Stop Bot
// POST /stop
// Body: { discordId, minecraftUser }
// ============================================================

app.post("/stop", (req, res) => {
  const { discordId, minecraftUser } = req.body;

  console.log(`[server] 📥 POST /stop — discordId=${discordId} mc=${minecraftUser}`);

  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }
  if (!minecraftUser || typeof minecraftUser !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid minecraftUser" });
  }

  const botId = makeBotId(discordId.trim(), minecraftUser.trim());
  pendingDeviceCodes.delete(botId);
  pendingFreshSmpSpawned.delete(botId);

  const result = stopBot(discordId.trim(), minecraftUser.trim());

  if (!result.success) {
    return res.status(404).json({ ok: false, ...result });
  }

  return res.status(200).json({ ok: true, message: "Bot stopped", ...result });
});

// ============================================================
// ROUTE: Get Bot Status (specific account)
// GET /status/:discordId/:minecraftUser
// ============================================================

app.get("/status/:discordId/:minecraftUser", (req, res) => {
  const discordId    = req.params.discordId.trim();
  const minecraftUser = req.params.minecraftUser.trim();

  console.log(`[server] 📥 GET /status/${discordId}/${minecraftUser}`);

  const status = getBotStatus(discordId, minecraftUser);
  if (!status.found) {
    return res.status(404).json({
      ok: false, reason: "no_bot_running", discordId, minecraftUser,
    });
  }

  return res.status(200).json({ ok: true, bot: status.bot });
});

// ============================================================
// ROUTE: List all bots for a user
// GET /bots/:discordId
// ============================================================

app.get("/bots/:discordId", (req, res) => {
  const discordId = req.params.discordId.trim();
  console.log(`[server] 📥 GET /bots/${discordId}`);
  const bots = getBotsForUser(discordId);
  return res.status(200).json({ ok: true, count: bots.length, bots });
});

// ============================================================
// ROUTE: List All Active Bots (Admin)
// GET /list
// ============================================================

app.get("/list", (req, res) => {
  console.log(`[server] 📥 GET /list`);
  const bots = listAllBots();
  return res.status(200).json({ ok: true, count: bots.length, bots });
});

// ============================================================
// ROUTE: Stop All Bots (Admin Emergency)
// POST /stopall
// ============================================================

app.post("/stopall", (req, res) => {
  console.log(`[server] 📥 POST /stopall`);
  pendingDeviceCodes.clear();
  pendingFreshSmpSpawned.clear();
  const result = stopAllBots();
  return res.status(200).json({ ok: true, message: "All bots stopped", ...result });
});

// ============================================================
// ROUTE: Get recently ended bots (for botmonitor DM notifications)
// GET /ended
// ============================================================

app.get("/ended", (req, res) => {
  const bots = getAndClearRecentlyEnded();
  if (bots.length > 0) {
    console.log(`[server] 📥 GET /ended — returning ${bots.length} ended bot(s)`);
  }
  return res.status(200).json({ ok: true, count: bots.length, bots });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[server] ✅ Yazanaki MCBot API running on port ${PORT}`);
  console.log(`[server] 🔐 API key auth: ENABLED`);
  console.log(`[server] 🔑 Auth mode: Microsoft (online mode)`);
  console.log(`[server] 🤖 Max bots: ${process.env.MAX_BOTS || "unlimited"}`);
  console.log(`[server] 🔄 Auto-reconnect: ${process.env.AUTO_RECONNECT || "false"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
});

process.on("SIGINT", () => {
  console.log("\n[server] 🔴 SIGINT received — stopping all bots and shutting down...");
  stopAllBots();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[server] 🔴 SIGTERM received — stopping all bots and shutting down...");
  stopAllBots();
  process.exit(0);
});