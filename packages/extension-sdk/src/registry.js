"use strict";

const {
  normalizeExtensionManifest,
  ExtensionManifestError,
} = require("./manifest");
const {
  normalizePermissions,
} = require("./permissions");

function createExtensionRegistry() {
  const entries = new Map();

  function register(input) {
    const manifest = normalizeExtensionManifest(input, normalizePermissions);
    const existing = entries.get(manifest.id);
    if (existing) {
      if (existing.version === manifest.version) {
        return Object.freeze({
          registered: false,
          idempotent: true,
          manifest: existing,
        });
      }
      throw new ExtensionManifestError("ERR_EXTENSION_ID_CONFLICT", {
        id: manifest.id,
        existing_version: existing.version,
        requested_version: manifest.version,
      });
    }
    entries.set(manifest.id, manifest);
    return Object.freeze({
      registered: true,
      idempotent: false,
      manifest,
    });
  }

  function get(id) {
    return entries.get(id) || null;
  }

  function list() {
    return Object.freeze(
      [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  return Object.freeze({ register, get, list });
}

module.exports = {
  createExtensionRegistry,
};
