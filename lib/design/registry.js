/**
 * lib/design/registry.js
 *
 * Upstream catalog management for Open Design integration.
 *
 * Responsibilities:
 * - Load the catalog (151 design systems from nexu-io/open-design).
 * - 24h TTL cache in ~/.cortex-agent/catalog-cache.json.
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

function getDefaultCachePath() {
  return path.join(os.homedir(), '.cortex-agent', 'catalog-cache.json');
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
  getUpstream,
  getGitHubApi,
  // Constants
  DEFAULT_UPSTREAM,
  DEFAULT_GITHUB_API,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  // Internal: exported for tests
  httpsGetJson,
};
