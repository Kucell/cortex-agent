'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fetchSystem,
  sha256,
  verifyHash,
  writeFileAtomic,
  clearDirectory,
} = require('../lib/design/fetch');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-design-fetch-'));
}

const MANIFEST_JSON = JSON.stringify({
  id: 'default',
  name: 'Default',
  category: 'Starters',
  license: 'Apache-2.0',
  source: { type: 'upstream', origin: 'nexu-io/open-design' },
});

const DESIGN_MD = '# Default\n\n## Visual theme\nNeutral modern.\n';
const TOKENS_CSS = ':root { --bg: #fff; }';

// -- sha256 -----------------------------------------------------------------

test('sha256: known empty string', () => {
  // SHA-256 of ""
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256: known "abc"', () => {
  // SHA-256 of "abc"
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// -- verifyHash -------------------------------------------------------------

test('verifyHash: matching hash returns undefined (no throw)', () => {
  const h = sha256('hello');
  assert.equal(verifyHash('test', 'hello', h), undefined);
});

test('verifyHash: missing expected is no-op', () => {
  assert.equal(verifyHash('test', 'hello', null), undefined);
  assert.equal(verifyHash('test', 'hello', undefined), undefined);
});

test('verifyHash: mismatched hash throws', () => {
  assert.throws(
    () => verifyHash('test', 'hello', 'wrong-hash-value'),
    /Hash mismatch for test/
  );
});

// -- writeFileAtomic --------------------------------------------------------

test('writeFileAtomic: creates file with content', () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, 'a.txt');
    writeFileAtomic(p, 'hello');
    assert.equal(fs.readFileSync(p, 'utf8'), 'hello');
    // No .tmp file left
    assert.ok(!fs.existsSync(p + '.tmp'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeFileAtomic: creates parent directories', () => {
  const tmp = makeTmpDir();
  try {
    const p = path.join(tmp, 'deep', 'nested', 'a.txt');
    writeFileAtomic(p, 'hello');
    assert.equal(fs.readFileSync(p, 'utf8'), 'hello');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// -- clearDirectory ---------------------------------------------------------

test('clearDirectory: removes all contents of a directory', () => {
  const tmp = makeTmpDir();
  try {
    const sub = path.join(tmp, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.txt'), 'a');
    fs.writeFileSync(path.join(sub, 'b.txt'), 'b');
    fs.mkdirSync(path.join(sub, 'nested'));
    fs.writeFileSync(path.join(sub, 'nested', 'c.txt'), 'c');
    clearDirectory(sub);
    assert.equal(fs.readdirSync(sub).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('clearDirectory: missing directory is no-op', () => {
  const tmp = makeTmpDir();
  try {
    const missing = path.join(tmp, 'no-such');
    assert.doesNotThrow(() => clearDirectory(missing));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// -- fetchSystem ------------------------------------------------------------

function makeMockFetcher(map) {
  return (url) => {
    if (url.endsWith('/manifest.json')) {
      if (map.manifest == null) return Promise.reject(new Error('HTTP 404'));
      return Promise.resolve(map.manifest);
    }
    if (url.endsWith('/DESIGN.md')) {
      if (map.design == null) return Promise.reject(new Error('HTTP 404'));
      return Promise.resolve(map.design);
    }
    if (url.endsWith('/tokens.css')) {
      if (map.tokens == null) return Promise.reject(new Error('HTTP 404'));
      return Promise.resolve(map.tokens);
    }
    return Promise.reject(new Error('Unexpected URL: ' + url));
  };
}

test('fetchSystem: writes all 3 files atomically', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    const fetcher = makeMockFetcher({
      manifest: MANIFEST_JSON,
      design: DESIGN_MD,
      tokens: TOKENS_CSS,
    });
    const result = await fetchSystem({
      id: 'default',
      entry: { id: 'default', path: 'design-systems/default' },
      upstream: 'https://raw.example/main',
      destDir,
      fetcher,
    });
    assert.equal(result.id, 'default');
    assert.equal(result.files.manifest, 'manifest.json');
    assert.equal(result.files.design, 'DESIGN.md');
    assert.equal(result.files.tokens, 'tokens.css');
    assert.equal(result.sha256.manifest, sha256(MANIFEST_JSON));
    assert.equal(result.sha256.design, sha256(DESIGN_MD));
    assert.equal(result.sha256.tokens, sha256(TOKENS_CSS));
    // Files exist
    assert.equal(fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8'), MANIFEST_JSON);
    assert.equal(fs.readFileSync(path.join(destDir, 'DESIGN.md'), 'utf8'), DESIGN_MD);
    assert.equal(fs.readFileSync(path.join(destDir, 'tokens.css'), 'utf8'), TOKENS_CSS);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: missing DESIGN.md is OK (legacy support)', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    const fetcher = makeMockFetcher({
      manifest: MANIFEST_JSON,
      design: null, // legacy: no DESIGN.md
      tokens: TOKENS_CSS,
    });
    const result = await fetchSystem({
      id: 'legacy',
      entry: { id: 'legacy', path: 'design-systems/legacy' },
      upstream: 'https://raw.example/main',
      destDir,
      fetcher,
    });
    assert.equal(result.files.design, null);
    assert.equal(result.sha256.design, null);
    assert.ok(!fs.existsSync(path.join(destDir, 'DESIGN.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: missing tokens.css is OK (optional)', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    const fetcher = makeMockFetcher({
      manifest: MANIFEST_JSON,
      design: DESIGN_MD,
      tokens: null, // optional
    });
    const result = await fetchSystem({
      id: 'notokens',
      entry: { id: 'notokens', path: 'design-systems/notokens' },
      upstream: 'https://raw.example/main',
      destDir,
      fetcher,
    });
    assert.equal(result.files.tokens, null);
    assert.ok(!fs.existsSync(path.join(destDir, 'tokens.css')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: hash mismatch for manifest throws and writes nothing', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    const fetcher = makeMockFetcher({
      manifest: MANIFEST_JSON,
      design: DESIGN_MD,
      tokens: TOKENS_CSS,
    });
    await assert.rejects(
      () => fetchSystem({
        id: 'tampered',
        entry: { id: 'tampered', path: 'design-systems/tampered' },
        upstream: 'https://raw.example/main',
        destDir,
        fetcher,
        expectedHashes: {
          manifest: 'deadbeef'.repeat(8), // wrong hash
        },
      }),
      /Hash mismatch for manifest/
    );
    // No files written
    assert.ok(!fs.existsSync(path.join(destDir, 'manifest.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: hash mismatch for DESIGN.md throws', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    const fetcher = makeMockFetcher({
      manifest: MANIFEST_JSON,
      design: DESIGN_MD,
      tokens: TOKENS_CSS,
    });
    await assert.rejects(
      () => fetchSystem({
        id: 'tampered2',
        entry: { id: 'tampered2', path: 'design-systems/tampered2' },
        upstream: 'https://raw.example/main',
        destDir,
        fetcher,
        expectedHashes: { design: 'badbadbad'.repeat(8) },
      }),
      /Hash mismatch for design/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: invalid manifest JSON throws', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    const fetcher = makeMockFetcher({
      manifest: '{ not valid json',
      design: DESIGN_MD,
    });
    await assert.rejects(
      () => fetchSystem({
        id: 'badjson',
        entry: { id: 'badjson', path: 'design-systems/badjson' },
        upstream: 'https://raw.example/main',
        destDir,
        fetcher,
      }),
      /Invalid manifest\.json/
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: re-fetch clears previous contents', async () => {
  const tmp = makeTmpDir();
  try {
    const destDir = path.join(tmp, 'dest');
    fs.mkdirSync(destDir, { recursive: true });
    // Stale leftover
    fs.writeFileSync(path.join(destDir, 'leftover.txt'), 'stale');

    const fetcher = makeMockFetcher({
      manifest: MANIFEST_JSON,
      design: DESIGN_MD,
    });
    await fetchSystem({
      id: 'default',
      entry: { id: 'default', path: 'design-systems/default' },
      upstream: 'https://raw.example/main',
      destDir,
      fetcher,
    });
    assert.ok(!fs.existsSync(path.join(destDir, 'leftover.txt')), 'stale file should be removed');
    assert.ok(fs.existsSync(path.join(destDir, 'manifest.json')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchSystem: id is required', async () => {
  await assert.rejects(
    () => fetchSystem({ fetcher: () => Promise.resolve('') }),
    /id is required/
  );
});
