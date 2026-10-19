'use strict';

// Inert storage primitive. Construct only inside the protected, installed controller.
// This module installs no workflow, grant, lease, credentials, or RuntimePort.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { createGitTransactionStore, GIT_TRANSACTION_REF } = require('./git-transaction-store');

const REPOSITORY = 'Kucell/cortex-agent-agent';
const REPOSITORY_ID = '1266950600';
const ORIGIN = 'https://github.com/' + REPOSITORY + '.git';
const OID = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);
const LIMITS = Object.freeze({ keys: 64, item_bytes: 65536, total_bytes: 262144,
  command_ms: 15000, operation_ms: 60000, output_bytes: 1048576,
  pack_bytes: 1048576, history: 32, handles: 4, transactions: 256 });
const CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';
const CONFIG_ARGS = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.logAllRefUpdates=false',
  '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
  '-c', 'credential.helper=', '-c', 'credential.interactive=false',
  '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
  '-c', 'http.extraHeader=', '-c', 'push.followTags=false',
  '-c', 'push.recurseSubmodules=no', '-c', 'fetch.recurseSubmodules=false',
  '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
  '-c', 'fetch.unpackLimit=2048', '-c', 'protocol.allow=never'
]);
class GitHubControlStoreError extends Error {
  constructor(code, evidence = {}) {
    super(code); this.name = 'GitHubControlStoreError'; this.code = code;
    this.evidence = Object.freeze({ ...evidence });
  }
}
function fail(code, evidence) { throw new GitHubControlStoreError(code, evidence); }
function exact(object, names) {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype ||
      Object.keys(object).length !== names.length ||
      names.some(name => !Object.hasOwn(object, name))) fail('INVALID_SHAPE');
}
function oid(value) {
  if (typeof value !== 'string' || !OID.test(value) || value === ZERO) fail('INVALID_OBJECT_ID');
  return value;
}
function revision(value) {
  if (value === null) return null;
  exact(value, ['store_kind', 'value']);
  if (value.store_kind !== 'git') fail('INVALID_REVISION');
  return oid(value.value);
}
function typed(value) { return value === null ? null : Object.freeze({ store_kind: 'git', value }); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function namespace(value) {
  if (typeof value !== 'string' || value.length > 240) fail('KEY_NOT_ALLOWED');
  const fixed = /^control\/(?:identity|owner|project|manifest|bootstrap|journal)\.json$/;
  const receipts = /^control\/(?:audit|sources|replay\/(?:runs|selections))\/[0-9a-f]{64}\.json$/;
  const decisions = /^decisions\/(?:index|D-[A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/;
  const waitpoints = /^waitpoints\/(?:index|WP-[A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$/;
  const scoped = /^(?:scopes|tasks)\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/;
  if (![fixed, receipts, decisions, waitpoints, scoped].some(pattern => pattern.test(value)))
    fail('KEY_NOT_ALLOWED');
  return value;
}
function body(value) {
  if (typeof value !== 'string') fail('INVALID_CONTENT');
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > LIMITS.item_bytes || bytes.toString('utf8') !== value) fail('INVALID_CONTENT');
  return bytes;
}
function regular(file, maximum) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() ||
      (st.mode & 0o022) !== 0 || st.size > maximum) fail('UNSAFE_IMPORTED_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) fail('IMPORT_CHANGED');
    const data = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (data.length !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs ||
        after.ctimeMs !== st.ctimeMs || current.dev !== st.dev || current.ino !== st.ino)
      fail('IMPORT_CHANGED');
    return data;
  } finally { fs.closeSync(fd); }
}
function createGitHubControlStore(options) {
  exact(options, ['binding', 'resource_keys']);
  const installed = options.binding;
  exact(installed, ['kind', 'repository_id', 'repository', 'authority_ref']);
  if (installed.kind !== 'github-ref' || installed.repository_id !== REPOSITORY_ID ||
      installed.repository !== REPOSITORY ||
      !/^refs\/heads\/cortex-authority\/[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(installed.authority_ref))
    fail('UNSUPPORTED_INSTALLED_BINDING');
  if (!Array.isArray(options.resource_keys) || options.resource_keys.length > LIMITS.keys) fail('RESOURCE_KEY_LIMIT');
  const pinned = new Set(options.resource_keys.map(namespace));
  if (pinned.size !== options.resource_keys.length) fail('DUPLICATE_KEY');
  // These are trusted construction data resolved by the private wrapper from the installed manifest.
  // They must never come from workflow inputs, a caller-selected file, or Host/model output.
  const binding = Object.freeze({ ...installed });
  const ref = binding.authority_ref;
  const handles = new WeakMap();
  const pending = new Set();
  const transactions = new Set();
  let unknown = null, stopped = false, busy = false, lastObserved;
  function key(value) {
    namespace(value);
    if (!value.startsWith('control/') && !pinned.has(value)) fail('KEY_OUTSIDE_INSTALLED_MANIFEST');
    return value;
  }
  function keys(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > LIMITS.keys) fail('KEY_LIMIT');
    const result = values.map(key);
    if (new Set(result).size !== result.length) fail('DUPLICATE_KEY');
    return result;
  }
  function jobToken() {
    if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' ||
        process.env.GITHUB_REPOSITORY !== REPOSITORY ||
        process.env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID) fail('PROTECTED_JOB_REQUIRED');
    const token = process.env.GITHUB_TOKEN;
    if (typeof token !== 'string' || token.length < 1 || token.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(token)) fail('JOB_TOKEN_UNAVAILABLE');
    return token;
  }
  function environment(repo, token) {
    const env = {
      PATH: '/usr/bin:/bin', HOME: repo, XDG_CONFIG_HOME: repo, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0'
    };
    if (token !== null)
      env.CORTEX_GIT_AUTH = 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64');
    return env;
  }
  function scratch() {
    const repo = fs.mkdtempSync('/tmp/cortex-control-');
    try {
      fs.chmodSync(repo, 0o700);
      if (fs.realpathSync(repo) !== repo) fail('UNSAFE_SCRATCH');
      for (const name of ['objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags'])
        fs.mkdirSync(path.join(repo, name), { mode: 0o700 });
      fs.writeFileSync(path.join(repo, 'config'), CONFIG, { mode: 0o600, flag: 'wx' });
      fs.writeFileSync(path.join(repo, 'HEAD'), 'ref: refs/heads/unused\n', { mode: 0o600, flag: 'wx' });
      const git = fs.realpathSync('/usr/bin/git');
      const stat = fs.statSync(git);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || !(stat.mode & 0o111))
        fail('UNSAFE_GIT_EXECUTABLE');
      const local = createGitTransactionStore({ repo, ref: GIT_TRANSACTION_REF, gitExecutable: git });
      return { repo, git, local, shallow: null, root: fs.statSync(repo), executable: stat };
    } catch (error) { fs.rmSync(repo, { recursive: true, force: true }); throw error; }
  }
  function remove(work) {
    if (!work) return true;
    try {
      const stat = fs.lstatSync(work.repo);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          stat.dev !== work.root.dev || stat.ino !== work.root.ino) return false;
      fs.rmSync(work.repo, { recursive: true, force: true }); return true;
    } catch (_) { return false; }
  }
  function guard(work) {
    const root = fs.lstatSync(work.repo), executable = fs.lstatSync(work.git);
    if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== work.root.dev ||
        root.ino !== work.root.ino || (root.mode & 0o077) !== 0 ||
        !executable.isFile() || executable.isSymbolicLink() ||
        ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode'].some(k => executable[k] !== work.executable[k]) ||
        regular(path.join(work.repo, 'config'), 1024).toString('utf8') !== CONFIG)
      fail('SCRATCH_BINDING_CHANGED');
  }
  function run(work, args, input, deadline, token = null) {
    guard(work);
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail('OPERATION_EXPIRED');
    const auth = token === null ? [] : [
      '-c', 'protocol.https.allow=always', '--config-env=http.extraHeader=CORTEX_GIT_AUTH'
    ];
    return cp.spawnSync(work.git,
      ['--no-pager', '--git-dir=' + work.repo, ...CONFIG_ARGS, ...auth, ...args],
      { cwd: work.repo, env: environment(work.repo, token), shell: false, windowsHide: true,
        input, encoding: null, maxBuffer: LIMITS.output_bytes,
        timeout: Math.max(1, Math.floor(Math.min(LIMITS.command_ms, remaining))), killSignal: 'SIGKILL' });
  }
  function successful(result) { return !result.error && !result.signal && result.status === 0; }
  function checked(work, args, input, deadline, token = null) {
    const result = run(work, args, input, deadline, token);
    if (!successful(result)) fail('GIT_COMMAND_FAILED', { command: args[0] });
    return Buffer.from(result.stdout || []);
  }
  function stableRepository(token, deadline) {
    return new Promise((resolve, reject) => {
      let done = false, timer;
      const finish = error => {
        if (done) return; done = true; clearTimeout(timer);
        if (error) reject(new GitHubControlStoreError(error)); else resolve();
      };
      const request = https.request({
        protocol: 'https:', hostname: 'api.github.com', port: 443, method: 'GET',
        path: '/repos/' + REPOSITORY,
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cortex-governance-control-store' }
      }, response => {
        if (response.statusCode !== 200) { response.resume(); finish('REPOSITORY_ID_UNVERIFIED'); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > LIMITS.output_bytes) { request.destroy(); finish('REPOSITORY_RESPONSE_LIMIT'); }
          else chunks.push(chunk);
        });
        response.on('error', () => finish('REPOSITORY_READ_FAILED'));
        response.on('end', () => {
          if (done) return;
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (String(data.id) !== REPOSITORY_ID || data.full_name !== REPOSITORY ||
                String(data.owner && data.owner.id) !== '50976390' || data.private !== true)
              return finish('REPOSITORY_ID_MISMATCH');
            finish();
          } catch (_) { finish('REPOSITORY_RESPONSE_INVALID'); }
        });
      });
      timer = setTimeout(() => { request.destroy(); finish('REPOSITORY_READ_EXPIRED'); },
        Math.max(1, Math.min(LIMITS.command_ms, deadline - performance.now())));
      request.on('error', () => finish('REPOSITORY_READ_FAILED'));
      request.end();
    });
  }
  function remoteHead(work, token, deadline) {
    const result = run(work, ['ls-remote', '--refs', '--exit-code', ORIGIN, ref], undefined, deadline, token);
    if (successful(result)) {
      const text = Buffer.from(result.stdout || []).toString('utf8');
      const lines = text.trimEnd().split('\n');
      if (lines.length !== 1) fail('REMOTE_REF_INVALID');
      const [value, name, extra] = lines[0].split('\t');
      if (name !== ref || extra !== undefined) fail('REMOTE_REF_INVALID');
      return oid(value);
    }
    if (!result.error && !result.signal && result.status === 2 &&
        Buffer.from(result.stdout || []).length === 0) return null;
    fail('REMOTE_REF_UNAVAILABLE');
  }
  function importTip(work, tip, depth, token, deadline) {
    if (tip === null) return;
    // Fetch ONLY the object just observed on the fixed authority ref. Never clone or follow tags.
    checked(work, ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      '--no-auto-maintenance', '--depth=' + depth, ORIGIN, tip + ':' + GIT_TRANSACTION_REF],
      undefined, deadline, token);
    const shallow = path.join(work.repo, 'shallow');
    if (fs.existsSync(shallow)) {
      work.shallow = regular(shallow, 4096);
      if (!/^(?:[0-9a-f]{40}\n)+$/.test(work.shallow.toString('ascii'))) fail('INVALID_SHALLOW_BOUNDARY');
      fs.unlinkSync(shallow);
    }
    // Normalize received packs in isolated scratch; do NOT relax the reviewed local store guard.
    const packDir = path.join(work.repo, 'objects/pack');
    const packs = fs.readdirSync(packDir);
    if (packs.some(name => !/^pack-[0-9a-f]{40}\.(?:pack|idx)$/.test(name)) || packs.length > 2)
      fail('UNSUPPORTED_PACK_LAYOUT');
    const packName = packs.find(name => name.endsWith('.pack'));
    let pack;
    if (packName) pack = regular(path.join(packDir, packName), LIMITS.pack_bytes);
    if (packs.length && (!pack || !packs.includes(packName.slice(0, -5) + '.idx'))) fail('INCOMPLETE_PACK');
    for (const name of packs) {
      regular(path.join(packDir, name), LIMITS.pack_bytes); fs.unlinkSync(path.join(packDir, name));
    }
    if (pack) checked(work, ['unpack-objects', '-r'], pack, deadline);
    // Complete layout, loose-object ownership/modes/count/size, config and full tree checked here.
    work.local = createGitTransactionStore({ repo: work.repo, ref: GIT_TRANSACTION_REF, gitExecutable: work.git });
    if (revision(work.local.readSnapshot(['control/identity.json']).revision) !== tip) fail('FETCHED_REF_MISMATCH');
    const entries = checked(work, ['ls-tree', '-r', '-z', '--full-tree', tip], undefined, deadline)
      .toString('utf8').split('\0');
    if (entries.pop() !== '' || entries.length > LIMITS.keys) fail('IMPORTED_TREE_LIMIT');
    for (const entry of entries) {
      const match = /^100644 blob [0-9a-f]{40}\t(.+)$/.exec(entry);
      if (!match) fail('UNSUPPORTED_TREE_ENTRY');
      key(match[1]);
    }
  }
  function commit(work, value, deadline) {
    const data = checked(work, ['cat-file', 'commit', oid(value)], undefined, deadline);
    if (crypto.createHash('sha1').update(Buffer.from('commit ' + data.length + '\0')).update(data).digest('hex') !== value)
      fail('COMMIT_DIGEST_MISMATCH');
    const text = data.toString('utf8');
    const split = text.indexOf('\n\n');
    if (split < 0) fail('INVALID_COMMIT');
    const headers = text.slice(0, split).split('\n');
    const parents = headers.filter(line => line.startsWith('parent ')).map(line => oid(line.slice(7)));
    const tree = headers.filter(line => line.startsWith('tree '));
    if (tree.length !== 1) fail('INVALID_COMMIT');
    return { parents, tree: oid(tree[0].slice(5)), message: text.slice(split + 2) };
  }
  function follows(work, tip, target, deadline) {
    if (tip === null) return false;
    let cursor = tip;
    for (let index = 0; index < LIMITS.history; index++) {
      if (cursor === target) return true;
      const item = commit(work, cursor, deadline);
      if (item.parents.length === 0) return false;
      if (item.parents.length !== 1) fail('NON_LINEAR_AUTHORITY_HISTORY');
      cursor = item.parents[0];
    }
    fail('HISTORY_PROOF_LIMIT');
  }
  function evidence(entry, extra = {}) {
    return Object.freeze({ repository_id: REPOSITORY_ID, ref, transaction_id: entry.id,
      base_revision: typed(entry.base), prepared_commit: entry.commit,
      prepared_tree: entry.tree, writes_sha256: entry.digest,
      publication: 'NOT_ATTEMPTED', effect_authority: false, ...extra });
  }
  async function operation(callback, write = false) {
    if (stopped) fail('STORE_CLOSED');
    if (busy) fail('STORE_BUSY');
    if (write && unknown) fail('UNKNOWN_REQUIRES_RECONCILIATION');
    busy = true;
    try {
      const deadline = performance.now() + LIMITS.operation_ms;
      const token = jobToken();
      await stableRepository(token, deadline);
      return await callback(token, deadline);
    } finally { busy = false; }
  }
  async function snapshot(selected, token, deadline) {
    const work = scratch();
    try {
      const tip = remoteHead(work, token, deadline);
      importTip(work, tip, lastObserved ? LIMITS.history : 1, token, deadline);
      if (lastObserved && tip !== lastObserved && !follows(work, tip, lastObserved, deadline))
        fail('AUTHORITY_HISTORY_CHANGED');
      lastObserved = tip;
      return { work, tip, value: work.local.readSnapshot(selected) };
    } catch (error) { remove(work); throw error; }
  }
  async function readSnapshot(requested) {
    const selected = keys(requested);
    return operation(async (token, deadline) => {
      const state = await snapshot(selected, token, deadline);
      try { return state.value; } finally { remove(state.work); }
    });
  }
  async function prepareBatch(request) {
    exact(request, ['expected_revision', 'writes', 'transaction_id']);
    const base = revision(request.expected_revision);
    if (typeof request.transaction_id !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.transaction_id)) fail('INVALID_TRANSACTION_ID');
    if (!Array.isArray(request.writes)) fail('INVALID_WRITES');
    const writes = request.writes.map(item => {
      exact(item, ['key', 'content']); return { key: key(item.key), content: item.content };
    });
    const selected = keys(writes.map(item => item.key));
    if (writes.reduce((total, item) => total + body(item.content).length, 0) > LIMITS.total_bytes) fail('BATCH_LIMIT');
    if (base !== null && selected.some(name => name.startsWith('tasks/'))) fail('TASKS_BOOTSTRAP_ONLY');
    if (pending.size >= LIMITS.handles || transactions.size >= LIMITS.transactions || transactions.has(request.transaction_id)) fail('PREPARATION_LIMIT');
    return operation(async (token, deadline) => {
      const state = await snapshot(selected, token, deadline);
      try {
        if (state.tip !== base) fail('REVISION_CONFLICT', { observed_revision: typed(state.tip) });
        for (const item of writes) {
          if (/^control\/(?:audit|sources|replay)\//.test(item.key) && state.value.records[item.key] !== null)
            fail('APPEND_ONLY_RECORD_EXISTS');
          if (base !== null && /^control\/(?:identity|manifest|bootstrap)\.json$/.test(item.key))
            fail('IMMUTABLE_BOOTSTRAP_RECORD');
        }
        const prepared = state.work.local.prepareBatch({
          expected_revision: typed(base), writes, transaction_id: request.transaction_id
        });
        const candidate = commit(state.work, prepared.evidence.prepared_commit, deadline);
        if (candidate.parents.length !== (base ? 1 : 0) ||
            (base && candidate.parents[0] !== base)) fail('DIRECT_PARENT_REQUIRED');
        const localPublished = state.work.local.publishPrepared(prepared.handle);
        if (localPublished.status !== 'PUBLISHED' ||
            revision(state.work.local.readSnapshot(selected).revision) !== prepared.evidence.prepared_commit)
          fail('LOCAL_CANDIDATE_UNVERIFIED');
        const entry = { id: request.transaction_id, base, commit: prepared.evidence.prepared_commit,
          tree: candidate.tree, digest: sha256(Buffer.from(JSON.stringify(writes))), work: state.work,
          used: false, status: null };
        const handle = Object.freeze(Object.create(null));
        handles.set(handle, entry); pending.add(entry); transactions.add(entry.id);
        return Object.freeze({ handle, evidence: evidence(entry), effect_authority: false });
      } catch (error) { remove(state.work); throw error; }
    }, true);
  }
  async function readback(entry, token, deadline) {
    const work = scratch();
    try {
      const tip = remoteHead(work, token, deadline);
      if (tip === null) return { proven: false, tip };
      importTip(work, tip, LIMITS.history, token, deadline);
      if (!follows(work, tip, entry.commit, deadline)) return { proven: false, tip };
      const candidate = commit(work, entry.commit, deadline);
      if (candidate.tree !== entry.tree || candidate.message !== 'cortex-transaction-v1 ' + entry.id + '\n' ||
          candidate.parents.length !== (entry.base ? 1 : 0) ||
          (entry.base && candidate.parents[0] !== entry.base)) fail('READBACK_TRANSACTION_MISMATCH');
      let cursor = tip;
      while (cursor !== entry.commit) {
        const next = commit(work, cursor, deadline);
        if (next.message === candidate.message) fail('DUPLICATE_TRANSACTION_HISTORY');
        cursor = next.parents[0];
      }
      lastObserved = tip;
      return { proven: true, tip };
    } finally { remove(work); }
  }
  function finish(entry, status, extra = {}) {
    entry.status = status;
    if (status === 'UNKNOWN') unknown = entry;
    else {
      if (unknown === entry) unknown = null;
      pending.delete(entry); entry.cleaned = remove(entry.work); entry.work = null;
    }
    return Object.freeze({ status, effect_authority: false, evidence: evidence(entry,
      { publication: status, scratch_cleanup: entry.cleaned === true ? 'DONE' : 'UNCONFIRMED', ...(status === 'PUBLISHED' ? { published_revision: typed(entry.commit) } : {}), ...extra }) });
  }
  async function publishPrepared(handle) {
    const entry = handle && handles.get(handle);
    if (!entry || entry.used) fail('INVALID_OR_CONSUMED_HANDLE');
    if (stopped) fail('STORE_CLOSED');
    if (busy) fail('STORE_BUSY');
    if (unknown) fail('UNKNOWN_REQUIRES_RECONCILIATION');
    // Consume before the first asynchronous boundary; one capability can never send twice.
    entry.used = true;
    let attempted = false;
    try {
      return await operation(async (token, deadline) => {
        const tip = remoteHead(entry.work, token, deadline);
        if (tip !== entry.base) return finish(entry, 'CONFLICT',
          { reason: 'PRE_PUBLISH_REVISION_CHANGED', publish_attempted: false });
        const snapshot = entry.work.local.readSnapshot(['control/identity.json']);
        const candidate = commit(entry.work, entry.commit, deadline);
        if (revision(snapshot.revision) !== entry.commit || candidate.tree !== entry.tree ||
            candidate.parents.length !== (entry.base ? 1 : 0) ||
            (entry.base && candidate.parents[0] !== entry.base)) fail('PREPARED_COMMIT_CHANGED');
        // Reinstate ONLY the validated transport boundary after the unchanged builder finishes.
        if (entry.work.shallow)
          fs.writeFileSync(path.join(entry.work.repo, 'shallow'), entry.work.shallow, { mode: 0o600, flag: 'wx' });
        attempted = true;
        const pushed = run(entry.work, ['push', '--porcelain', '--no-verify', '--no-follow-tags',
          '--recurse-submodules=no', '--force-with-lease=' + ref + ':' + (entry.base || ''),
          ORIGIN, entry.commit + ':' + ref], undefined, deadline, token);
        // A timeout/failed transport first has UNKNOWN semantics. Only readback can resolve it.
        let observed;
        try { observed = await readback(entry, token, deadline); }
        catch (_) { return finish(entry, 'UNKNOWN', { reason: 'READBACK_UNAVAILABLE', publish_attempted: true }); }
        if (observed.proven) return finish(entry, 'PUBLISHED',
          { observed_revision: typed(observed.tip), publish_attempted: true, reconciled: !successful(pushed) });
        const output = Buffer.from(pushed.stdout || []).toString('utf8');
        const rejected = output.split('\n').some(line =>
          line === '!\t' + entry.commit + ':' + ref + '\t[rejected] (stale info)');
        if (!pushed.error && !pushed.signal && pushed.status !== 0 && rejected && observed.tip !== entry.base)
          return finish(entry, 'CONFLICT', { reason: 'EXACT_LEASE_REJECTED',
            observed_revision: typed(observed.tip), publish_attempted: true });
        return finish(entry, 'UNKNOWN', { reason: 'PUBLICATION_UNPROVEN',
          observed_revision: typed(observed.tip), publish_attempted: true });
      }, true);
    } catch (_) {
      return finish(entry, 'UNKNOWN',
        { reason: attempted ? 'PUBLISH_INTERRUPTED' : 'PRE_PUBLISH_FAILED', publish_attempted: attempted });
    }
  }
  async function reconcilePrepared(handle) {
    const entry = handle && handles.get(handle);
    if (!entry || !entry.used || entry.status !== 'UNKNOWN') fail('UNKNOWN_HANDLE_REQUIRED');
    return operation(async (token, deadline) => {
      try {
        const observed = await readback(entry, token, deadline);
        if (observed.proven) return finish(entry, 'PUBLISHED',
          { observed_revision: typed(observed.tip), reconciled: true, publish_attempted: false });
        return finish(entry, 'UNKNOWN', { reason: 'PUBLICATION_UNPROVEN',
          observed_revision: typed(observed.tip), reconciled: true, publish_attempted: false });
      } catch (_) {
        return finish(entry, 'UNKNOWN', { reason: 'READBACK_UNAVAILABLE', reconciled: true, publish_attempted: false });
      }
    });
  }
  function close() {
    if (busy) fail('STORE_BUSY');
    stopped = true;
    for (const entry of pending) { remove(entry.work); entry.work = null; }
    pending.clear();
  }
  return Object.freeze({ readSnapshot, prepareBatch, publishPrepared, reconcilePrepared, close,
    binding, limits: LIMITS, effect_authority: false });
}
module.exports = { createGitHubControlStore, GitHubControlStoreError };
