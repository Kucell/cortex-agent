"use strict";

// ─── resolve — 4-kind catalog resolution (P-001 MS-002 follow-up) ──────────────
//
// Adapter that delegates design-system resolution to T-OD-001 lib/design/resolve.js
// (frozen, MS-003-shipped). For other 3 kinds (plugin / skill / template) the
// resolution is single-source: the installed copy under <cwd>/.agent/<installDir>/<id>/
// is the only source (no cascade, no override layers).
//
// All 4 kinds share the resolve flow:
//   1. checkInstalled(cwd, kind, id) → returns the on-disk install root
//   2. readManifest(cwd, kind, id)   → returns the per-kind manifest content
//   3. resolveEffective(cwd, kind, id) → returns the effective (single-source for
//      plugin/skill/template; 4-level cascade for design-system via lib/design/resolve.js)
//
// No npm deps. Pure file I/O.

const fs = require("node:fs");
const path = require("node:path");

const { KINDS, KIND_LIST, getKind, resolveInstallPath, requiredFiles } = require("./kind-map");

// T-OD-001 frozen resolver — design-system only.
const designResolve = require("../design/resolve");

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

/**
 * Resolve the on-disk install path for a kind + id. Returns null when nothing
 * is installed (caller should consult starter index / upstream catalog).
 *
 * @param {string} kind
 * @param {string} id
 * @param {string} cwd
 * @returns {string | null}
 */
function checkInstalled(kind, id, cwd) {
  cwd = cwd || process.cwd();
  const root = resolveInstallPath(kind, id, cwd);
  return dirExists(root) ? root : null;
}

/**
 * Read the per-kind manifest from the installed root. Returns parsed object
 * (JSON) when manifest is JSON-shaped, raw string when SKILL.md / DESIGN.md.
 *
 * @param {string} kind
 * @param {string} id
 * @param {string} cwd
 * @returns {object | string | null}
 */
function readManifest(kind, id, cwd) {
  cwd = cwd || process.cwd();
  const root = checkInstalled(kind, id, cwd);
  if (!root) return null;
  const meta = getKind(kind);
  const manifestPath = path.join(root, meta.manifestFilename);
  if (!exists(manifestPath)) return null;
  const text = fs.readFileSync(manifestPath, "utf8");
  if (manifestPath.endsWith(".json")) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }
  return text;
}

/**
 * Resolve the effective entry for a kind + id. design-system follows the 4-level
 * cascade (via T-OD-001); other 3 kinds return the installed entry only.
 *
 * @param {string} kind
 * @param {string} id
 * @param {string} cwd
 * @returns {{ kind: string, id: string, layers?: Array, source: string } | null}
 */
function resolveEffective(kind, id, cwd) {
  cwd = cwd || process.cwd();
  if (!KINDS[kind]) {
    throw new Error(`resolve.resolveEffective: unknown kind "${kind}"`);
  }
  if (kind === "design-system") {
    // Delegate to T-OD-001 4-level cascade.
    const cascade = designResolve.resolveCascade(cwd);
    const matched = cascade.find((layer) => {
      // Match by id at layer 3 (installed); layers 1/2/4 don't carry an id.
      return layer.layer === 3 && layer.id === id;
    }) || null;
    return {
      kind: "design-system",
      id,
      layers: cascade,
      matched,
      source: matched ? "installed" : "starter",
    };
  }

  const root = checkInstalled(kind, id, cwd);
  if (root) {
    return {
      kind,
      id,
      root,
      layers: [{ layer: 1, source: root, kind }],
      source: "installed",
    };
  }
  return {
    kind,
    id,
    layers: [],
    source: "missing",
  };
}

/**
 * List all installed entries for a kind (walks <cwd>/.agent/<installDir>/).
 *
 * @param {string} kind
 * @param {string} cwd
 * @returns {Array<{id, root}>}
 */
function listInstalled(kind, cwd) {
  cwd = cwd || process.cwd();
  const meta = getKind(kind);
  const root = path.join(cwd || process.cwd(), meta.installDir);
  if (!dirExists(root)) return [];
  const ids = fs.readdirSync(root).filter((name) => {
    const sub = path.join(root, name);
    if (!dirExists(sub)) return false;
    // Skip dotfiles / hidden
    if (name.startsWith(".")) return false;
    return true;
  });
  return ids.map((id) => ({ id, root: path.join(root, id) }));
}

/**
 * List installed across all 4 kinds.
 */
function listAllInstalled(cwd) {
  const out = {};
  for (const kind of KIND_LIST) {
    out[kind] = listInstalled(kind, cwd);
  }
  return out;
}

/**
 * Run the per-kind manifest check (presence of the required file under the
 * installed root).
 *
 * @returns {{ present: boolean, missing: string[], root: string | null }}
 */
function verifyInstall(kind, id, cwd) {
  const root = checkInstalled(kind, id, cwd);
  if (!root) {
    return { present: false, missing: requiredFiles(kind), root: null };
  }
  const missing = requiredFiles(kind).filter((file) => !exists(path.join(root, file)));
  return { present: missing.length === 0, missing, root };
}

module.exports = {
  checkInstalled,
  readManifest,
  resolveEffective,
  listInstalled,
  listAllInstalled,
  verifyInstall,
  // exposed for tests
  _internal: { exists, dirExists },
};