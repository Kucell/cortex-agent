/**
 * lib/design/resolve.js
 *
 * 4-level cascade resolution for DESIGN.md files.
 *
 * Layer 1: <cwd>/DESIGN.md                        (user project override, highest)
 * Layer 2: <cwd>/.agent/DESIGN.md                 (agent context)
 * Layer 3: <cwd>/.agent/design-systems/<id>/...   (installed, LIFO)
 * Layer 4: cortex-agent starter (templates/{zh,en,_shared}/.agent/DESIGN.md)
 *
 * LIFO means the most recently installed system wins over earlier ones.
 * This mirrors npm's resolution intuition.
 *
 * Architecture decisions:
 * - Pure file system reads (fs); no npm deps.
 * - Returns ordered array (layer 1 first, layer 4 last).
 * - Layer 3 reads lockfile order and reverses for LIFO.
 * - Layer 4 tries zh, en, _shared in order; first existing wins.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readLockfile, getLockfilePath: _lockfilePath } = require('./lockfile');

function exists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (e) {
    return false;
  }
}

function findLayer1(cwd) {
  const p = path.join(cwd, 'DESIGN.md');
  if (exists(p)) {
    return [{ layer: 1, source: p, kind: 'user-override' }];
  }
  return [];
}

function findLayer2(cwd) {
  const p = path.join(cwd, '.agent', 'DESIGN.md');
  if (exists(p)) {
    return [{ layer: 2, source: p, kind: 'agent-context' }];
  }
  return [];
}

function findLayer3(cwd) {
  // Read lockfile; reverse order for LIFO.
  let data;
  try {
    data = readLockfile(cwd);
  } catch (e) {
    return []; // corrupted lockfile; skip
  }
  if (!Array.isArray(data.systems)) return [];
  const reversed = data.systems.slice().reverse();
  const results = [];
  for (const sys of reversed) {
    if (!sys || !sys.id) continue;
    const p = path.join(cwd, '.agent', 'design-systems', sys.id, 'DESIGN.md');
    if (exists(p)) {
      results.push({
        layer: 3,
        source: p,
        kind: 'installed',
        id: sys.id,
        license: sys.license || null,
        category: sys.category || null,
        sha256_design: sys.sha256_design || null,
      });
    }
  }
  return results;
}

function findLayer4(templateDir) {
  if (!templateDir) return null;
  const candidates = [
    path.join(templateDir, 'zh', '.agent', 'DESIGN.md'),
    path.join(templateDir, 'en', '.agent', 'DESIGN.md'),
    path.join(templateDir, '_shared', '.agent', 'DESIGN.md'),
  ];
  for (const c of candidates) {
    if (exists(c)) {
      return { layer: 4, source: c, kind: 'starter' };
    }
  }
  return null;
}

function resolveCascade(options) {
  options = options || {};
  const cwd = options.cwd || process.cwd();
  const templateDir = options.templateDir;

  const layers = [];
  layers.push(...findLayer1(cwd));
  layers.push(...findLayer2(cwd));
  layers.push(...findLayer3(cwd));
  const starter = findLayer4(templateDir);
  if (starter) layers.push(starter);
  return layers;
}

function effectiveDesign(options) {
  // The last entry in the cascade (highest priority wins).
  // Convention: lower layer = higher priority. Effective is the FIRST entry.
  const cascade = resolveCascade(options);
  return cascade.length > 0 ? cascade[0] : null;
}

module.exports = {
  // Public API
  resolveCascade,
  effectiveDesign,
  // Helpers (testable)
  findLayer1,
  findLayer2,
  findLayer3,
  findLayer4,
  exists,
};
