'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadCatalog,
  fetchCatalog,
  isCacheValid,
  readCacheRaw,
  getDefaultCachePath,
  getLegacyCachePath,
  migrateLegacyCache,
  DEFAULT_CACHE_TTL_MS,
} = require("../../lib/design/registry");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-design-registry-'));
}

// -- isCacheValid ----------------------------------------------------------

test('isCacheValid: null cache is invalid', () => {
  assert.equal(isCacheValid(null, 1000, () => 0), false);
});

test('isCacheValid: empty object is invalid', () => {
  assert.equal(isCacheValid({}, 1000, () => 0), false);
});

test('isCacheValid: missing fetched_at is invalid', () => {
  assert.equal(isCacheValid({ entries: [] }, 1000, () => 0), false);
});

test('isCacheValid: invalid date is invalid', () => {
  assert.equal(isCacheValid({ fetched_at: 'not-a-date' }, 1000, () => 0), false);
});

test('isCacheValid: fresh cache is valid', () => {
  const now = Date.parse('2026-08-04T12:00:00Z');
  const cache = { fetched_at: new Date(now).toISOString() };
  assert.equal(isCacheValid(cache, 1000, () => now + 500), true);
});

test('isCacheValid: stale cache is invalid', () => {
  const fetched = Date.parse('2026-08-04T12:00:00Z');
  const cache = { fetched_at: new Date(fetched).toISOString() };
  assert.equal(isCacheValid(cache, 1000, () => fetched + 5000), false);
});

// -- readCacheRaw -----------------------------------------------------------

test('readCacheRaw: returns null when file missing', () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, 'no-such.json');
    assert.equal(readCacheRaw(p), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readCacheRaw: parses valid JSON', () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, 'cache.json');
    fs.writeFileSync(p, JSON.stringify({ entries: [{ id: 'x' }] }));
    const got = readCacheRaw(p);
    assert.deepEqual(got.entries, [{ id: 'x' }]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readCacheRaw: returns null on corrupt JSON', () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, 'cache.json');
    fs.writeFileSync(p, '{ not valid json');
    assert.equal(readCacheRaw(p), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// -- loadCatalog ------------------------------------------------------------

test('loadCatalog: returns cached entries if fresh (no fetch)', async () => {
  const tmp = makeTmpDir();
  try {
    const cachePath = path.join(tmp, 'cache.json');
    const cached = {
      fetched_at: new Date().toISOString(),
      upstream: 'https://example.com',
      entries: [{ id: 'default', path: 'design-systems/default' }],
    };
    fs.writeFileSync(cachePath, JSON.stringify(cached));

    let fetcherCalled = false;
    const fetcher = () => { fetcherCalled = true; return Promise.resolve({}); };

    const entries = await loadCatalog({
      cachePath,
      fetcher,
      now: () => Date.now(),
    });
    assert.equal(fetcherCalled, false, 'fetcher should not be called when cache is fresh');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'default');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadCatalog: fetches when cache stale', async () => {
  const tmp = makeTmpDir();
  try {
    const cachePath = path.join(tmp, 'cache.json');
    // Cache older than TTL.
    const oldDate = new Date(Date.now() - 2 * DEFAULT_CACHE_TTL_MS).toISOString();
    fs.writeFileSync(cachePath, JSON.stringify({
      fetched_at: oldDate,
      upstream: 'https://example.com',
      entries: [{ id: 'stale' }],
    }));

    const fetched = {
      tree: [
        { path: 'design-systems/default/manifest.json' },
        { path: 'design-systems/linear-app/manifest.json' },
        { path: 'README.md' }, // not a design system
        { path: 'design-systems/warm-editorial/manifest.json' },
      ],
    };
    let fetcherCalled = false;
    const fetcher = () => { fetcherCalled = true; return Promise.resolve(fetched); };

    const entries = await loadCatalog({
      upstream: 'https://raw.example/main',
      cachePath,
      fetcher,
      now: () => Date.now(),
    });
    assert.equal(fetcherCalled, true);
    assert.equal(entries.length, 3);
    const ids = entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ['default', 'linear-app', 'warm-editorial']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadCatalog: fetches when cache missing', async () => {
  const tmp = makeTmpDir();
  try {
    const cachePath = path.join(tmp, 'no-such-cache.json');
    const fetched = { tree: [{ path: 'design-systems/default/manifest.json' }] };
    const entries = await loadCatalog({
      upstream: 'https://raw.example/main',
      cachePath,
      fetcher: () => Promise.resolve(fetched),
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'default');
    // Cache file was written
    assert.ok(fs.existsSync(cachePath), 'cache file should be written');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadCatalog: forceRefresh ignores cache', async () => {
  const tmp = makeTmpDir();
  try {
    const cachePath = path.join(tmp, 'cache.json');
    fs.writeFileSync(cachePath, JSON.stringify({
      fetched_at: new Date().toISOString(),
      upstream: 'https://example.com',
      entries: [{ id: 'cached' }],
    }));

    const fetched = { tree: [{ path: 'design-systems/fresh/manifest.json' }] };
    const entries = await loadCatalog({
      cachePath,
      fetcher: () => Promise.resolve(fetched),
      forceRefresh: true,
    });
    assert.equal(entries[0].id, 'fresh');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// -- fetchCatalog (URL construction) ----------------------------------------

test('fetchCatalog: builds correct entry shape', async () => {
  const fetched = { tree: [
    { path: 'design-systems/apple/manifest.json' },
    { path: 'design-systems/spotify/manifest.json' },
  ] };
  const entries = await fetchCatalog({
    upstream: 'https://raw.example/main',
    fetcher: () => Promise.resolve(fetched),
  });
  assert.equal(entries[0].id, 'apple');
  assert.equal(entries[0].path, 'design-systems/apple');
  assert.equal(entries[0].upstream_url, 'https://raw.example/main/design-systems/apple');
});

test('fetchCatalog: throws on invalid tree response', async () => {
  await assert.rejects(
    () => fetchCatalog({ fetcher: () => Promise.resolve({}) }),
    /Invalid tree response/
  );
});

// -- getDefaultCachePath ----------------------------------------------------

test('getDefaultCachePath: ends with design-catalog-cache.json under ~/.agent/cache', () => {
  const p = getDefaultCachePath();
  assert.ok(p.endsWith(path.join('.agent', 'cache', 'design-catalog-cache.json')),
    `expected path to end with ~/.agent/cache/design-catalog-cache.json, got ${p}`);
});

test('getLegacyCachePath: ends with catalog-cache.json under ~/.cortex-agent', () => {
  const p = getLegacyCachePath();
  assert.ok(p.endsWith(path.join('.cortex-agent', 'catalog-cache.json')),
    `expected legacy path to end with ~/.cortex-agent/catalog-cache.json, got ${p}`);
});

// -- migrateLegacyCache ------------------------------------------------------

test('migrateLegacyCache: no-op when legacy file is missing', () => {
  const tmp = makeTmpDir();
  try {
    const newPath = path.join(tmp, 'new.json');
    const legacyPath = path.join(tmp, 'no-such.json');
    const result = migrateLegacyCache({ newPath, legacyPath });
    assert.deepEqual(result, { migrated: false, reason: 'legacy-cache-missing' });
    assert.equal(fs.existsSync(newPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateLegacyCache: no-op when new cache already exists', () => {
  const tmp = makeTmpDir();
  try {
    const newPath = path.join(tmp, 'new-dir', 'cache.json');
    const legacyPath = path.join(tmp, 'legacy-dir', 'cache.json');
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify({ fetched_at: '2026-08-13T00:00:00Z', entries: [] }));
    fs.writeFileSync(legacyPath, JSON.stringify({ fetched_at: '2026-08-12T00:00:00Z', entries: [] }));

    const result = migrateLegacyCache({ newPath, legacyPath });
    assert.deepEqual(result, { migrated: false, reason: 'new-cache-exists' });
    // Legacy file must NOT be touched.
    assert.equal(fs.existsSync(legacyPath), true);
    // New file content unchanged.
    const newContent = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    assert.equal(newContent.fetched_at, '2026-08-13T00:00:00Z');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateLegacyCache: moves legacy file to new path', () => {
  const tmp = makeTmpDir();
  try {
    const newPath = path.join(tmp, 'new-dir', 'cache.json');
    const legacyPath = path.join(tmp, 'legacy-dir', 'cache.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    const payload = { fetched_at: '2026-08-13T00:00:00Z', entries: [{ id: 'apple' }] };
    fs.writeFileSync(legacyPath, JSON.stringify(payload));

    const result = migrateLegacyCache({ newPath, legacyPath });
    assert.equal(result.migrated, true);
    assert.equal(result.legacyPath, legacyPath);
    assert.equal(result.newPath, newPath);
    // File moved, content preserved.
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(fs.existsSync(newPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(newPath, 'utf8')), payload);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateLegacyCache: removes empty legacy directory after move', () => {
  const tmp = makeTmpDir();
  try {
    const legacyDir = path.join(tmp, 'legacy-dir');
    const newPath = path.join(tmp, 'new-dir', 'cache.json');
    const legacyPath = path.join(legacyDir, 'cache.json');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPath, '{"fetched_at":"2026-08-13T00:00:00Z","entries":[]}');

    migrateLegacyCache({ newPath, legacyPath });
    // Empty legacy dir should be cleaned up.
    assert.equal(fs.existsSync(legacyDir), false,
      'empty legacy directory should be removed after migration');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateLegacyCache: keeps legacy directory when other files exist', () => {
  const tmp = makeTmpDir();
  try {
    const legacyDir = path.join(tmp, 'legacy-dir');
    const newPath = path.join(tmp, 'new-dir', 'cache.json');
    const legacyPath = path.join(legacyDir, 'cache.json');
    const otherFile = path.join(legacyDir, 'other-state.json');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPath, '{"fetched_at":"2026-08-13T00:00:00Z","entries":[]}');
    fs.writeFileSync(otherFile, '{"user":true}');

    migrateLegacyCache({ newPath, legacyPath });
    // Legacy dir should still exist (has other files).
    assert.equal(fs.existsSync(legacyDir), true);
    assert.equal(fs.existsSync(otherFile), true);
    assert.equal(fs.existsSync(legacyPath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migrateLegacyCache: idempotent — second call is no-op', () => {
  const tmp = makeTmpDir();
  try {
    const legacyDir = path.join(tmp, 'legacy-dir');
    const newPath = path.join(tmp, 'new-dir', 'cache.json');
    const legacyPath = path.join(legacyDir, 'cache.json');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPath, '{"fetched_at":"2026-08-13T00:00:00Z","entries":[]}');

    const first = migrateLegacyCache({ newPath, legacyPath });
    const second = migrateLegacyCache({ newPath, legacyPath });
    assert.equal(first.migrated, true);
    // Second call must be a no-op (any non-migrated reason is acceptable —
    // depends on whether legacy dir still exists or not).
    assert.equal(second.migrated, false);
    assert.ok(['legacy-cache-missing', 'new-cache-exists'].includes(second.reason),
      `unexpected reason: ${second.reason}`);
    // Either way: new file must remain intact and present.
    assert.equal(fs.existsSync(newPath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
