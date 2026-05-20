"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * HypixelProfile
 *
 * ALL Hypixel-specific logic lives here:
 *   - Version: 1.8.9 by default (also supports modern clients)
 *   - Ping/pong handling
 *   - Hunger management (skipped on 1.8.x by HungerHandler internally)
 *
 * Extend this class with Watchdog-specific handling as needed.
 */

const HYPIXEL_VERSION = "1.8.9";

class HypixelProfile extends BaseProfile {
  constructor() {
    super("hypixel", ["1.8.9", "1.21.11"]);
    this._hungerHandler = null;
  }

  getVersion() {
    return HYPIXEL_VERSION;
  }

  buildClientOptions(baseOptions, session) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, session) {
    const version = (session && session.version) ? String(session.version) : HYPIXEL_VERSION;
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    client.on("ping", (packet) => {
      try {
        client.write("pong", { id: packet.id });
      } catch (_) {}
    });

    client.on("plugin_message", () => {
      // Future: handle Hypixel channels if needed
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;
    if (this._hungerHandler) this._hungerHandler.tick(client);
  }
}

module.exports = { HypixelProfile, HYPIXEL_VERSION };