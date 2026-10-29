'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');
const { createGitTransactionStore, GIT_TRANSACTION_REF: REF } = require('../../lib/governance/git-transaction-store');

const GIT = fs.realpathSync('/usr/bin/git');
const ZERO = '0'.repeat(40);
const FIXED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'core.logAllRefUpdates=false', '-c', 'protocol.allow=never'];
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function environment(home) {
  return { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C', LANG: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Synthetic transaction test', GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_NAME: 'Synthetic transaction test', GIT_COMMITTER_EMAIL: 'fixture@localhost' };
}
function command(repo, args) { return ['--no-pager', '--git-dir=' + repo, ...FIXED, ...args]; }
function git(f, args, input) {
  const result = cp.spawnSync(GIT, command(f.repo, args), { cwd: f.base, env: environment(f.base),
    shell: false, input, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1048576 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
function inventory(root) {
  const result = {};
  function visit(dir, relative) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name); const rel = relative ? relative + '/' + name : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) result[rel] = { symlink: fs.readlinkSync(full) };
      else if (st.isDirectory()) { result[rel + '/'] = 'directory'; visit(full, rel); }
      else result[rel] = { bytes: st.size, sha256: sha(fs.readFileSync(full)) };
    }
  }
  visit(root, ''); return result;
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-git-tx-'));
  const repo = path.join(base, 'repo.git'); const template = path.join(base, 'empty-template');
  fs.mkdirSync(template); fs.writeFileSync(path.join(base, 'outside-sentinel'), 'unchanged\n');
  const result = cp.spawnSync(GIT, [...FIXED, 'init', '--bare', '--object-format=sha1',
    '--initial-branch=unused', '--template=' + template, repo], {
    cwd: base, env: environment(base), shell: false, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1048576 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr);
  const f = { base, repo, retain: false };
  f.open = () => createGitTransactionStore({ repo, ref: REF, gitExecutable: GIT });
  t.after(() => {
    assert.equal(fs.readFileSync(path.join(base, 'outside-sentinel'), 'utf8'), 'unchanged\n');
    if (!f.retain) fs.rmSync(base, { recursive: true, force: true });
  });
  f.store = f.open(); return f;
}
function prepare(store, rev, id, writes) {
  return store.prepareBatch({ expected_revision: rev, transaction_id: id, writes });
}
function one(key, content) { return [{ key, content }]; }
function seed(f) {
  const p = prepare(f.store, null, 'seed', [
    { key: 'authority/authorization.json', content: '{"fixture":true,"revoked":false,"consumed":false}' },
    { key: 'authority/lease.json', content: '{"fixture":true,"fence":1}' }
  ]);
  assert.equal(f.store.publishPrepared(p.handle).status, 'PUBLISHED'); return { store_kind: 'git', value: p.evidence.prepared_commit };
}
function effects(label) {
  const content = label + '\n';
  return [
    { key: 'authority/authorization.json', content: JSON.stringify({ fixture: true, revoked: false, consumed: true, run: label }) },
    { key: 'authority/lease.json', content: JSON.stringify({ fixture: true, fence: 2, run: label }) },
    { key: 'operations/run.json', content: JSON.stringify({ fixture: true, runtime_evidence: label }) },
    { key: 'artifacts/result.txt', content },
    { key: 'receipts/result.json', content: JSON.stringify({ fixture: true, run: label, artifact_sha256: sha(content) }) }
  ];
}
function checkBundle(f, expected) {
  const snapshot = f.open().readSnapshot(effects(expected).map(x => x.key));
  for (const item of effects(expected)) assert.equal(snapshot.records[item.key].content, item.content);
  assert.equal(JSON.parse(snapshot.records['receipts/result.json'].content).artifact_sha256,
    snapshot.records['artifacts/result.txt'].sha256);
  return snapshot;
}
function noObjectWrites(t, f, action, code) {
  const before = inventory(f.repo); const original = cp.spawnSync; let writes = 0;
  const mock = t.mock.method(cp, 'spawnSync', (...args) => {
    if (args[1].some(x => ['hash-object', 'mktree', 'commit-tree', 'update-ref'].includes(x))) writes++;
    return original(...args);
  });
  try { assert.throws(action, error => error.code === code); assert.equal(writes, 0); }
  finally { mock.mock.restore(); }
  assert.deepEqual(inventory(f.repo), before);
}
async function competingGit(f, commits, base) {
  // Two actual, owned Git leaders. No shell, hook, remote, model or injected exit.
  const children = commits.map(commit => cp.spawn(GIT,
    command(f.repo, ['update-ref', '--no-deref', REF, commit, base]), {
      cwd: f.base, env: environment(f.base), shell: false, stdio: ['ignore', 'pipe', 'pipe']
    }));
  const outcomes = await Promise.allSettled(children.map(child => new Promise((resolve, reject) => {
    let output = ''; let closed = false; let spawnError = null;
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 16384) child.kill('SIGKILL'); });
    child.stderr.on('data', bytes => { output += bytes.toString(); if (output.length > 16384) child.kill('SIGKILL'); });
    child.once('error', error => { spawnError = error; });
    const stop = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 2000);
    const watchdog = setTimeout(() => {
      if (!closed) { f.retain = true; reject(new Error('OWNED_GIT_EXIT_UNOBSERVED')); }
    }, 3500);
    child.once('close', (code, signal) => {
      closed = true; clearTimeout(stop); clearTimeout(watchdog);
      if (spawnError) reject(spawnError); else resolve({ code, signal, output });
    });
  })));
  const failed = outcomes.find(x => x.status === 'rejected');
  if (failed) throw failed.reason;
  return outcomes.map(x => x.value);
}

test('local Git transaction storage (fresh synthetic repositories only)', { concurrency: 1 }, async t => {
  await t.test('empty snapshot is read-only and grants no authority', t => {
    const f = fixture(t); const before = inventory(f.repo); const got = f.store.readSnapshot(['artifacts/result.txt']);
    assert.equal(got.revision, null); assert.equal(got.records['artifacts/result.txt'], null);
    assert.equal(got.effect_authority, false); assert.deepEqual(inventory(f.repo), before);
  });
  await t.test('prepared bundle is persisted but invisible until one ref publication', t => {
    const f = fixture(t); const base = seed(f); const prepared = prepare(f.store, base, 'effect', effects('one'));
    assert.equal(prepared.evidence.phase, 'prepare-object'); assert.equal(prepared.evidence.objects_may_exist, true);
    assert.equal(prepared.evidence.publication, 'NOT_ATTEMPTED');
    assert.equal(f.store.readSnapshot(['artifacts/result.txt']).records['artifacts/result.txt'], null);
    assert.equal(git(f, ['cat-file', '-t', prepared.evidence.prepared_commit]).trim(), 'commit');
    const result = f.store.publishPrepared(prepared.handle);
    assert.equal(result.status, 'PUBLISHED'); assert.equal(result.evidence.publish_attempted, true);
    assert.equal(result.evidence.published_revision.value, prepared.evidence.prepared_commit);
    const snapshot = checkBundle(f, 'one'); assert.equal(snapshot.revision.value, prepared.evidence.prepared_commit);
    assert.deepEqual(git(f, ['cat-file', '-p', snapshot.revision.value]).split('\n').filter(x => x.startsWith('parent ')),
      ['parent ' + base.value]);
  });
  await t.test('snapshot pins all keys to one captured commit during another publication', t => {
    const f = fixture(t); const base = seed(f);
    const first = prepare(f.store, base, 'one', effects('one')); f.store.publishPrepared(first.handle);
    const other = f.open(); const next = prepare(other, { store_kind: 'git', value: first.evidence.prepared_commit }, 'two', effects('two'));
    const original = cp.spawnSync; let switched = false;
    const mock = t.mock.method(cp, 'spawnSync', (...args) => {
      if (!switched && args[1].includes('ls-tree')) { switched = true; assert.equal(other.publishPrepared(next.handle).status, 'PUBLISHED'); }
      return original(...args);
    });
    let snapshot;
    try { snapshot = f.store.readSnapshot(effects('one').map(x => x.key)); }
    finally { mock.mock.restore(); }
    assert.equal(switched, true); assert.equal(snapshot.revision.value, first.evidence.prepared_commit);
    for (const item of effects('one')) assert.equal(snapshot.records[item.key].content, item.content);
    checkBundle(f, 'two');
  });
  await t.test('two prepared writers have one winner; loser objects remain durable', t => {
    const f = fixture(t); const base = seed(f); const other = f.open();
    const a = prepare(f.store, base, 'a', effects('a')); const b = prepare(other, base, 'b', effects('b'));
    assert.equal(f.store.publishPrepared(a.handle).status, 'PUBLISHED');
    const lost = other.publishPrepared(b.handle); assert.equal(lost.status, 'CONFLICT');
    assert.equal(lost.evidence.publish_attempted, false); assert.equal(lost.evidence.objects_may_exist, true);
    checkBundle(f, 'a'); assert.equal(git(f, ['cat-file', '-t', b.evidence.prepared_commit]).trim(), 'commit');
    for (const blob of b.evidence.prepared_blobs) assert.equal(git(f, ['cat-file', '-t', blob]).trim(), 'blob');
  });
  await t.test('publication raced after precheck uses actual Git CAS and preserves the winning complete bundle', t => {
    const f = fixture(t); const base = seed(f); const other = f.open();
    const a = prepare(f.store, base, 'a', effects('a')); const b = prepare(other, base, 'b', effects('b'));
    const original = cp.spawnSync; let raced = false;
    const mock = t.mock.method(cp, 'spawnSync', (...args) => {
      if (!raced && args[1].includes('update-ref')) { raced = true; assert.equal(other.publishPrepared(b.handle).status, 'PUBLISHED'); }
      return original(...args);
    });
    let result; try { result = f.store.publishPrepared(a.handle); } finally { mock.mock.restore(); }
    assert.equal(raced, true); assert.equal(result.status, 'CONFLICT'); assert.equal(result.evidence.publish_attempted, true);
    assert.equal(result.evidence.reason, 'CAS_REJECTED'); checkBundle(f, 'b');
    assert.equal(git(f, ['cat-file', '-t', a.evidence.prepared_commit]).trim(), 'commit');
  });
  await t.test('two simultaneous real update-ref processes publish exactly one complete bundle', async t => {
    const f = fixture(t); const base = seed(f);
    const a = prepare(f.store, base, 'a', effects('a')); const b = prepare(f.open(), base, 'b', effects('b'));
    const results = await competingGit(f, [a.evidence.prepared_commit, b.evidence.prepared_commit], base.value);
    assert.equal(results.filter(x => x.code === 0 && x.signal === null).length, 1);
    assert.equal(results.filter(x => x.code !== 0 && x.signal === null).length, 1);
    const winner = results[0].code === 0 ? 'a' : 'b'; checkBundle(f, winner);
    for (const candidate of [a, b]) assert.equal(git(f, ['cat-file', '-t', candidate.evidence.prepared_commit]).trim(), 'commit');
  });
  await t.test('revocation bundle wins before effect CAS; canonical artifact and receipt stay absent', t => {
    const f = fixture(t); const base = seed(f); const other = f.open();
    const effect = prepare(f.store, base, 'effect', effects('effect'));
    const revoke = prepare(other, base, 'revoke',
      one('authority/authorization.json', '{"fixture":true,"revoked":true,"consumed":false}'));
    assert.equal(other.publishPrepared(revoke.handle).status, 'PUBLISHED');
    assert.equal(f.store.publishPrepared(effect.handle).status, 'CONFLICT');
    const snapshot = f.open().readSnapshot(['authority/authorization.json', 'artifacts/result.txt', 'receipts/result.json']);
    assert.equal(JSON.parse(snapshot.records['authority/authorization.json'].content).revoked, true);
    assert.equal(snapshot.records['artifacts/result.txt'], null); assert.equal(snapshot.records['receipts/result.json'], null);
    assert.equal(git(f, ['cat-file', '-t', effect.evidence.prepared_commit]).trim(), 'commit');
  });
  await t.test('prepared but unpublished object models crash residue without canonical publication', t => {
    const f = fixture(t); const base = seed(f);
    const prepared = prepare(f.store, base, 'unpublished', effects('unpublished'));
    const restarted = f.open().readSnapshot(['artifacts/result.txt']);
    assert.equal(restarted.revision.value, base.value); assert.equal(restarted.records['artifacts/result.txt'], null);
    assert.equal(git(f, ['cat-file', '-t', prepared.evidence.prepared_commit]).trim(), 'commit');
  });
  for (const [label, mutate, code] of [
    ['unknown request field', r => ({ ...r, approved: true }), 'INVALID_INPUT'],
    ['untyped revision', r => ({ ...r, expected_revision: ZERO }), 'INVALID_REVISION'],
    ['wrong revision kind', r => ({ ...r, expected_revision: { store_kind: 'fs', value: 'a'.repeat(40) } }), 'INVALID_REVISION'],
    ['zero revision', r => ({ ...r, expected_revision: { store_kind: 'git', value: ZERO } }), 'INVALID_REVISION'],
    ['duplicate keys', r => ({ ...r, writes: [...r.writes, ...r.writes] }), 'DUPLICATE_KEY'],
    ['path traversal', r => ({ ...r, writes: one('../outside', 'x') }), 'INVALID_KEY'],
    ['absolute path', r => ({ ...r, writes: one('/tmp/outside', 'x') }), 'INVALID_KEY'],
    ['delete operation', r => ({ ...r, writes: [{ key: 'x', delete: true }] }), 'INVALID_INPUT'],
    ['executable mode', r => ({ ...r, writes: [{ key: 'x', content: 'x', mode: '100755' }] }), 'INVALID_INPUT'],
    ['malformed surrogate', r => ({ ...r, writes: one('x', '\ud800') }), 'INVALID_CONTENT'],
    ['raw invalid UTF8 is not a text input', r => ({ ...r, writes: one('x', Buffer.from([255])) }), 'INVALID_CONTENT'],
    ['item too large', r => ({ ...r, writes: one('x', 'x'.repeat(65537)) }), 'INVALID_CONTENT'],
    ['batch bytes too large', r => ({ ...r, writes: Array.from({ length: 5 }, (_, i) => ({ key: 'k' + i, content: 'x'.repeat(65536) })) }), 'BATCH_LIMIT'],
    ['too many keys', r => ({ ...r, writes: Array.from({ length: 65 }, (_, i) => ({ key: 'k' + i, content: 'x' })) }), 'INVALID_WRITES'],
    ['prefix collision', r => ({ ...r, writes: [{ key: 'x', content: 'x' }, { key: 'x/y', content: 'y' }] }), 'KEY_PREFIX_CONFLICT']
  ]) await t.test('invalid ' + label + ' is rejected before object writes', t => {
    const f = fixture(t);
    const request = mutate({ expected_revision: null, transaction_id: 'invalid', writes: one('x', 'x') });
    noObjectWrites(t, f, () => f.store.prepareBatch(request), code);
  });
  await t.test('stale revision is rejected before any preparation writes', t => {
    const f = fixture(t); seed(f);
    noObjectWrites(t, f, () => prepare(f.store, null, 'stale', effects('stale')), 'REVISION_CONFLICT');
  });
  await t.test('merged total limit includes existing unchanged records before new objects', t => {
    const f = fixture(t);
    const a = prepare(f.store, null, 'full', Array.from({ length: 4 }, (_, i) => ({ key: 'k' + i, content: 'x'.repeat(65536) })));
    assert.equal(f.store.publishPrepared(a.handle).status, 'PUBLISHED');
    noObjectWrites(t, f, () => prepare(f.store, { store_kind: 'git', value: a.evidence.prepared_commit }, 'over', one('k4', 'x')), 'BATCH_LIMIT');
  });
  await t.test('oversized text is rejected before UTF8 allocation or any Git invocation', t => {
    const f = fixture(t); const large = 'x'.repeat(65537); const before = inventory(f.repo);
    const from = Buffer.from; let allocations = 0; let calls = 0;
    const bufferMock = t.mock.method(Buffer, 'from', (...args) => {
      if (args[0] === large) { allocations++; throw new Error('unexpected large allocation'); }
      return from(...args);
    });
    const spawnMock = t.mock.method(cp, 'spawnSync', () => { calls++; throw new Error('unexpected Git'); });
    try {
      assert.throws(() => prepare(f.store, null, 'large', one('x', large)), { code: 'INVALID_CONTENT' });
      assert.equal(allocations, 0); assert.equal(calls, 0);
    } finally { spawnMock.mock.restore(); bufferMock.mock.restore(); }
    assert.deepEqual(inventory(f.repo), before);
  });
  await t.test('simulated foreign-owner config is rejected before opening it or invoking Git', t => {
    const f = fixture(t); const before = inventory(f.repo); const stat = fs.lstatSync; const open = fs.openSync;
    let configOpens = 0; let calls = 0;
    const statMock = t.mock.method(fs, 'lstatSync', (...args) => {
      const result = stat(...args);
      return args[0] === path.join(f.repo, 'config')
        ? Object.assign(Object.create(Object.getPrototypeOf(result)), result, { uid: process.getuid() + 1 })
        : result;
    });
    const openMock = t.mock.method(fs, 'openSync', (...args) => {
      if (args[0] === path.join(f.repo, 'config')) configOpens++;
      return open(...args);
    });
    const spawnMock = t.mock.method(cp, 'spawnSync', () => { calls++; throw new Error('unexpected Git'); });
    try {
      assert.throws(() => f.store.readSnapshot(['x']), { code: 'UNSAFE_FILE' });
      assert.equal(configOpens, 0); assert.equal(calls, 0);
    } finally { spawnMock.mock.restore(); openMock.mock.restore(); statMock.mock.restore(); }
    assert.deepEqual(inventory(f.repo), before);
  });
  await t.test('opaque handles reject forgery, cross instance and repeated publication', t => {
    const f = fixture(t); const a = prepare(f.store, null, 'a', one('x', 'x')); const other = f.open();
    assert.throws(() => f.store.publishPrepared({}), { code: 'INVALID_OR_CONSUMED_HANDLE' });
    assert.throws(() => other.publishPrepared(a.handle), { code: 'INVALID_OR_CONSUMED_HANDLE' });
    assert.equal(f.store.publishPrepared(a.handle).status, 'PUBLISHED');
    assert.throws(() => f.store.publishPrepared(a.handle), { code: 'INVALID_OR_CONSUMED_HANDLE' });
  });
  await t.test('unknown publish exit keeps prepared evidence and quarantines the consumed handle', t => {
    const f = fixture(t); const a = prepare(f.store, null, 'a', one('x', 'x')); const before = inventory(f.repo);
    const original = cp.spawnSync;
    const mock = t.mock.method(cp, 'spawnSync', (...args) => args[1].includes('update-ref')
      ? { error: Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' }), signal: 'SIGKILL', status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
      : original(...args));
    let result; try { result = f.store.publishPrepared(a.handle); } finally { mock.mock.restore(); }
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.evidence.prepared_commit, a.evidence.prepared_commit);
    assert.equal(result.evidence.publish_attempted, true); assert.equal(result.evidence.objects_may_exist, true);
    assert.throws(() => f.store.readSnapshot(['x']), { code: 'STORE_QUARANTINED' });
    assert.throws(() => f.store.publishPrepared(a.handle), { code: 'INVALID_OR_CONSUMED_HANDLE' });
    assert.deepEqual(inventory(f.repo), before);
  });
  await t.test('reported timeout after actual publication remains UNKNOWN with observed ref evidence', t => {
    const f = fixture(t); const a = prepare(f.store, null, 'a', one('x', 'x')); const original = cp.spawnSync;
    const mock = t.mock.method(cp, 'spawnSync', (...args) => {
      const result = original(...args);
      return args[1].includes('update-ref') ? { ...result, error: Object.assign(new Error('synthetic lost exit'), { code: 'ETIMEDOUT' }) } : result;
    });
    let result; try { result = f.store.publishPrepared(a.handle); } finally { mock.mock.restore(); }
    assert.equal(result.status, 'UNKNOWN'); assert.equal(result.evidence.observed_revision.value, a.evidence.prepared_commit);
    assert.equal(f.open().readSnapshot(['x']).records.x.content, 'x');
  });
  for (const [name, mutate] of [
    ['group-writable config', f => fs.chmodSync(path.join(f.repo, 'config'), 0o660)],
    ['world-writable HEAD', f => fs.chmodSync(path.join(f.repo, 'HEAD'), 0o666)],
    ['writable canonical ref', f => { seed(f); fs.chmodSync(path.join(f.repo, REF), 0o666); }],
    ['include config', f => fs.appendFileSync(path.join(f.repo, 'config'), '[include]\n path = ../outside-sentinel\n')],
    ['remote/promisor config', f => fs.appendFileSync(path.join(f.repo, 'config'), '[remote "origin"]\n promisor = true\n')],
    ['alternates file', f => fs.writeFileSync(path.join(f.repo, 'objects/info/alternates'), '../elsewhere\n')],
    ['promisor pack marker', f => fs.writeFileSync(path.join(f.repo, 'objects/pack/x.promisor'), '')],
    ['hooks directory', f => fs.mkdirSync(path.join(f.repo, 'hooks'))],
    ['replace ref', f => { fs.mkdirSync(path.join(f.repo, 'refs/replace')); }],
    ['config symlink', f => { fs.renameSync(path.join(f.repo, 'config'), path.join(f.base, 'saved-config')); fs.symlinkSync(path.join(f.base, 'saved-config'), path.join(f.repo, 'config')); }],
    ['object directory replacement', f => { fs.renameSync(path.join(f.repo, 'objects'), path.join(f.base, 'old-objects')); fs.mkdirSync(path.join(f.repo, 'objects')); fs.mkdirSync(path.join(f.repo, 'objects/info')); fs.mkdirSync(path.join(f.repo, 'objects/pack')); }]
  ]) await t.test(name + ' is rejected before any Git subprocess', t => {
    const f = fixture(t); mutate(f); const before = inventory(f.repo); let calls = 0;
    const mock = t.mock.method(cp, 'spawnSync', () => { calls++; throw new Error('unexpected Git'); });
    try { assert.throws(() => f.store.readSnapshot(['x'])); assert.equal(calls, 0); }
    finally { mock.mock.restore(); }
    assert.deepEqual(inventory(f.repo), before);
  });
  await t.test('all actual plumbing invocations use fixed bounded sanitized process options', t => {
    const f = fixture(t); const original = cp.spawnSync; const observed = [];
    const mock = t.mock.method(cp, 'spawnSync', (...args) => { observed.push(args); return original(...args); });
    try { const a = prepare(f.store, null, 'a', one('x', 'x')); assert.equal(f.store.publishPrepared(a.handle).status, 'PUBLISHED'); }
    finally { mock.mock.restore(); }
    assert.ok(observed.length >= 4);
    for (const [file, args, options] of observed) {
      assert.equal(file, GIT); assert.equal(options.shell, false); assert.equal(options.cwd, f.repo);
      assert.ok(options.timeout > 0 && options.timeout <= 1500); assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 1048576); assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(options.env.GIT_NO_LAZY_FETCH, '1');
      for (const forbidden of ['NODE_OPTIONS', 'NODE_PATH', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND',
        'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) assert.equal(options.env[forbidden], undefined);
      assert.ok(args.includes('core.hooksPath=/dev/null')); assert.ok(args.includes('commit.gpgSign=false'));
      assert.ok(!args.includes('push') && !args.includes('fetch') && !args.includes('checkout'));
    }
  });
  await t.test('already symbolic canonical ref is rejected before object writes', t => {
    const f = fixture(t); seed(f);
    fs.writeFileSync(path.join(f.repo, REF), 'ref: refs/heads/unused\n');
    noObjectWrites(t, f, () => prepare(f.store, null, 'symref', one('x', 'x')), 'NON_DIRECT_REF');
  });
  await t.test('actual Git no-deref can replace a concurrent matching-old symref; this remains unsupported', t => {
    const f = fixture(t); const base = seed(f); const a = prepare(f.store, base, 'a', effects('a'));
    const original = cp.spawnSync; let injected = false;
    const mock = t.mock.method(cp, 'spawnSync', (...args) => {
      if (!injected && args[1].includes('update-ref')) {
        injected = true;
        // Deliberate unsupported writer, after the store's last guard and before actual Git.
        fs.writeFileSync(path.join(f.repo, 'refs/heads/unused'), base.value + '\n');
        fs.writeFileSync(path.join(f.repo, REF), 'ref: refs/heads/unused\n');
      }
      return original(...args);
    });
    let result; try { result = f.store.publishPrepared(a.handle); } finally { mock.mock.restore(); }
    assert.equal(injected, true); assert.equal(result.status, 'UNKNOWN');
    assert.equal(fs.readFileSync(path.join(f.repo, REF), 'utf8'), a.evidence.prepared_commit + '\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'refs/heads/unused'), 'utf8'), base.value + '\n');
    assert.throws(() => f.store.readSnapshot(['x']), { code: 'STORE_QUARANTINED' });
  });
  await t.test('raw blob corruption is rejected by explicit Git blob digest verification', t => {
    const f = fixture(t); const prepared = prepare(f.store, null, 'blob', one('x', 'original'));
    assert.equal(f.store.publishPrepared(prepared.handle).status, 'PUBLISHED');
    const oid = prepared.evidence.prepared_blobs[0]; const file = path.join(f.repo, 'objects', oid.slice(0, 2), oid.slice(2));
    fs.unlinkSync(file);
    fs.writeFileSync(file, zlib.deflateSync(Buffer.from('blob 8\0modified')), { mode: 0o600 });
    const before = inventory(f.repo);
    assert.throws(() => f.store.readSnapshot(['x']), { code: 'OBJECT_DIGEST_MISMATCH' });
    assert.deepEqual(inventory(f.repo), before);
  });
  await t.test('known publication remains PUBLISHED when the cooperative elapsed budget is exceeded afterward', t => {
    const f = fixture(t); const prepared = prepare(f.store, null, 'elapsed', one('x', 'x'));
    const original = cp.spawnSync; let clock = 100; const now = t.mock.method(performance, 'now', () => clock);
    const spawn = t.mock.method(cp, 'spawnSync', (...args) => {
      const result = original(...args);
      if (args[1].includes('update-ref')) clock += 15001;
      return result;
    });
    let result;
    try { result = f.store.publishPrepared(prepared.handle); }
    finally { spawn.mock.restore(); now.mock.restore(); }
    assert.equal(result.status, 'PUBLISHED'); assert.equal(result.evidence.publish_budget_exhausted, true);
    assert.equal(result.evidence.operation_budget_ms, 15000); assert.equal(result.evidence.publish_elapsed_ms, 15001);
    assert.ok(prepared.evidence.prepare_elapsed_ms >= 0);
    assert.equal(result.evidence.published_revision.value, prepared.evidence.prepared_commit);
    assert.equal(f.open().readSnapshot(['x']).records.x.content, 'x');
  });
  await t.test('observed ref rollback quarantines instead of accepting a prior revision', t => {
    const f = fixture(t); const base = seed(f); const a = prepare(f.store, base, 'a', effects('a'));
    f.store.publishPrepared(a.handle); git(f, ['update-ref', '--no-deref', REF, base.value, a.evidence.prepared_commit]);
    assert.throws(() => f.store.readSnapshot(['x']), { code: 'REF_HISTORY_UNVERIFIED' });
    assert.throws(() => f.store.readSnapshot(['x']), { code: 'STORE_QUARANTINED' });
  });
});
