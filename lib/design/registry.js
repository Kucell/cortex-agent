/**
 * lib/design/registry.js
 *
 * Upstream catalog management for Open Design integration.
 *
 * Responsibilities:
 * - Load the catalog (151 design systems from nexu-io/open-design).
 * - 24h TTL cache in ~/.agent/cache/design-catalog-cache.json
 *   (aligned with the global ~/.agent/ convention; one-shot migration from
 *   the legacy ~/.cortex-agent/catalog-cache.json — see migrateLegacyCache).
 * - Lazy fetch — only the directory listing, manifest.json fetched on install.
 * - Pure Node.js built-ins (no npm deps).
 *
 * Architecture decisions (frozen, see .agent/plans/proposals/design-system/...):
 * - Upstream URL configurable via CORTEX_AGENT_DESIGN_UPSTREAM env.
 * - GitHub tree API used for catalog enumeration (not raw.githubusercontent.com).
 * - Cache writes are atomic (tmp + rename).
 *
 * Testability:
 * - All network I/O goes through the `fetcher` parameter (default: `httpsGetJson`).
 * - All time access goes through the `now` parameter (default: `Date.now`).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const DEFAULT_UPSTREAM = 'https://raw.githubusercontent.com/nexu-io/open-design/main';
const DEFAULT_GITHUB_API = 'https://api.github.com/repos/nexu-io/open-design';
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10000;

// Cache location (aligned with the global ~/.agent/ convention).
// Legacy location (~/.cortex-agent/catalog-cache.json) is honored via
// migrateLegacyCache() — see loadCatalog() and M-SETUP-PORT-001 / M-017.
const CACHE_DIRNAME = 'cache';
const CACHE_FILENAME = 'design-catalog-cache.json';
const LEGACY_HOMEDIR_NAME = '.cortex-agent';
const LEGACY_FILENAME = 'catalog-cache.json';

function getDefaultCachePath() {
  return path.join(os.homedir(), '.agent', CACHE_DIRNAME, CACHE_FILENAME);
}

function getLegacyCachePath() {
  return path.join(os.homedir(), LEGACY_HOMEDIR_NAME, LEGACY_FILENAME);
}

/**
 * One-shot migration: move legacy ~/.cortex-agent/catalog-cache.json to the
 * current ~/.agent/cache/design-catalog-cache.json.
 *
 * Idempotent and non-destructive:
 *   - no-op if new cache already exists
 *   - no-op if legacy cache does not exist
 *   - on success, removes the empty legacy directory if it has no other entries
 *   - failures are swallowed (return reason); callers can safely ignore
 *
 * @param {object} [options]
 * @param {string} [options.newPath]    Override target (testability).
 * @param {string} [options.legacyPath] Override legacy source (testability).
 * @returns {{ migrated: boolean, reason?: string, legacyPath?: string, newPath?: string }}
 */
function migrateLegacyCache(options) {
  options = options || {};
  const newPath = options.newPath || getDefaultCachePath();
  const legacyPath = options.legacyPath || getLegacyCachePath();

  if (fs.existsSync(newPath)) {
    return { migrated: false, reason: 'new-cache-exists' };
  }
  if (!fs.existsSync(legacyPath)) {
    return { migrated: false, reason: 'legacy-cache-missing' };
  }

  try {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(legacyPath, newPath);
  } catch (err) {
    return { migrated: false, reason: 'rename-failed:' + err.message };
  }

  // Best-effort cleanup of the legacy directory if it's now empty.
  try {
    const legacyDir = path.dirname(legacyPath);
    const remaining = fs.readdirSync(legacyDir);
    if (remaining.length === 0) {
      fs.rmdirSync(legacyDir);
    }
  } catch (_) { /* ignore — best effort */ }

  return { migrated: true, legacyPath, newPath };
}

function getUpstream(env) {
  env = env || process.env;
  return env.CORTEX_AGENT_DESIGN_UPSTREAM || DEFAULT_UPSTREAM;
}

function getGitHubApi(env) {
  env = env || process.env;
  return env.CORTEX_AGENT_DESIGN_GITHUB_API || DEFAULT_GITHUB_API;
}

function httpsGetJson(url, options) {
  options = options || {};
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: options.headers || {} }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout (${timeoutMs}ms) fetching ${url}`));
    });
  });
}

function isCacheValid(cache, ttlMs, now) {
  if (!cache || typeof cache.fetched_at !== 'string') return false;
  const fetchedAt = Date.parse(cache.fetched_at);
  if (isNaN(fetchedAt)) return false;
  return (now() - fetchedAt) < ttlMs;
}

function writeCacheAtomic(cachePath, data) {
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = cachePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, cachePath);
}

function readCacheRaw(cachePath) {
  if (!fs.existsSync(cachePath)) return null;
  const text = fs.readFileSync(cachePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    return null; // corrupted cache; treat as missing
  }
}

async function fetchCatalog(options) {
  options = options || {};
  const githubApi = options.githubApi || getGitHubApi();
  const upstream = options.upstream || getUpstream();
  const fetcher = options.fetcher || httpsGetJson;
  const tree = await fetcher(githubApi + '/git/trees/main?recursive=1', {
    headers: { 'User-Agent': 'cortex-agent-design-registry' },
  });
  if (!tree || !Array.isArray(tree.tree)) {
    throw new Error('Invalid tree response from GitHub API: ' + JSON.stringify(tree).slice(0, 200));
  }
  // Filter to design-systems/*/manifest.json paths.
  const entries = [];
  for (const node of tree.tree) {
    if (!node || typeof node.path !== 'string') continue;
    if (!node.path.startsWith('design-systems/')) continue;
    if (!node.path.endsWith('/manifest.json')) continue;
    const slug = node.path.replace(/^design-systems\//, '').replace(/\/manifest\.json$/, '');
    if (!slug) continue;
    entries.push({
      id: slug,
      path: 'design-systems/' + slug,
      upstream_url: upstream + '/design-systems/' + slug,
    });
  }
  return entries;
}

async function loadCatalog(options) {
  options = options || {};
  const cachePath = options.cachePath || getDefaultCachePath();
  const ttlMs = options.ttlMs != null ? options.ttlMs : DEFAULT_CACHE_TTL_MS;
  const upstream = options.upstream || getUpstream();
  const fetcher = options.fetcher || httpsGetJson;
  const now = options.now || Date.now;
  const forceRefresh = options.forceRefresh === true;

  // One-shot migration from legacy ~/.cortex-agent/ → ~/.agent/cache/.
  // Only triggers when caller did NOT inject a custom cachePath (test fixtures
  // must never trigger a real migration on the user's machine).
  if (options.cachePath == null) {
    try { migrateLegacyCache(); } catch (_) { /* best-effort, non-fatal */ }
  }

  // Try cache first.
  if (!forceRefresh) {
    const cached = readCacheRaw(cachePath);
    if (isCacheValid(cached, ttlMs, now)) {
      if (Array.isArray(cached.entries)) return cached.entries;
    }
  }

  // Fetch fresh.
  const entries = await fetchCatalog({ upstream, fetcher });
  const cacheData = {
    fetched_at: new Date(now()).toISOString(),
    upstream,
    entries,
  };
  writeCacheAtomic(cachePath, cacheData);
  return entries;
}

module.exports = {
  // Public API
  loadCatalog,
  fetchCatalog,
  isCacheValid,
  readCacheRaw,
  writeCacheAtomic,
  // Path / config helpers (testable)
  getDefaultCachePath,
  getLegacyCachePath,
  getUpstream,
  getGitHubApi,
  // Migration helper (testable)
  migrateLegacyCache,
  // Constants
  DEFAULT_UPSTREAM,
  DEFAULT_GITHUB_API,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  // Internal: exported for tests
  httpsGetJson,
};
