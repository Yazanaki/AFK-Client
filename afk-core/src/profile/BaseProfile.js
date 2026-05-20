"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * DefaultProfile — used for any server that doesn't match a specific profile.
 *
 * Behaviour:
 *   - Version: uses whatever is passed in (auto-detection in botmanager)
 *   - Handles ping/pong for Paper servers
 *   - Hunger management via HungerHandler
 */
class DefaultProfile extends BaseProfile {
  constructor() {
    super("default", ["1.21.4"]);
    this._hungerHandler = null;
  }

  buildClientOptions(baseOptions, session) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, session) {
    const version = (session && session.version) ? String(session.version) : "1.21.4";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    client.on("ping", (packet) => {
      try {
        client.write("pong", { id: packet.id });
      } catch (_) {}
    });

    client.on("keep_alive", () => {
      // minecraft-protocol handles responding automatically
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;
    if (this._hungerHandler) this._hungerHandler.tick(client);
  }
}

module.exports = { DefaultProfile };