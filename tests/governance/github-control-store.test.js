'use strict';

// Synthetic/offline only. Every real Git child is denied network protocols.
// The production module has no injected runner, URL override, or testMode option.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const SOURCE = path.join(__dirname, '../../lib/governance/github-control-store.js');
const GIT = fs.realpathSync('/usr/bin/git');
const REPO = 'Kucell/cortex-agent-agent';
const ORIGIN = 'https://github.com/' + REPO + '.git';
const REF = 'refs/heads/cortex-authority/11111111-1111-4111-8111-111111111111';
const LOCAL_REF = 'refs/cortex/state';
const CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';
const FAKE_TOKEN = 'SYNTHETIC_OFFLINE_TOKEN_NEVER_A_CREDENTIAL';
const pinned = ['decisions/index.json', 'decisions/D-fixture.json', 'waitpoints/index.json',
  'waitpoints/WP-fixture.json', 'scopes/fixture.json', 'tasks/fixture.json'];
const binding = () => ({ kind: 'github-ref', repository_id: '1266950600', repository: REPO, authority_ref: REF });
const revision = value => ({ store_kind: 'git', value });
const sha = content => crypto.createHash('sha256').update(content).digest('hex');

function bare(dir) {
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of ['objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags'])
    fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'config'), CONFIG, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/unused\n', { mode: 0o600 });
}
function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cortex-remote-fixture-'));
  fs.chmodSync(base, 0o700);
  const remote = path.join(base, 'remote.git'); bare(remote);
  const sentinel = path.join(base, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  const realSpawn = cp.spawnSync.bind(cp);
  const realMkdtemp = fs.mkdtempSync.bind(fs);
  const realRemove = fs.rmSync.bind(fs);
  const f = { base, remote, calls: [], api: 0, pushes: 0, children: 0, stores: [],
    stale: undefined, timeoutAfterPush: false, failReads: false, suppressPush: false, forcePack: false, afterPush: null };
  const env = {
    PATH: '/usr/bin:/bin', HOME: base, XDG_CONFIG_HOME: base, LC_ALL: 'C', LANG: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file', GIT_AUTHOR_NAME: 'Offline fixture',
    GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Offline fixture',
    GIT_COMMITTER_EMAIL: 'fixture@localhost'
  };
  const fixed = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'core.logAllRefUpdates=false', '-c', 'commit.gpgSign=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never'];
  f.git = (args, input) => {
    assert.ok(['rev-parse', 'for-each-ref', 'cat-file', 'hash-object', 'mktree',
      'commit-tree', 'update-ref'].includes(args[0]));
    assert.ok(++f.children <= 600);
    const result = realSpawn(GIT, ['--no-pager', '--git-dir=' + remote, ...fixed, ...args],
      { cwd: base, env, input, encoding: 'utf8', shell: false, timeout: 5000,
        killSignal: 'SIGKILL', maxBuffer: 1048576 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 0, 'offline fixture Git failed');
    return result.stdout.trim();
  };
  f.tip = () => f.git(['rev-parse', '--verify', REF]);
  f.refs = () => f.git(['for-each-ref', '--format=%(refname)']);
  const allowed = new Set(['ls-remote', 'fetch', 'push', 'unpack-objects', 'cat-file',
    'ls-tree', 'hash-object', 'mktree', 'commit-tree', 'update-ref', 'merge-base']);
  const spawnMock = t.mock.method(cp, 'spawnSync', (executable, args, options) => {
    assert.equal(executable, GIT);
    assert.equal(options.shell, false);
    assert.ok(options.cwd.startsWith(base + '/'));
    assert.ok(args.includes('--git-dir=' + options.cwd));
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.ok(args.includes('core.hooksPath=/dev/null'));
    const verb = args.find(arg => allowed.has(arg));
    assert.ok(verb, 'unknown Git verb must never run');
    assert.ok(++f.children <= 600);
    f.calls.push({ verb, args: [...args] });
    const network = ['ls-remote', 'fetch', 'push'].includes(verb);
    let mapped = [...args];
    const childEnv = { ...options.env, GIT_ALLOW_PROTOCOL: 'file' };
    if (network) {
      assert.equal(args.filter(arg => arg === ORIGIN).length, 1);
      assert.equal(args.filter(arg => /^(?:https?|file|ssh|git):/.test(arg)).length, 1);
      assert.ok(args.includes('--config-env=http.extraHeader=CORTEX_GIT_AUTH'));
      assert.ok(options.env.CORTEX_GIT_AUTH);
      assert.ok(!args.some(arg => arg.includes(FAKE_TOKEN)));
      if (verb === 'ls-remote') {
        assert.equal(args[args.length - 1], REF);
        if (f.failReads) return { status: 128, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.from('synthetic unavailable') };
        if (f.stale !== undefined) {
          const value = f.stale; f.stale = undefined;
          return { status: value === null ? 2 : 0, signal: null,
            stdout: Buffer.from(value === null ? '' : value + '\t' + REF + '\n'), stderr: Buffer.alloc(0) };
        }
      }
      if (verb === 'fetch') {
        assert.ok(/^[0-9a-f]{40}:refs\/cortex\/state$/.test(args[args.length - 1]));
        assert.ok(args.includes('--no-tags') && args.includes('--no-write-fetch-head'));
        assert.ok(args.includes('--depth=1') || args.includes('--depth=32'));
      }
      if (verb === 'push') {
        f.pushes++;
        assert.ok(args.includes('--force-with-lease=' + REF + ':') ||
          args.some(arg => new RegExp('^--force-with-lease=' + REF + ':[0-9a-f]{40}$').test(arg)));
        assert.ok(/^[0-9a-f]{40}:/.test(args[args.length - 1]));
        assert.equal(args[args.length - 1].slice(41), REF);
        assert.ok(!args.includes('--force') && !args.includes('--all') && !args.includes('--mirror'));
        if (f.suppressPush) return { error: new Error('synthetic timeout'), status: null,
          signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      mapped = mapped.filter(arg => arg !== '--config-env=http.extraHeader=CORTEX_GIT_AUTH')
        .map(arg => arg === ORIGIN ? 'file://' + remote :
          (f.forcePack && arg === 'fetch.unpackLimit=2048' ? 'fetch.unpackLimit=1' : arg));
      delete childEnv.CORTEX_GIT_AUTH;
      mapped = ['-c', 'protocol.file.allow=always', ...mapped];
    } else assert.equal(options.env.CORTEX_GIT_AUTH, undefined);
    // Both the allowlist and Git itself deny network. No fake success replaces the actual CAS.
    const result = realSpawn(executable, mapped, { ...options, env: childEnv });
    if (verb === 'push' && result.status === 0) {
      if (f.afterPush) { const action = f.afterPush; f.afterPush = null; action(); }
      if (f.timeoutAfterPush) {
        f.timeoutAfterPush = false; f.failReads = true;
        return { error: new Error('synthetic lost acknowledgement'), status: null,
          signal: 'SIGKILL', stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
    }
    return result;
  });
  const mkdtempMock = t.mock.method(fs, 'mkdtempSync', prefix => {
    assert.equal(prefix, '/tmp/cortex-control-');
    return realMkdtemp(path.join(base, 'scratch-'));
  });
  const removeMock = t.mock.method(fs, 'rmSync', (target, options) => {
    assert.ok(target.startsWith(base + '/scratch-'));
    return realRemove(target, options);
  });
  const fakeHttps = {
    request(options, callback) {
      f.api++;
      assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'api.github.com');
      assert.equal(options.path, '/repos/' + REPO); assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer ' + FAKE_TOKEN);
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = 200; response.resume = () => {};
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({ id: f.wrongRepo ? 123 : 1266950600,
          full_name: REPO, owner: { id: 50976390 }, private: true })));
        response.emit('end');
      });
      return request;
    }
  };
  const local = require('../../lib/governance/git-transaction-store');
  const module = { exports: {} };
  const modules = {
    'node:fs': fs, 'node:path': path, 'node:crypto': crypto, 'node:child_process': cp,
    'node:https': fakeHttps, 'node:perf_hooks': require('node:perf_hooks'),
    './git-transaction-store': local
  };
  const processFixture = { platform: 'linux', getuid: () => process.getuid(), env: {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: '1266950600',
    GITHUB_TOKEN: FAKE_TOKEN, NODE_OPTIONS: '--require=untrusted-never-inherit.js'
  } };
  f.processEnv = processFixture.env;
  // Test-only module loading seam; production exports no configurable runner or URL.
  new Function('require', 'module', 'exports', 'process', fs.readFileSync(SOURCE, 'utf8'))(
    name => { assert.ok(Object.hasOwn(modules, name), 'unexpected dependency'); return modules[name]; },
    module, module.exports, processFixture);
  f.create = (options = { binding: binding(), resource_keys: pinned }) => {
    const store = module.exports.createGitHubControlStore(options); f.stores.push(store); return store;
  };
  f.prepare = (store, expected, id, writes = [{ key: 'control/project.json', content: '{"fixture":true}' }]) =>
    store.prepareBatch({ expected_revision: expected, transaction_id: id, writes });
  f.seed = async () => {
    const store = f.create();
    const prepared = await f.prepare(store, null, 'bootstrap', [
      { key: 'control/identity.json', content: '{"synthetic":true}' },
      { key: 'control/project.json', content: '{"generation":0}' }
    ]);
    const result = await store.publishPrepared(prepared.handle);
    assert.equal(result.status, 'PUBLISHED');
    return result.evidence.published_revision;
  };
  t.after(() => {
    try {
      for (const store of f.stores) store.close();
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
      assert.ok(fs.readdirSync(base).every(name => name === 'remote.git' || name === 'sentinel'));
    } finally {
      spawnMock.mock.restore(); mkdtempMock.mock.restore(); removeMock.mock.restore();
      realRemove(base, { recursive: true, force: true });
    }
  });
  return f;
}

test('GitHub control store: bounded synthetic offline transport', { concurrency: 1 }, async t => {
  await t.test('unconfigured process and rejected construction perform no transport', async t => {
    const f = fixture(t);
    assert.throws(() => f.create({ binding: { ...binding(), repository: 'elsewhere/repo' }, resource_keys: pinned }));
    assert.throws(() => f.create({ binding: { ...binding(), authority_ref: 'refs/heads/main' }, resource_keys: pinned }));
    assert.throws(() => f.create({ binding: binding(), resource_keys: ['bin/run.js'] }));
    assert.throws(() => f.create({ binding: binding(), resource_keys: pinned, testMode: true }));
    const store = f.create(); f.processEnv.GITHUB_ACTIONS = 'false';
    await assert.rejects(store.readSnapshot(['control/identity.json']), { code: 'PROTECTED_JOB_REQUIRED' });
    assert.equal(f.api, 0); assert.equal(f.children, 0);
  });
  await t.test('bootstrap publishes one isolated orphan root with absent-ref exact lease', async t => {
    const f = fixture(t), store = f.create();
    const before = await store.readSnapshot(['control/identity.json']);
    assert.equal(before.revision, null);
    const prepared = await f.prepare(store, null, 'bootstrap', [
      { key: 'control/identity.json', content: '{"synthetic":true}' },
      { key: 'control/project.json', content: '{"generation":0}' }
    ]);
    assert.equal(f.pushes, 0);
    const published = await store.publishPrepared(prepared.handle);
    assert.equal(published.status, 'PUBLISHED');
    assert.deepEqual(published.evidence.published_revision, revision(prepared.evidence.prepared_commit));
    assert.equal(store.effect_authority, false); assert.equal(published.effect_authority, false);
    assert.equal(f.refs(), REF);
    assert.ok(!f.git(['cat-file', 'commit', f.tip()]).includes('\nparent '));
    const after = await store.readSnapshot(['control/identity.json', 'control/project.json']);
    assert.equal(after.records['control/project.json'].sha256, sha('{"generation":0}'));
    assert.equal(after.records['control/identity.json'].content, '{"synthetic":true}');
    await assert.rejects(store.publishPrepared(prepared.handle), { code: 'INVALID_OR_CONSUMED_HANDLE' });
    assert.equal(f.pushes, 1);
    assert.ok(!JSON.stringify(published).includes(FAKE_TOKEN));
  });
  await t.test('real Git rejects stale expected-absent bootstrap without overwrite', async t => {
    const f = fixture(t), a = f.create(), b = f.create();
    const pa = await f.prepare(a, null, 'first'), pb = await f.prepare(b, null, 'second');
    assert.equal((await a.publishPrepared(pa.handle)).status, 'PUBLISHED');
    f.stale = null; // Exact simulation of another writer winning after the pre-read.
    const result = await b.publishPrepared(pb.handle);
    assert.equal(result.status, 'CONFLICT');
    assert.equal(f.tip(), pa.evidence.prepared_commit);
    assert.equal(f.pushes, 2); assert.equal(f.refs(), REF);
  });
  await t.test('real Git exact-old CAS permits only one competing direct child', async t => {
    const f = fixture(t), base = await f.seed(), a = f.create(), b = f.create();
    const pa = await f.prepare(a, base, 'winner'), pb = await f.prepare(b, base, 'loser');
    assert.equal((await a.publishPrepared(pa.handle)).status, 'PUBLISHED');
    f.stale = base.value;
    const result = await b.publishPrepared(pb.handle);
    assert.equal(result.status, 'CONFLICT'); assert.equal(f.tip(), pa.evidence.prepared_commit);
    const raw = f.git(['cat-file', 'commit', f.tip()]);
    assert.equal(raw.split('\n').filter(line => line.startsWith('parent ')).join('\n'), 'parent ' + base.value);
    assert.equal(f.pushes, 3); assert.equal(f.refs(), REF);
  });
  await t.test('all writes become visible together in one commit', async t => {
    const f = fixture(t), base = await f.seed(), store = f.create();
    const audit = 'control/audit/' + 'a'.repeat(64) + '.json';
    const source = 'control/sources/' + 'b'.repeat(64) + '.json';
    const writes = [
      { key: 'control/project.json', content: '{"generation":1}' },
      { key: 'control/journal.json', content: '{"sequence":1}' },
      { key: audit, content: '{"audit":"synthetic"}' },
      { key: source, content: '{"source":"synthetic"}' }
    ];
    const prepared = await f.prepare(store, base, 'batch', writes);
    assert.equal(f.tip(), base.value);
    assert.equal((await store.publishPrepared(prepared.handle)).status, 'PUBLISHED');
    const state = await store.readSnapshot(writes.map(item => item.key));
    for (const item of writes) assert.equal(state.records[item.key].content, item.content);
    await assert.rejects(f.prepare(store, state.revision, 'overwrite-audit', [writes[2]]),
      { code: 'APPEND_ONLY_RECORD_EXISTS' });
  });
  await t.test('lost acknowledgement is UNKNOWN, then read-only reconciliation proves success', async t => {
    const f = fixture(t), base = await f.seed(), store = f.create();
    const prepared = await f.prepare(store, base, 'lost-ack');
    const before = f.pushes; f.timeoutAfterPush = true;
    const unknown = await store.publishPrepared(prepared.handle);
    assert.equal(unknown.status, 'UNKNOWN'); assert.equal(f.pushes, before + 1);
    await assert.rejects(store.publishPrepared(prepared.handle), { code: 'INVALID_OR_CONSUMED_HANDLE' });
    await assert.rejects(f.prepare(store, base, 'new-attempt'), { code: 'UNKNOWN_REQUIRES_RECONCILIATION' });
    f.failReads = false;
    const reconciled = await store.reconcilePrepared(prepared.handle);
    assert.equal(reconciled.status, 'PUBLISHED');
    assert.equal(reconciled.evidence.published_revision.value, prepared.evidence.prepared_commit);
    assert.equal(f.pushes, before + 1);
  });
  await t.test('unproven timeout remains UNKNOWN and is never automatically resent', async t => {
    const f = fixture(t), base = await f.seed(), store = f.create();
    const prepared = await f.prepare(store, base, 'not-sent'); f.suppressPush = true;
    assert.equal((await store.publishPrepared(prepared.handle)).status, 'UNKNOWN');
    const pushes = f.pushes;
    assert.equal((await store.reconcilePrepared(prepared.handle)).status, 'UNKNOWN');
    assert.equal(f.pushes, pushes); assert.equal(f.tip(), base.value);
  });
  await t.test('verified direct-parent successor includes the exact prepared transaction', async t => {
    const f = fixture(t), base = await f.seed(), store = f.create();
    const prepared = await f.prepare(store, base, 'before-successor');
    f.afterPush = () => {
      const current = f.tip();
      const tree = f.git(['cat-file', 'commit', current]).split('\n')[0].slice(5);
      const next = f.git(['commit-tree', tree, '-p', current], 'cortex-transaction-v1 successor\n');
      f.git(['update-ref', '--no-deref', REF, next, current]);
    };
    const result = await store.publishPrepared(prepared.handle);
    assert.equal(result.status, 'PUBLISHED');
    assert.notEqual(f.tip(), prepared.evidence.prepared_commit);
    assert.equal(result.evidence.published_revision.value, prepared.evidence.prepared_commit);
  });
  await t.test('packed and shallow imports retain the unchanged local builder guard', async t => {
    const f = fixture(t); f.forcePack = true;
    const base = await f.seed(), store = f.create();
    const prepared = await f.prepare(store, base, 'packed-update');
    assert.equal((await store.publishPrepared(prepared.handle)).status, 'PUBLISHED');
    const state = await store.readSnapshot(['control/project.json']);
    assert.equal(state.revision.value, prepared.evidence.prepared_commit);
    assert.ok(f.calls.some(call => call.verb === 'unpack-objects'));
    assert.equal(f.refs(), REF);
  });
  await t.test('candidate beyond bounded history stays UNKNOWN and forbids further writes', async t => {
    const f = fixture(t), base = await f.seed(), store = f.create();
    const prepared = await f.prepare(store, base, 'bounded-history');
    f.afterPush = () => {
      let current = f.tip();
      const tree = f.git(['cat-file', 'commit', current]).split('\n')[0].slice(5);
      for (let index = 0; index < 33; index++) {
        const next = f.git(['commit-tree', tree, '-p', current], 'cortex-transaction-v1 later-' + index + '\n');
        f.git(['update-ref', '--no-deref', REF, next, current]); current = next;
      }
    };
    assert.equal((await store.publishPrepared(prepared.handle)).status, 'UNKNOWN');
    const pushes = f.pushes;
    assert.equal((await store.reconcilePrepared(prepared.handle)).status, 'UNKNOWN');
    await assert.rejects(f.prepare(store, base, 'must-stop'), { code: 'UNKNOWN_REQUIRES_RECONCILIATION' });
    assert.equal(f.pushes, pushes);
  });
  await t.test('bounds, extra fields, deletes and unpinned paths fail before transport', async t => {
    const f = fixture(t), store = f.create();
    const invalid = [
      [{ key: '../outside', content: 'x' }],
      [{ key: 'decisions/D-uninstalled.json', content: '{}' }],
      [{ key: 'control/project.json', content: null }],
      [{ key: 'control/project.json', content: 'x'.repeat(65537) }],
      [{ key: 'control/project.json', content: '{}' }, { key: 'control/project.json', content: '{}' }],
      [{ key: 'control/project.json', content: '{}', mode: '120000' }]
    ];
    for (let index = 0; index < invalid.length; index++)
      await assert.rejects(f.prepare(store, null, 'bad-' + index, invalid[index]));
    await assert.rejects(store.readSnapshot(['control/identity.json', '.git/config']));
    assert.equal(f.api, 0); assert.equal(f.children, 0); assert.equal(f.pushes, 0);
  });
  await t.test('repository stable-ID mismatch blocks Git before object transfer', async t => {
    const f = fixture(t), store = f.create(); f.wrongRepo = true;
    await assert.rejects(store.readSnapshot(['control/identity.json']), { code: 'REPOSITORY_ID_MISMATCH' });
    assert.equal(f.children, 0); assert.equal(f.pushes, 0);
  });
  await t.test('imported symlink entry is rejected and cannot be prepared or published', async t => {
    const f = fixture(t), base = await f.seed(), store = f.create();
    const blob = f.git(['hash-object', '-w', '--stdin', '--no-filters'], '/tmp/outside');
    const subtree = f.git(['mktree'], '120000 blob ' + blob + '\tidentity.json\n');
    const tree = f.git(['mktree'], '040000 tree ' + subtree + '\tcontrol\n');
    const bad = f.git(['commit-tree', tree, '-p', base.value], 'synthetic invalid tree\n');
    f.git(['update-ref', '--no-deref', REF, bad, base.value]);
    const pushes = f.pushes;
    await assert.rejects(store.readSnapshot(['control/identity.json']));
    await assert.rejects(f.prepare(store, revision(bad), 'unsafe'));
    assert.equal(f.pushes, pushes); assert.equal(f.tip(), bad);
  });
});
