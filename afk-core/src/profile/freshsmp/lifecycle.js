// afk-core/src/profile/freshsmp/lifecycle.js
"use strict";

// FreshSMP lifecycle logger (ALWAYS ON, not gated by FRESHSMP_DEBUG).
// Prints one timestamped line per connection lifecycle event so in-game
// behaviour can be correlated with the connection, and dumps the last ~25
// outgoing packets (entry._recentOut, populated by settings.js) whenever the
// connection drops to configuration — i.e. right before an "Invalid sequence".

const FRESHSMP_DEBUG =
  String(process.env.FRESHSMP_DEBUG || "minimal").toLowerCase() === "forensic";

// Flatten a prismarine-nbt chat component into readable plain text.
function chatText(node) {
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
    if (node.text      !== undefined) out += chatText(node.text);
    if (node.extra     !== undefined) out += chatText(node.extra);
    if (node.with      !== undefined) out += " " + chatText(node.with);
    return out;
  }
  return "";
}

function installLifecycleLogger(bot, entry) {
  const _life = (msg) =>
    console.log(`[fresh-life] ${new Date().toISOString()} [${entry.minecraftUser}] ${msg}`);

  // Incoming packet logger (forensic mode only).
  if (FRESHSMP_DEBUG) {
    bot._client.on("packet", (data, meta) => {
      try {
        console.log(`[fresh-pkt] ← SERVER [${meta.state}]: ${meta.name}`, JSON.stringify(data).slice(0, 160));
      } catch {
        console.log(`[fresh-pkt] ← SERVER [${meta.state}]: ${meta.name} (binary)`);
      }
    });
  }

  // Ring buffer is created by index.js (onBotCreated) and filled by settings.js.
  const _recentOut = entry._recentOut || (entry._recentOut = []);

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

  bot._client.on("login", (packet) => {
    const world = packet?.worldName ?? packet?.dimension ?? "unknown";
    _life(`▶ JOINED world="${world}" (entityId=${packet?.entityId}, gamemode=${packet?.gameMode ?? packet?.previousGameMode})`);
  });

  bot._client.on("transfer", (p) => {
    _life(`➡️ TRANSFER packet → ${p?.host}:${p?.port}`);
  });

  bot._client.on("system_chat", (p) => {
    try {
      const txt = chatText(p?.content).replace(/§./g, "").replace(/\s+/g, " ").trim();
      if (!txt) return;
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
  bot._client.on("respawn", () => _life(`← server sent RESPAWN packet (gamemode/world change)`));
  bot._client.on("combat_death", (p) => {
    try { _life(`☠️ COMBAT_DEATH message=${JSON.stringify(p?.message)}`); }
    catch { _life(`☠️ COMBAT_DEATH`); }
  });
}

module.exports = { installLifecycleLogger, chatText };
