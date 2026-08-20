"use strict";

// ─── lockfile v2 — multi-kind catalog lock (P-001 MS-002) ────────────────────
//
// Reads/writes the unified catalog lock. Backward-compatible with v1
// (T-OD-001 `design-systems.lock` `od-design-system-project/v1` schema):
//
//   v1  →  read path: { lockfileVersion: 1, schemaVersion, systems: [] }
//   v2  →  read/write: { lockfileVersion: 2, schemaVersion, catalogs: [] }
//
// On read, v1 locks are auto-migrated in memory to the v2 `catalogs[]` shape
// (each systems[i] becomes a catalogs[i] with kind="design-system").
//
// On write, only v2 is emitted.
//
// Per-kind shape (v2):
//   {
//     "kind": "design-system" | "plugin" | "skill" | "template",
//     "id": "<slug>",
//     "<kind-specific sha fields>",
//     "license": "Apache-2.0",
//     "source": { "type": "upstream" | "local", "origin": "..." },
//     "fetched_at": "ISO-8601"
//   }
//
// Pure file I/O (node:fs); no npm deps. Atomic writes (tmp + rename).

const fs = require("node:fs");
const path = require("node:path");

const LOCKFILE_NAME = "catalog.lock";
const LOCKFILE_VERSION_V2 = 2;
const SCHEMA_VERSION_V1 = "od-design-system-project/v1";
const SCHEMA_VERSION_V2 = "od-catalog-project/v1";
const V1_TO_V2_NOTE = "migrated from v1 (od-design-system-project/v1) by lib/catalog/lockfile.js";

function getLockfilePath(cwd) {
  cwd = cwd || process.cwd();
  return path.join(cwd, ".agent", LOCKFILE_NAME);
}

// Backward-compat: T-OD-001 used `design-systems.lock`.
// We honor the legacy path when reading, but always write the new file.
function getLegacyLockfilePath(cwd) {
  cwd = cwd || process.cwd();
  return path.join(cwd, ".agent", "design-systems.lock");
}

function emptyV2Lockfile(now) {
  return {
    lockfileVersion: LOCKFILE_VERSION_V2,
    schemaVersion: SCHEMA_VERSION_V2,
    fetched_at: now || new Date().toISOString(),
    catalogs: [],
    _migrated_from_v1: false,
  };
}

function readLockfile(cwd, opts) {
  opts = opts || {};
  const now = (opts.now || (() => new Date().toISOString()))();
  const newPath = getLockfilePath(cwd);
  const legacyPath = getLegacyLockfilePath(cwd);

  let raw;
  let source;
  if (fs.existsSync(newPath)) {
    raw = fs.readFileSync(newPath, "utf8");
    source = "v2";
  } else if (fs.existsSync(legacyPath)) {
    raw = fs.readFileSync(legacyPath, "utf8");
    source = "v1";
  } else {
    return emptyV2Lockfile(now);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`lockfile: failed to parse ${source} lock at ${source === "v1" ? legacyPath : newPath}: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`lockfile: ${source} lock root must be a JSON object`);
  }

  if (parsed.lockfileVersion === 2) {
    // Already v2 — return as-is, with safe defaults for missing fields.
    if (!Array.isArray(parsed.catalogs)) parsed.catalogs = [];
    return parsed;
  }

  if (parsed.lockfileVersion === 1) {
    return migrateV1ToV2(parsed, now);
  }

  throw new Error(
    `lockfile: unsupported lockfileVersion ${parsed.lockfileVersion} (expected 1 or 2)`,
  );
}

function migrateV1ToV2(v1, now) {
  if (!Array.isArray(v1.systems)) {
    throw new Error("lockfile: v1 lock missing 'systems[]'");
  }
  const catalogs = v1.systems.map((s) => {
    if (!s || typeof s !== "object") return null;
    return {
      kind: "design-system",
      id: s.id,
      sha256_manifest: s.sha256_manifest,
      sha256_design: s.sha256_design,
      sha256_tokens: s.sha256_tokens,
      license: s.license,
      category: s.category,
      source: s.source || { type: "upstream", origin: v1.upstream },
      fetched_at: s.fetched_at || v1.fetched_at || now,
    };
  }).filter(Boolean);

  return {
    lockfileVersion: LOCKFILE_VERSION_V2,
    schemaVersion: SCHEMA_VERSION_V2,
    fetched_at: v1.fetched_at || now,
    upstream: v1.upstream,
    catalogs,
    _migrated_from_v1: true,
    _v1_migration_note: V1_TO_V2_NOTE,
  };
}

function writeLockfile(cwd, lock, opts) {
  opts = opts || {};
  const out = {
    lockfileVersion: LOCKFILE_VERSION_V2,
    schemaVersion: SCHEMA_VERSION_V2,
    fetched_at: lock.fetched_at || (opts.now || (() => new Date().toISOString()))(),
    upstream: lock.upstream,
    catalogs: Array.isArray(lock.catalogs) ? lock.catalogs : [],
  };
  // Strip migration metadata on write.
  delete out._migrated_from_v1;
  delete out._v1_migration_note;

  const lockPath = getLockfilePath(cwd);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tmpPath = lockPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(out, null, 2), "utf8");
  fs.renameSync(tmpPath, lockPath);
  return { path: lockPath, bytes: fs.statSync(lockPath).size };
}

/**
 * Add or replace an entry by kind+id. Returns a NEW lock object (immutable).
 */
function upsertEntry(lock, entry) {
  if (!entry || !entry.kind || !entry.id) {
    throw new Error("lockfile.upsertEntry: kind and id are required");
  }
  const catalogs = (lock.catalogs || []).filter(
    (e) => !(e.kind === entry.kind && e.id === entry.id),
  );
  catalogs.push({ ...entry, fetched_at: entry.fetched_at || new Date().toISOString() });
  return { ...lock, catalogs };
}

function removeEntry(lock, kind, id) {
  const catalogs = (lock.catalogs || []).filter(
    (e) => !(e.kind === kind && e.id === id),
  );
  return { ...lock, catalogs };
}

function findEntry(lock, kind, id) {
  return (lock.catalogs || []).find((e) => e.kind === kind && e.id === id) || null;
}

function listByKind(lock, kind) {
  return (lock.catalogs || []).filter((e) => e.kind === kind);
}

module.exports = {
  readLockfile,
  writeLockfile,
  migrateV1ToV2,
  upsertEntry,
  removeEntry,
  findEntry,
  listByKind,
  emptyV2Lockfile,
  getLockfilePath,
  getLegacyLockfilePath,
  // exposed for tests
  _internal: { LOCKFILE_VERSION_V2, SCHEMA_VERSION_V1, SCHEMA_VERSION_V2, V1_TO_V2_NOTE },
};