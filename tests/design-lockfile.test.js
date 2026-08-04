'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readLockfile,
  writeLockfile,
  addSystem,
  removeSystem,
  getSystem,
  listSystems,
  upgradeSystems,
  getLockfilePath,
  LOCKFILE_VERSION,
  SCHEMA_VERSION,
} = require('../lib/design/lockfile');

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-design-lockfile-'));
}

// -- getLockfilePath --------------------------------------------------------

test('getLockfilePath: under <cwd>/.agent/design-systems.lock', () => {
  const p = getLockfilePath('/tmp/proj');
  assert.equal(p, '/tmp/proj/.agent/design-systems.lock');
});

test('getLockfilePath: defaults to process.cwd()', () => {
  const p = getLockfilePath();
  assert.ok(p.endsWith(path.join('.agent', 'design-systems.lock')));
});

// -- readLockfile -----------------------------------------------------------

test('readLockfile: nonexistent returns empty lockfile', () => {
  const cwd = makeTmpCwd();
  try {
    const lock = readLockfile(cwd);
    assert.equal(lock.lockfileVersion, LOCKFILE_VERSION);
    assert.equal(lock.schemaVersion, SCHEMA_VERSION);
    assert.equal(lock.fetched_at, null);
    assert.equal(lock.upstream, null);
    assert.deepEqual(lock.systems, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('readLockfile: corrupted JSON throws', () => {
  const cwd = makeTmpCwd();
  try {
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'design-systems.lock'), '{ not valid json');
    assert.throws(() => readLockfile(cwd), /Failed to parse lockfile/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('readLockfile: wrong version throws', () => {
  const cwd = makeTmpCwd();
  try {
    fs.mkdirSync(path.join(cwd, '.agent'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.agent', 'design-systems.lock'),
      JSON.stringify({ lockfileVersion: 99, systems: [] }));
    assert.throws(() => readLockfile(cwd), /Lockfile version mismatch/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- writeLockfile ----------------------------------------------------------

test('writeLockfile: creates .agent dir and writes file', () => {
  const cwd = makeTmpCwd();
  try {
    const data = {
      lockfileVersion: LOCKFILE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      fetched_at: '2026-08-04T12:00:00.000Z',
      upstream: 'https://example.com',
      systems: [{ id: 'default' }],
    };
    writeLockfile(cwd, data);
    assert.ok(fs.existsSync(path.join(cwd, '.agent', 'design-systems.lock')));
    const read = JSON.parse(fs.readFileSync(path.join(cwd, '.agent', 'design-systems.lock'), 'utf8'));
    assert.equal(read.upstream, 'https://example.com');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeLockfile: atomic — no .tmp file left', () => {
  const cwd = makeTmpCwd();
  try {
    writeLockfile(cwd, {
      lockfileVersion: LOCKFILE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      fetched_at: null,
      upstream: null,
      systems: [],
    });
    assert.ok(!fs.existsSync(path.join(cwd, '.agent', 'design-systems.lock.tmp')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- addSystem --------------------------------------------------------------

test('addSystem: adds a new system', () => {
  const cwd = makeTmpCwd();
  try {
    const data = addSystem(cwd, {
      id: 'default',
      sha256_manifest: 'aaa',
      license: 'Apache-2.0',
    });
    assert.equal(data.systems.length, 1);
    assert.equal(data.systems[0].id, 'default');
    assert.ok(data.systems[0].fetched_at);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('addSystem: replaces existing entry', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default', sha256_manifest: 'aaa' });
    addSystem(cwd, { id: 'default', sha256_manifest: 'bbb' });
    const lock = readLockfile(cwd);
    assert.equal(lock.systems.length, 1);
    assert.equal(lock.systems[0].sha256_manifest, 'bbb');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('addSystem: requires id', () => {
  const cwd = makeTmpCwd();
  try {
    assert.throws(() => addSystem(cwd, { sha256_manifest: 'aaa' }), /entry.id is required/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- removeSystem -----------------------------------------------------------

test('removeSystem: removes existing entry', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default' });
    addSystem(cwd, { id: 'linear-app' });
    const { data, changed } = removeSystem(cwd, 'default');
    assert.equal(changed, true);
    assert.equal(data.systems.length, 1);
    assert.equal(data.systems[0].id, 'linear-app');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('removeSystem: not found returns changed=false', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default' });
    const { changed } = removeSystem(cwd, 'no-such');
    assert.equal(changed, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- getSystem / listSystems ------------------------------------------------

test('getSystem: returns matching system', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default', license: 'Apache-2.0' });
    addSystem(cwd, { id: 'linear-app', license: 'MIT' });
    const sys = getSystem(cwd, 'linear-app');
    assert.equal(sys.id, 'linear-app');
    assert.equal(sys.license, 'MIT');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('getSystem: returns null when not found', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default' });
    assert.equal(getSystem(cwd, 'no-such'), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('listSystems: returns copy of array', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default' });
    addSystem(cwd, { id: 'linear-app' });
    const list = listSystems(cwd);
    assert.equal(list.length, 2);
    // Mutating returned array does not affect lockfile
    list.pop();
    const lock2 = readLockfile(cwd);
    assert.equal(lock2.systems.length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// -- upgradeSystems ---------------------------------------------------------

test('upgradeSystems: updates matching entries', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default', sha256_manifest: 'aaa' });
    addSystem(cwd, { id: 'linear-app', sha256_manifest: 'xxx' });
    const { changed } = upgradeSystems(cwd, {
      'default': { sha256_manifest: 'bbb' },
      'linear-app': { sha256_manifest: 'yyy' },
    });
    assert.equal(changed, 2);
    const lock = readLockfile(cwd);
    const def = lock.systems.find((s) => s.id === 'default');
    const lin = lock.systems.find((s) => s.id === 'linear-app');
    assert.equal(def.sha256_manifest, 'bbb');
    assert.equal(lin.sha256_manifest, 'yyy');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('upgradeSystems: unchanged when no matches', () => {
  const cwd = makeTmpCwd();
  try {
    addSystem(cwd, { id: 'default' });
    const { changed } = upgradeSystems(cwd, { 'no-such': { sha256_manifest: 'bbb' } });
    assert.equal(changed, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
