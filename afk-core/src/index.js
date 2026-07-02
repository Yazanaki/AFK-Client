"use strict";

/**
 * afk-core/src/index.js — Profile Registry
 *
 * Single source of truth for:
 *   1. Which host patterns map to which profile
 *   2. Whether a server uses a fixed version or auto-detection
 *   3. Profile instance singletons (one per profile type)
 *
 * To add a new server:
 *   1. Create a profile file in this directory extending BaseProfile
 *   2. Add an entry to HOST_PROFILES below
 *   3. That's it — botmanager and server.js pick it up automatically
 */

const { DefaultProfile }  = require("./profile/DefaultProfile");
const { DonutSmpProfile } = require("./profile/donutsmp");
const { FreshSmpProfile } = require("./profile/freshsmp");
const { ElementalMcProfile } = require("./profile/elementalmc");
const { HypixelProfile }  = require("./profile/HypixelProfile");

// ─── Profile singletons ────────────────────────────────────────────────────────
const profiles = {
  default:    new DefaultProfile(),
  donutsmp:   new DonutSmpProfile(),
  freshsmp:   new FreshSmpProfile(),
  elementalmc: new ElementalMcProfile(),
  hypixel:    new HypixelProfile(),
};

// ─── Host pattern → profile mapping ───────────────────────────────────────────
const HOST_PROFILES = [
  {
    patterns:  ["donutsmp.net", "donutsmp"],
    profileId: "donutsmp",
  },
  {
    patterns:  ["freshsmp.net", "freshsmp.fun", "freshsmp"],
    profileId: "freshsmp",
  },
  {
    patterns:  ["elementalmc.live", "play.elementalmc.live", "elementalmc"],
    profileId: "elementalmc",
  },
  {
    patterns:  ["hypixel.net", "hypixel"],
    profileId: "hypixel",
  },
  {
    patterns:  ["minehut.com", "minehut", "korraemc"],
    profileId: "minehut",
  },
];

function getProfileForHost(host) {
  const lower = String(host || "").toLowerCase();
  for (const { patterns, profileId } of HOST_PROFILES) {
    if (patterns.some((p) => lower.includes(p.toLowerCase()))) {
      return profiles[profileId];
    }
  }
  return profiles.default;
}

function getProfileById(id) {
  return profiles[String(id || "").toLowerCase()] || profiles.default;
}

function hostHasFixedVersion(host) {
  return getProfileForHost(host).version !== "auto";
}

function getVersionForHost(host) {
  return getProfileForHost(host).version;
}

module.exports = {
  profiles,
  getProfileForHost,
  getProfileById,
  hostHasFixedVersion,
  getVersionForHost,
};