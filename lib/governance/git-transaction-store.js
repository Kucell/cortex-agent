'use strict';

// Local storage primitive, not an authority or production broker.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { performance } = require('node:perf_hooks');

const REF = 'refs/cortex/state';
const ZERO = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;
const LIMITS = Object.freeze({ keys: 64, item_bytes: 65536, total_bytes: 262144,
  command_ms: 1500, operation_ms: 15000, output_bytes: 1048576, object_files: 2048 });
const CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';
const PREFIX = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.logAllRefUpdates=false',
  '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'protocol.allow=never'
]);

class GitTransactionError extends Error {
  constructor(code, evidence = {}) {
    super(code); this.name = 'GitTransactionError'; this.code = code;
    this.evidence = Object.freeze({ ...evidence });
  }
}
function reject(code, evidence) { throw new GitTransactionError(code, evidence); }
function exact(value, keys, code = 'INVALID_INPUT') {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) reject(code);
}
function revision(value) {
  if (value === null) return null;
  exact(value, ['store_kind', 'value'], 'INVALID_REVISION');
  if (value.store_kind !== 'git' || typeof value.value !== 'string' || !OID.test(value.value) || value.value === ZERO)
    reject('INVALID_REVISION');
  return value.value;
}
function typed(oid) { return oid === null ? null : Object.freeze({ store_kind: 'git', value: oid }); }
function key(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value) ||
      value.split('/').some(s => s === '.' || s === '..' || s.startsWith('.') || s.endsWith('.lock') || s.length > 80))
    reject('INVALID_KEY');
  return value;
}
function keys(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > LIMITS.keys) reject('INVALID_KEYS');
  const result = values.map(key);
  if (new Set(result).size !== result.length) reject('DUPLICATE_KEY');
  return result;
}
function utf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) reject('INVALID_UTF8');
  return text;
}
function body(value) {
  if (typeof value !== 'string' || value.length > LIMITS.item_bytes) reject('INVALID_CONTENT');
  const bytes = Buffer.from(value, 'utf8');
  if (utf8(bytes) !== value || bytes.length > LIMITS.item_bytes) reject('INVALID_CONTENT');
  return bytes;
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sameFile(a, b) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink', 'mode'].every(k => a[k] === b[k]);
}
function canonicalDirectory(dir) {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) reject('NON_CANONICAL_PATH');
  const parts = dir.split(path.sep).filter(Boolean); let current = path.parse(dir).root;
  for (const part of parts) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(current) !== current) reject('UNSAFE_DIRECTORY');
  }
  return fs.statSync(dir);
}
function readRegular(file, maximum) {
  const flags = fs.constants;
  if (!Number.isInteger(flags.O_NOFOLLOW) || flags.O_NOFOLLOW === 0 ||
      !Number.isInteger(flags.O_NONBLOCK) || flags.O_NONBLOCK === 0) reject('UNSUPPORTED_PLATFORM');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum ||
      before.uid !== process.getuid() || (before.mode & 0o022) !== 0) reject('UNSAFE_FILE');
  let fd;
  try {
    fd = fs.openSync(file, flags.O_RDONLY | flags.O_NOFOLLOW | flags.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!sameFile(before, opened) || !opened.isFile()) reject('SOURCE_CHANGED');
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break; length += count;
    }
    if (length > maximum || !sameFile(opened, fs.fstatSync(fd)) ||
        !sameFile(opened, fs.lstatSync(file)) || length !== opened.size) reject('SOURCE_CHANGED');
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof GitTransactionError) throw error;
    reject(error.code === 'ENOENT' ? 'SOURCE_CHANGED' : 'UNSAFE_FILE');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function absent(file) {
  try { fs.lstatSync(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
function createGitTransactionStore(options) {
  exact(options, ['repo', 'ref', 'gitExecutable'], 'INVALID_OPTIONS');
  const { repo, ref, gitExecutable } = options;
  if (process.platform !== 'linux' || ref !== REF || typeof repo !== 'string' || typeof gitExecutable !== 'string')
    reject('UNSUPPORTED_CONFIGURATION');
  const rootStat = canonicalDirectory(repo);
  if (rootStat.uid !== process.getuid() || (rootStat.mode & 0o022) !== 0) reject('UNSAFE_REPOSITORY_OWNER');
  if (!path.isAbsolute(gitExecutable) || fs.realpathSync(gitExecutable) !== gitExecutable) reject('UNSAFE_GIT_EXECUTABLE');
  canonicalDirectory(path.dirname(gitExecutable));
  const executableStat = fs.lstatSync(gitExecutable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink() || (executableStat.mode & 0o022) !== 0 ||
      (executableStat.mode & 0o111) === 0) reject('UNSAFE_GIT_EXECUTABLE');
  const handles = new WeakMap();
  const directoryBindings = new Map();
  function boundDirectory(relative) {
    const stat = canonicalDirectory(path.join(repo, relative));
    if (stat.uid !== rootStat.uid || (stat.mode & 0o022) !== 0) reject('UNSAFE_DIRECTORY_OWNER');
    const prior = directoryBindings.get(relative);
    if (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino)) reject('DIRECTORY_BINDING_CHANGED');
    if (!prior) directoryBindings.set(relative, { dev: stat.dev, ino: stat.ino });
  }
  let lastObserved = undefined;
  let quarantined = false;
  const env = Object.freeze({
    PATH: '/usr/bin:/bin', HOME: repo, XDG_CONFIG_HOME: repo, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0',
    GIT_AUTHOR_NAME: 'Cortex transaction fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
    GIT_COMMITTER_NAME: 'Cortex transaction fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost'
  });
  function guard() {
    if (quarantined) reject('STORE_QUARANTINED');
    const now = canonicalDirectory(repo);
    if (now.dev !== rootStat.dev || now.ino !== rootStat.ino || now.uid !== rootStat.uid ||
        (now.mode & 0o022) !== 0 || !sameFile(executableStat, fs.lstatSync(gitExecutable)) ||
        fs.realpathSync(gitExecutable) !== gitExecutable) reject('STORE_BINDING_CHANGED');
    const top = fs.readdirSync(repo).sort();
    if (top.some(name => !['HEAD', 'config', 'objects', 'refs'].includes(name)) ||
        top.length !== 4) reject('UNSUPPORTED_REPOSITORY_LAYOUT');
    if (utf8(readRegular(path.join(repo, 'config'), 1024)) !== CONFIG) reject('UNSUPPORTED_REPOSITORY_CONFIG');
    if (utf8(readRegular(path.join(repo, 'HEAD'), 128)) !== 'ref: refs/heads/unused\n') reject('UNSUPPORTED_HEAD');
    for (const dir of ['objects', 'objects/info', 'objects/pack', 'refs', 'refs/heads', 'refs/tags'])
      boundDirectory(dir);
    if (fs.readdirSync(path.join(repo, 'objects/info')).length ||
        fs.readdirSync(path.join(repo, 'objects/pack')).length) reject('UNSUPPORTED_OBJECT_DATABASE');
    let count = 0;
    for (const shard of fs.readdirSync(path.join(repo, 'objects'))) {
      if (shard === 'info' || shard === 'pack') continue;
      if (!/^[0-9a-f]{2}$/.test(shard)) reject('UNSUPPORTED_OBJECT_DATABASE');
      const dir = path.join(repo, 'objects', shard); boundDirectory('objects/' + shard);
      for (const leaf of fs.readdirSync(dir)) {
        if (!/^[0-9a-f]{38}$/.test(leaf) || ++count > LIMITS.object_files) reject('UNSUPPORTED_OBJECT_DATABASE');
        const st = fs.lstatSync(path.join(dir, leaf));
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > LIMITS.output_bytes ||
            st.uid !== rootStat.uid || (st.mode & 0o022) !== 0) reject('UNSAFE_OBJECT');
      }
    }
    for (const name of fs.readdirSync(path.join(repo, 'refs'))) {
      if (!['heads', 'tags', 'cortex'].includes(name)) reject('UNSUPPORTED_REFS');
      const dir = path.join(repo, 'refs', name); boundDirectory('refs/' + name);
      const leaves = fs.readdirSync(dir);
      if (name !== 'cortex' && leaves.length) reject('UNSUPPORTED_REFS');
      if (name === 'cortex') for (const leaf of leaves) {
        if (!['state', 'state.lock'].includes(leaf)) reject('UNSUPPORTED_REFS');
        const st = fs.lstatSync(path.join(dir, leaf));
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== rootStat.uid ||
            (st.mode & 0o022) !== 0 || st.size > 256) reject('UNSAFE_REF');
      }
    }
  }
  function begin() { guard(); return performance.now() + LIMITS.operation_ms; }
  function raw(args, input, deadline, beforeSpawn) {
    guard();
    const remaining = deadline - performance.now();
    if (!(remaining > 0)) reject('OPERATION_EXPIRED');
    // All callers below supply fixed plumbing verbs and validated OIDs or keys.
    if (beforeSpawn) beforeSpawn();
    return cp.spawnSync(gitExecutable, ['--no-pager', '--git-dir=' + repo, ...PREFIX, ...args], {
      cwd: repo, env, shell: false, windowsHide: true, input,
      timeout: Math.min(LIMITS.command_ms, Math.max(1, Math.floor(remaining))),
      killSignal: 'SIGKILL', maxBuffer: LIMITS.output_bytes, encoding: null
    });
  }
  function successful(result) { return !result.error && !result.signal && result.status === 0; }
  function run(args, input, deadline) {
    const result = raw(args, input, deadline);
    if (!successful(result)) reject('GIT_COMMAND_FAILED', { command: args[0],
      exit_code: result.status, signal: result.signal || null, uncertain: Boolean(result.error || result.signal) });
    return Buffer.from(result.stdout || []);
  }
  function oidOutput(bytes) {
    const value = utf8(bytes).trim();
    if (!OID.test(value) || value === ZERO) reject('INVALID_GIT_OUTPUT');
    return value;
  }
  function directHead() {
    guard();
    const file = path.join(repo, ref);
    if (absent(file)) return null;
    const text = utf8(readRegular(file, 128));
    if (!/^[0-9a-f]{40}\n$/.test(text) || text.slice(0, 40) === ZERO) reject('NON_DIRECT_REF');
    return text.slice(0, 40);
  }
  function observe(deadline) {
    const current = directHead();
    if (lastObserved !== undefined && lastObserved !== null && current !== lastObserved) {
      if (current === null) { quarantined = true; reject('REF_ROLLBACK'); }
      const result = raw(['merge-base', '--is-ancestor', lastObserved, current], undefined, deadline);
      if (!successful(result)) { quarantined = true; reject('REF_HISTORY_UNVERIFIED'); }
    }
    lastObserved = current;
    return current;
  }
  function bundle(head, deadline) {
    if (head === null) return new Map();
    if (utf8(run(['cat-file', '-t', head], undefined, deadline)).trim() !== 'commit') reject('INVALID_COMMIT');
    const lines = utf8(run(['ls-tree', '-r', '-z', '--full-tree', head], undefined, deadline)).split('\0');
    if (lines.pop() !== '') reject('INVALID_TREE');
    if (lines.length > LIMITS.keys) reject('TREE_LIMIT');
    const result = new Map(); let total = 0;
    for (const line of lines) {
      const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (!match) reject('UNSUPPORTED_TREE_ENTRY');
      const name = key(match[2]);
      if (result.has(name)) reject('DUPLICATE_KEY');
      const bytes = run(['cat-file', 'blob', match[1]], undefined, deadline);
      if (bytes.length > LIMITS.item_bytes || (total += bytes.length) > LIMITS.total_bytes) reject('TREE_LIMIT');
      const verified = crypto.createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
      if (verified !== match[1]) reject('OBJECT_DIGEST_MISMATCH');
      utf8(bytes); result.set(name, { bytes, oid: match[1] });
    }
    return result;
  }
  function validateMerged(records) {
    if (records.size > LIMITS.keys) reject('BATCH_LIMIT');
    let total = 0;
    for (const [name, record] of records) {
      total += record.bytes.length;
      const pieces = name.split('/');
      while (pieces.length > 1) { pieces.pop(); if (records.has(pieces.join('/'))) reject('KEY_PREFIX_CONFLICT'); }
    }
    if (total > LIMITS.total_bytes) reject('BATCH_LIMIT');
  }
  function evidence(entry, extra = {}) {
    return Object.freeze({ transaction_id: entry.id, ref, base_revision: typed(entry.base),
      prepared_commit: entry.commit, prepared_tree: entry.tree,
      prepared_blobs: Object.freeze([...entry.blobs]), phase: 'prepare-object',
      objects_may_exist: entry.started, publication: 'NOT_ATTEMPTED',
      operation_budget_ms: LIMITS.operation_ms,
      prepare_elapsed_ms: entry.prepareElapsed === null ? Math.max(0, performance.now() - entry.startedAt) : entry.prepareElapsed,
      publish_elapsed_ms: entry.publishStartedAt === null ? null : Math.max(0, performance.now() - entry.publishStartedAt),
      ...extra });
  }
  function readSnapshot(requested) {
    const selected = keys(requested); const deadline = begin(); const head = observe(deadline);
    const all = bundle(head, deadline); const records = Object.create(null);
    for (const name of selected) {
      const item = all.get(name);
      records[name] = item ? Object.freeze({ content: utf8(item.bytes), blob: item.oid,
        sha256: digest(item.bytes), bytes: item.bytes.length }) : null;
    }
    return Object.freeze({ revision: typed(head), records: Object.freeze(records), effect_authority: false });
  }
  function prepareBatch(request) {
    const startedAt = performance.now();
    exact(request, ['expected_revision', 'writes', 'transaction_id']);
    const base = revision(request.expected_revision);
    if (typeof request.transaction_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(request.transaction_id))
      reject('INVALID_TRANSACTION_ID');
    if (!Array.isArray(request.writes) || request.writes.length === 0 || request.writes.length > LIMITS.keys)
      reject('INVALID_WRITES');
    const writes = request.writes.map(item => {
      exact(item, ['key', 'content']); return { key: key(item.key), bytes: body(item.content) };
    });
    keys(writes.map(item => item.key));
    if (writes.reduce((n, item) => n + item.bytes.length, 0) > LIMITS.total_bytes) reject('BATCH_LIMIT');
    const deadline = begin(); const current = observe(deadline);
    if (current !== base) reject('REVISION_CONFLICT', { expected_revision: typed(base), observed_revision: typed(current),
      phase: 'validation', objects_may_exist: false, publication: 'NOT_ATTEMPTED' });
    const records = bundle(base, deadline);
    for (const item of writes) records.set(item.key, { bytes: item.bytes, oid: null });
    validateMerged(records);
    const entry = { base, id: request.transaction_id, commit: null, tree: null, blobs: [], started: false, used: false,
      startedAt, prepareElapsed: null, publishStartedAt: null };
    try {
      // All request and complete merged-tree validation precedes the first object write.
      for (const item of records.values()) if (item.oid === null) {
        entry.started = true;
        item.oid = oidOutput(run(['hash-object', '-w', '--stdin', '--no-filters'], item.bytes, deadline));
        entry.blobs.push(item.oid);
      }
      function tree(prefix) {
        const directories = new Set(); const entries = [];
        for (const [name, item] of records) {
          if (!name.startsWith(prefix)) continue;
          const rest = name.slice(prefix.length); const slash = rest.indexOf('/');
          if (slash < 0) entries.push({ name: rest, mode: '100644', type: 'blob', oid: item.oid });
          else directories.add(rest.slice(0, slash));
        }
        for (const name of directories) entries.push({ name, mode: '040000', type: 'tree', oid: tree(prefix + name + '/') });
        entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.type === 'tree' ? '/' : '')),
          Buffer.from(b.name + (b.type === 'tree' ? '/' : ''))));
        const input = Buffer.from(entries.map(item => item.mode + ' ' + item.type + ' ' + item.oid + '\t' + item.name + '\0').join(''));
        entry.started = true;
        return oidOutput(run(['mktree', '-z'], input, deadline));
      }
      entry.tree = tree('');
      entry.commit = oidOutput(run(['commit-tree', entry.tree, ...(base ? ['-p', base] : [])],
        Buffer.from('cortex-transaction-v1 ' + entry.id + '\n'), deadline));
      entry.prepareElapsed = Math.max(0, performance.now() - startedAt);
      const handle = Object.freeze(Object.create(null)); handles.set(handle, entry);
      return Object.freeze({ handle, evidence: evidence(entry), effect_authority: false });
    } catch (error) {
      throw new GitTransactionError(error.code || 'PREPARE_FAILED', evidence(entry, {
        cause: error.code || 'PREPARE_FAILED', publication: 'NOT_ATTEMPTED' }));
    }
  }
  function publishPrepared(handle) {
    const entry = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
    if (!entry || entry.used) reject('INVALID_OR_CONSUMED_HANDLE');
    entry.used = true; entry.publishStartedAt = performance.now();
    let attempted = false; let result; let observed = null; let observation = 'UNAVAILABLE';
    const finish = (status, extra = {}) => {
      if (status === 'UNKNOWN') quarantined = true;
      return Object.freeze({ status, effect_authority: false,
        evidence: evidence(entry, { phase: attempted ? 'publish-ref' : 'prepare-object',
          publication: status, publish_attempted: attempted, observed_revision: typed(observed),
          observation, publish_budget_exhausted: performance.now() - entry.publishStartedAt >= LIMITS.operation_ms,
          ...extra }) });
    };
    try {
      const deadline = begin(); observed = observe(deadline); observation = 'DIRECT_REF';
      if (observed !== entry.base) return finish('CONFLICT');
      result = raw(['update-ref', '--no-deref', ref, entry.commit, entry.base || ZERO], undefined, deadline, () => { attempted = true; });
      observed = null; observation = 'UNAVAILABLE';
      observed = directHead(); observation = 'DIRECT_REF';
      if (successful(result)) {
        // Another valid writer may have advanced immediately after our successful CAS.
        if (observed !== entry.commit) {
          if (observed === null || !successful(raw(['merge-base', '--is-ancestor', entry.commit, observed], undefined, deadline)))
            return finish('UNKNOWN', { reason: 'POST_PUBLISH_HISTORY_UNVERIFIED' });
        }
        lastObserved = observed;
        return finish('PUBLISHED', { published_revision: typed(entry.commit) });
      }
      if (result.error || result.signal || !Number.isInteger(result.status))
        return finish('UNKNOWN', { reason: 'PUBLISH_EXIT_UNCERTAIN', exit_code: result.status, signal: result.signal || null });
      const stderr = Buffer.from(result.stderr || []).toString('utf8');
      const conflict = "fatal: update_ref failed for ref '" + ref + "': cannot lock ref '" + ref + "': ";
      if (observed !== entry.commit && observed !== entry.base && stderr.startsWith(conflict) &&
          (stderr.includes('but expected ' + (entry.base || ZERO)) || stderr.includes('reference already exists')))
        return finish('CONFLICT', { reason: 'CAS_REJECTED', exit_code: result.status });
      return finish('UNKNOWN', { reason: 'PUBLISH_FAILED', exit_code: result.status });
    } catch (error) {
      if (attempted) quarantined = true;
      return finish('UNKNOWN', { reason: error.code || 'PUBLISH_FAILED', publish_attempted: attempted });
    }
  }
  guard();
  return Object.freeze({ readSnapshot, prepareBatch, publishPrepared, ref, limits: LIMITS, effect_authority: false });
}

module.exports = { createGitTransactionStore, GitTransactionError, GIT_TRANSACTION_REF: REF };
