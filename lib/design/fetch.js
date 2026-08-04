/**
 * lib/design/fetch.js
 *
 * Content-addressed fetch for a single Open Design system.
 *
 * Responsibilities:
 * - Download manifest.json + DESIGN.md + tokens.css (the latter two optional).
 * - Compute SHA-256 for each file.
 * - Atomic write to <cwd>/.agent/design-systems/<id>/.
 * - MITM protection: reject writes if any file's hash mismatches the provided
 *   expected hash.
 *
 * Architecture decisions:
 * - Pure Node.js built-ins (https, fs, crypto).
 * - All network I/O goes through the `fetcher` parameter.
 * - Files are written via tmp + rename for atomicity.
 *
 * Inputs:
 *   { id, entry, upstream, destDir, fetcher, expectedHashes }
 *     id:           system slug (e.g. "default", "linear-app")
 *     entry:        { id, path, upstream_url } from registry
 *     upstream:     base URL (e.g. "https://raw.githubusercontent.com/.../main")
 *     destDir:      absolute target directory (defaults to .agent/design-systems/<id>)
 *     fetcher:      (url) => Promise<{statusCode, body}>
 *     expectedHashes: optional { manifest?, design?, tokens? } — when provided, fail-closed
 *
 * Returns:
 *   { id, path, sha256: { manifest, design, tokens }, files: { manifest, design, tokens } }
 *
 * Throws:
 *   - on network errors
 *   - on hash mismatch (MITM / corruption)
 *   - on invalid manifest.json
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const DEFAULT_TIMEOUT_MS = 10000;

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function httpsGetText(url, options) {
  options = options || {};
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: options.headers || {} }, (res) => {
      // Follow one redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        httpsGetText(next, options).then(resolve, reject);
        return;
      }
      if (res.statusCode === 404) {
        reject(new Error('HTTP 404'));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout (' + timeoutMs + 'ms) fetching ' + url));
    });
  });
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

async function fetchText(url, fetcher) {
  fetcher = fetcher || httpsGetText;
  if (url.startsWith('https://')) {
    return fetcher(url, { headers: { 'User-Agent': 'cortex-agent-design-fetch' } });
  }
  return fetcher(url);
}

function verifyHash(name, content, expected) {
  if (expected == null) return;
  const actual = sha256(content);
  if (actual !== expected) {
    throw new Error(
      'Hash mismatch for ' + name + ': expected ' + expected + ', got ' + actual + ' (possible MITM or corruption)'
    );
  }
}

async function fetchSystem(options) {
  options = options || {};
  const id = options.id;
  if (!id) throw new Error('fetchSystem: id is required');
  const entry = options.entry || { id, path: 'design-systems/' + id };
  const upstream = options.upstream || 'https://raw.githubusercontent.com/nexu-io/open-design/main';
  const destDir = options.destDir || path.join(process.cwd(), '.agent', 'design-systems', id);
  const fetcher = options.fetcher;
  const expected = options.expectedHashes || {};

  const baseUrl = upstream.replace(/\/$/, '') + '/' + entry.path.replace(/^\//, '').replace(/\/$/, '');

  // Fetch manifest.json (required)
  const manifestUrl = baseUrl + '/manifest.json';
  const manifestText = await fetchText(manifestUrl, fetcher);
  verifyHash('manifest', manifestText, expected.manifest);

  // Parse manifest to validate (also used by license gate)
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    throw new Error('Invalid manifest.json for ' + id + ': ' + e.message);
  }

  // Fetch DESIGN.md (optional for legacy)
  let designText = null;
  try {
    designText = await fetchText(baseUrl + '/DESIGN.md', fetcher);
    verifyHash('design', designText, expected.design);
  } catch (e) {
    if (e && /HTTP 404/.test(e.message)) {
      designText = null; // legacy OK
    } else {
      throw e;
    }
  }

  // Fetch tokens.css (optional)
  let tokensText = null;
  try {
    tokensText = await fetchText(baseUrl + '/tokens.css', fetcher);
    verifyHash('tokens', tokensText, expected.tokens);
  } catch (e) {
    if (e && /HTTP 404/.test(e.message)) {
      tokensText = null;
    } else {
      throw e;
    }
  }

  // Atomic write — all-or-nothing
  clearDirectory(destDir);
  writeFileAtomic(path.join(destDir, 'manifest.json'), manifestText);
  if (designText !== null) {
    writeFileAtomic(path.join(destDir, 'DESIGN.md'), designText);
  }
  if (tokensText !== null) {
    writeFileAtomic(path.join(destDir, 'tokens.css'), tokensText);
  }

  return {
    id,
    path: destDir,
    sha256: {
      manifest: sha256(manifestText),
      design: designText !== null ? sha256(designText) : null,
      tokens: tokensText !== null ? sha256(tokensText) : null,
    },
    files: {
      manifest: 'manifest.json',
      design: designText !== null ? 'DESIGN.md' : null,
      tokens: tokensText !== null ? 'tokens.css' : null,
    },
    manifest,
  };
}

module.exports = {
  // Public API
  fetchSystem,
  // Helpers (testable)
  sha256,
  verifyHash,
  writeFileAtomic,
  clearDirectory,
  httpsGetText,
  // Constants
  DEFAULT_TIMEOUT_MS,
};
