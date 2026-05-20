"use strict";

/**
 * profiles/index.js — Profile Registry
 *
 * Single source of truth for:
 *   1. Which host patterns map to which profile
 *   2. Whether a server uses a fixed version or auto-detection
 *   3. Profile instance singletons (one per profile type)
 *
 * To add a new server:
 *   1. Create profiles/YourServerProfile.js extending BaseProfile
 *   2. Add an entry to HOST_PROFILES below
 *   3. That's it — botmanager and server.js pick it up automatically
 */

const { DefaultProfile } = require("./DefaultProfile");
const { DonutSmpProfile } = require("./DonutSmpProfile");
const { FreshSmpProfile } = require("./FreshSmpProfile");
const { HypixelProfile } = require("./HypixelProfile");

// ─── Profile singletons ────────────────────────────────────────────────────────
// We use singletons so that stateful profiles (e.g. FreshSmpProfile with its
// pending gamemode map) are shared across the lifetime of the process.

const profiles = {
  default:  new DefaultProfile(),
  donutsmp: new DonutSmpProfile(),
  freshsmp: new FreshSmpProfile(),
  hypixel:  new HypixelProfile(),
};

// ─── Host pattern → profile mapping ───────────────────────────────────────────
// Patterns are matched case-insensitively against the server hostname.
// First match wins — put more specific patterns before generic ones.

const HOST_PROFILES = [
  { patterns: ["donutsmp.net", "donutsmp"],          profileId: "donutsmp" },
  { patterns: ["freshsmp.net", "freshsmp",
               "elementalmc.live",
               "play.elementalmc.live"],             profileId: "freshsmp" },
  { patterns: ["hypixel.net", "hypixel"],            profileId: "hypixel"  },
];

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve which profile to use for a given server host.
 *
 * @param {string} host - server hostname (e.g. "mc.donutsmp.net")
 * @returns {BaseProfile} - the matching profile, or DefaultProfile if none matches
 */
function getProfileForHost(host) {
  const lower = String(host || "").toLowerCase();

  for (const { patterns, profileId } of HOST_PROFILES) {
    if (patterns.some((p) => lower.includes(p))) {
      return profiles[profileId];
    }
  }

  return profiles.default;
}

/**
 * Get a profile by its explicit ID string.
 * Returns DefaultProfile if the ID is unknown.
 *
 * @param {string} id
 * @returns {BaseProfile}
 */
function getProfileById(id) {
  return profiles[String(id || "").toLowerCase()] || profiles.default;
}

/**
 * Check whether a hostname maps to a profile with a fixed (non-auto) version.
 * If true, callers should use profile.version directly rather than auto-detecting.
 *
 * @param {string} host
 * @returns {boolean}
 */
function hostHasFixedVersion(host) {
  const profile = getProfileForHost(host);
  return profile.version !== "auto";
}

/**
 * Return the version string botmanager should use for this host.
 * If the profile has a fixed version, returns that.
 * Otherwise returns "auto" to trigger version auto-detection in botmanager.
 *
 * @param {string} host
 * @returns {string}
 */
function getVersionForHost(host) {
  const profile = getProfileForHost(host);
  return profile.version; // "auto" for DefaultProfile, fixed string for others
}

module.exports = {
  profiles,
  getProfileForHost,
  getProfileById,
  hostHasFixedVersion,
  getVersionForHost,
};