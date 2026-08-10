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

test('getDefaultCachePath: ends with catalog-cache.json under ~/.cortex-agent', () => {
  const p = getDefaultCachePath();
  assert.ok(p.endsWith(path.join('.cortex-agent', 'catalog-cache.json')));
});
