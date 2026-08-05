/**
 * lib/design/lockfile.js
 *
 * Lock file management for installed design systems.
 *
 * Path: <cwd>/.agent/design-systems.lock
 * Format: JSON with lockfileVersion + schemaVersion + upstream + systems[]
 * Atomic writes: tmp + rename (no partial writes).
 *
 * Schema (frozen):
 * {
 *   "lockfileVersion": 1,
 *   "schemaVersion": "od-design-system-project/v1",
 *   "fetched_at": "ISO-8601",
 *   "upstream": "https://raw.githubusercontent.com/nexu-io/open-design/main",
 *   "systems": [
 *     {
 *       "id": "default",
 *       "sha256_manifest": "ab12...",
 *       "sha256_design": "cd34...",
 *       "sha256_tokens": "ef56...",
 *       "license": "Apache-2.0",
 *       "category": "Starters",
 *       "source": { "type": "upstream", "origin": "..." },
 *       "fetched_at": "ISO-8601"
 *     }
 *   ]
 * }
 *
 * Architecture decisions:
 * - Pure file I/O (fs); no npm deps.
 * - readLockfile of nonexistent file returns empty (not error).
 * - Lockfile version mismatch throws (caller's responsibility to migrate).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCKFILE_NAME = 'design-systems.lock';
const LOCKFILE_VERSION = 1;
const SCHEMA_VERSION = 'od-design-system-project/v1';

function getLockfilePath(cwd) {
  cwd = cwd || process.cwd();
  return path.join(cwd, '.agent', LOCKFILE_NAME);
}

function emptyLockfile() {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    fetched_at: null,
    upstream: null,
    systems: [],
  };
}

function readLockfile(cwd) {
  const p = getLockfilePath(cwd);
  if (!fs.existsSync(p)) {
    return emptyLockfile();
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error('Failed to parse lockfile ' + p + ': ' + e.message);
  }
  if (data.lockfileVersion !== LOCKFILE_VERSION) {
    throw new Error('Lockfile version mismatch: expected ' + LOCKFILE_VERSION + ', got ' + data.lockfileVersion);
  }
  if (!Array.isArray(data.systems)) data.systems = [];
  return data;
}

function writeLockfile(cwd, data) {
  const p = getLockfilePath(cwd);
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = p + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, p);
}

function findSystem(lock, id) {
  for (let i = 0; i < lock.systems.length; i++) {
    if (lock.systems[i].id === id) return i;
  }
  return -1;
}

function addSystem(cwd, entry) {
  if (!entry || !entry.id) throw new Error('addSystem: entry.id is required');
  const data = readLockfile(cwd);
  const idx = findSystem(data, entry.id);
  const now = new Date().toISOString();
  const enriched = Object.assign({}, entry, { fetched_at: now });
  if (idx >= 0) {
    data.systems[idx] = enriched;
  } else {
    data.systems.push(enriched);
  }
  data.fetched_at = now;
  writeLockfile(cwd, data);
  return data;
}

function removeSystem(cwd, id) {
  const data = readLockfile(cwd);
  const before = data.systems.length;
  data.systems = data.systems.filter((s) => s.id !== id);
  if (data.systems.length === before) {
    return { data, changed: false };
  }
  writeLockfile(cwd, data);
  return { data, changed: true };
}

function getSystem(cwd, id) {
  const data = readLockfile(cwd);
  const idx = findSystem(data, id);
  return idx >= 0 ? data.systems[idx] : null;
}

function listSystems(cwd) {
  const data = readLockfile(cwd);
  return data.systems.slice();
}

function upgradeSystems(cwd, upgradeMap) {
  // upgradeMap: { id: partialEntry } — only fields present are merged
  const data = readLockfile(cwd);
  let changed = 0;
  const now = new Date().toISOString();
  for (const entry of data.systems) {
    const patch = upgradeMap[entry.id];
    if (patch && typeof patch === 'object') {
      Object.assign(entry, patch, { fetched_at: now });
      changed++;
    }
  }
  if (changed > 0) {
    data.fetched_at = now;
    writeLockfile(cwd, data);
  }
  return { data, changed };
}

module.exports = {
  // Public API
  readLockfile,
  writeLockfile,
  addSystem,
  removeSystem,
  getSystem,
  listSystems,
  upgradeSystems,
  // Path / constants
  getLockfilePath,
  LOCKFILE_NAME,
  LOCKFILE_VERSION,
  SCHEMA_VERSION,
};
