/**
 * lib/design/local.js
 *
 * Content-addressed install of a design system from a local directory.
 *
 * Responsibilities:
 * - Read a local system package: `manifest.json` (optional), `DESIGN.md`
 *   (required), `tokens.css` (optional).
 * - Compute SHA-256 per file, using the same lockfile contract as the
 *   upstream install path in lib/design/fetch.js.
 * - Write the package into `<destDir>` atomically (tmp + rename), replacing
 *   any previous copy so stale files never survive an upgrade.
 *
 * Why this exists:
 *   `cortex-agent design install` only accepted ids from the upstream
 *   catalog, so a project whose visual contract lives in its own code (for
 *   example `src/ui/styles/tokens.css`) had no way to register that contract
 *   as a cascade layer. The two remaining slots were `.agent/DESIGN.md` — a
 *   loose markdown file that the shipped starter template fills with
 *   placeholders — and layer 3, which was catalog-only. `design resolved`, and
 *   the MCP `design/resolved` tool that coding agents consume, therefore
 *   served a spec with no overlap with the tokens the code actually used.
 *
 * Architecture decisions:
 * - Pure Node.js built-ins; zero npm deps.
 * - Same content-addressing contract as the upstream path: the lockfile
 *   records a SHA-256 per file so an installed system stays reproducible and
 *   verifiable across hosts.
 * - `manifest.json` stays optional (legacy DESIGN.md-only systems remain
 *   compatible, matching non-goal N6). A minimal manifest is synthesised so
 *   the installed package is self-describing.
 * - License governance is unchanged: the license gate still fails closed when
 *   a package declares no license. Local origin does not relax that gate.
 *
 * Inputs:
 *   readLocalSystem({ dir, id? })
 *     dir: absolute path to a directory holding the package
 *     id:  optional explicit system id; defaults to manifest id, then the
 *          directory name
 *
 *   installLocalSystem({ dir, id?, destDir })
 *     destDir: absolute target directory
 *
 * Returns:
 *   { id, path, sha256: { manifest, design, tokens }, files, manifest,
 *     source: { type: 'local', origin } }
 *
 * Throws:
 *   - ERR_LOCAL when the directory, DESIGN.md, or manifest.json is unusable
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_FILE = 'manifest.json';
const DESIGN_FILE = 'DESIGN.md';
const TOKENS_FILE = 'tokens.css';

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function localError(message) {
  const err = new Error(message);
  err.code = 'ERR_LOCAL';
  return err;
}

function readTextIfPresent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

function synthesizeManifest(id, origin) {
  return {
    schemaVersion: 'od-design-system-project/v1',
    id,
    name: id,
    category: 'Local',
    description: 'Project-local design system installed from ' + origin,
    source: { type: 'local', origin },
  };
}

/**
 * Read a local design system package without writing anything.
 *
 * @param {object} options
 * @param {string} options.dir   absolute path to the package directory
 * @param {string} [options.id]  explicit system id override
 * @returns {{ id: string, dir: string, manifest: object, manifestText: string,
 *             designText: string, tokensText: string|null,
 *             sha256: { manifest: string, design: string, tokens: string|null } }}
 */
function readLocalSystem(options) {
  options = options || {};
  const dir = options.dir;
  if (!dir) throw localError('readLocalSystem: dir is required');

  const absDir = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(absDir);
  } catch (e) {
    throw localError('design system directory not found: ' + absDir);
  }
  if (!stat.isDirectory()) {
    throw localError('design system path is not a directory: ' + absDir);
  }

  const manifestText = readTextIfPresent(path.join(absDir, MANIFEST_FILE));
  let manifest;
  if (manifestText === null) {
    manifest = null;
  } else {
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      throw localError('Invalid ' + MANIFEST_FILE + ' in ' + absDir + ': ' + e.message);
    }
  }

  const designText = readTextIfPresent(path.join(absDir, DESIGN_FILE));
  if (designText === null) {
    throw localError('Missing ' + DESIGN_FILE + ' in ' + absDir);
  }

  const tokensText = readTextIfPresent(path.join(absDir, TOKENS_FILE));

  const id = options.id || (manifest && manifest.id) || path.basename(absDir);
  if (!id) throw localError('design system id could not be determined for ' + absDir);

  // A package without its own manifest still has to land as a self-describing
  // package, so synthesise the manifest the lockfile and `design show` expect.
  const effectiveManifest = manifest || synthesizeManifest(id, absDir);
  const effectiveManifestText = manifestText === null
    ? JSON.stringify(effectiveManifest, null, 2) + '\n'
    : manifestText;

  return {
    id,
    dir: absDir,
    manifest: effectiveManifest,
    manifestText: effectiveManifestText,
    designText,
    tokensText,
    sha256: {
      manifest: sha256(effectiveManifestText),
      design: sha256(designText),
      tokens: tokensText === null ? null : sha256(tokensText),
    },
  };
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function clearDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) {
      clearDirectory(p);
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
}

/**
 * Install a local design system into `destDir`, replacing any previous copy.
 *
 * @param {object} options
 * @param {string} options.dir      absolute path to the package directory
 * @param {string} [options.id]     explicit system id override
 * @param {string} options.destDir  absolute target directory
 * @returns {{ id: string, path: string, sha256: object, files: object,
 *             manifest: object, source: object }}
 */
function installLocalSystem(options) {
  options = options || {};
  const destDir = options.destDir;
  if (!destDir) throw localError('installLocalSystem: destDir is required');

  const system = readLocalSystem(options);

  clearDirectory(destDir);
  writeFileAtomic(path.join(destDir, MANIFEST_FILE), system.manifestText);
  writeFileAtomic(path.join(destDir, DESIGN_FILE), system.designText);
  if (system.tokensText !== null) {
    writeFileAtomic(path.join(destDir, TOKENS_FILE), system.tokensText);
  }

  return {
    id: system.id,
    path: destDir,
    sha256: system.sha256,
    files: {
      manifest: MANIFEST_FILE,
      design: DESIGN_FILE,
      tokens: system.tokensText !== null ? TOKENS_FILE : null,
    },
    manifest: system.manifest,
    source: { type: 'local', origin: system.dir },
  };
}

module.exports = {
  // Public API
  readLocalSystem,
  installLocalSystem,
  // Helpers (testable)
  synthesizeManifest,
  sha256,
  // Constants
  MANIFEST_FILE,
  DESIGN_FILE,
  TOKENS_FILE,
};
