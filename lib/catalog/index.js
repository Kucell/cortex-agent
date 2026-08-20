"use strict";

// ─── catalog — single export surface for 4-kind catalog operations ──────────
//
// Re-exports the foundational modules of lib/catalog/* so callers can do:
//   const { KINDS, readLockfile, upsertEntry, loadAllKinds } = require("./catalog");
//
// Pure module — no I/O at import time.

const kindMap = require("./kind-map");
const lockfile = require("./lockfile");
const registry = require("./registry");

module.exports = {
  // kind-map
  KINDS: kindMap.KINDS,
  KIND_LIST: kindMap.KIND_LIST,
  getKind: kindMap.getKind,
  hasKind: kindMap.hasKind,
  resolveInstallPath: kindMap.resolveInstallPath,
  resolveLicense: kindMap.resolveLicense,
  kindFromPath: kindMap.kindFromPath,
  getStarterIds: kindMap.getStarterIds,
  STARTER_IDS: kindMap.STARTER_IDS,
  requiredFiles: kindMap.requiredFiles,

  // lockfile
  readLockfile: lockfile.readLockfile,
  writeLockfile: lockfile.writeLockfile,
  migrateV1ToV2: lockfile.migrateV1ToV2,
  upsertEntry: lockfile.upsertEntry,
  removeEntry: lockfile.removeEntry,
  findEntry: lockfile.findEntry,
  listByKind: lockfile.listByKind,
  emptyV2Lockfile: lockfile.emptyV2Lockfile,
  getLockfilePath: lockfile.getLockfilePath,
  getLegacyLockfilePath: lockfile.getLegacyLockfilePath,

  // registry
  loadAllKinds: registry.loadAllKinds,
  loadAllKindsAsync: registry.loadAllKindsAsync,
  findById: registry.findById,
  listKind: registry.listKind,
  indexDigest: registry.indexDigest,
  DEFAULT_UPSTREAM: registry.DEFAULT_UPSTREAM,
};