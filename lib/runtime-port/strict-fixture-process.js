'use strict';

// Development-only complete-source-checkout fixture runtime.
// package.json excludes its tests/fixtures worker, so the npm tarball cannot
// run the enabled fixture. This is not a packaged AI Host capability.
// Cooperative, trusted-script fixture runtime only.
// Parent callbacks MUST be synchronous, instance-owned closures. The parent
// owns canonical Decision/Waitpoint/Authorization/Operation/lease checks.
// assertActive is only the cancellation/deadline guard, not authority.
// The fixed worker creates no descendants. A leader exit or a group signal
// alone does not prove an arbitrary process tree has stopped.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createRuntimePort } = require('../../packages/runtime-port/src/index.js');

const PROTOCOL = 'cortex-l3-fixture/v1';
const WORKER = path.resolve(__dirname, '../../tests/fixtures/l3/strict-process-worker.cjs');
const TASKS = new Set(['T-FIXTURE-1', 'T-FIXTURE-2', 'T-FIXTURE-3']);
const KILL_OBSERVE_MS = 1000;
const EVIDENCE_REF = /^fixture-evidence:[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const OPTION_KEYS = new Set([
  'enabled', 'fixtureOnly', 'cwd', 'maxTaskMs', 'maxTotalMs',
  'cancelGraceMs', 'onStart', 'onBeforeSpawn', 'onProposal', 'onStop',
]);
class StrictFixtureRuntimeError extends Error {
  constructor(code) { super(code); this.name = 'StrictFixtureRuntimeError'; this.code = code; }
}
function error(code) { return new StrictFixtureRuntimeError(code); }
function stamp() { return new Date().toISOString(); }
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function integer(value, fallback, minimum, maximum, code) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw error(code);
  return result;
}
function syncCall(callback, input) {
  const result = callback(Object.freeze(input));
  if (result !== null && result !== undefined
      && (typeof result === 'object' || typeof result === 'function')
      && typeof result.then === 'function') {
    if (result instanceof Promise) Promise.prototype.then.call(result, () => {}, () => {});
    throw error('ERR_FIXTURE_ASYNC_CALLBACK');
  }
  return result;
}
function evidence(value, run, proposalId) {
  const keys = ['kind', 'run_ref', 'task_id', 'evidence_refs'];
  if (proposalId !== null) keys.push('proposal_id');
  if (!exact(value, keys) || value.kind !== 'runtime_evidence'
      || value.run_ref !== run.runRef || value.task_id !== run.taskId
      || (proposalId !== null && value.proposal_id !== proposalId)
      || !Array.isArray(value.evidence_refs)
      || value.evidence_refs.length < 1 || value.evidence_refs.length > 8
      || value.evidence_refs.some((ref) => typeof ref !== 'string' || !EVIDENCE_REF.test(ref))) {
    throw error('ERR_FIXTURE_EVIDENCE_INVALID');
  }
  if (new Set(value.evidence_refs).size !== value.evidence_refs.length) throw error('ERR_FIXTURE_EVIDENCE_INVALID');
  const normalized = { kind: 'runtime_evidence', run_ref: run.runRef, task_id: run.taskId,
    evidence_refs: Object.freeze([...value.evidence_refs]) };
  if (proposalId !== null) normalized.proposal_id = proposalId;
  return Object.freeze(normalized);
}
function validateLocation(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw error('ERR_FIXTURE_CWD_REQUIRED');
  const supplied = path.resolve(cwd);
  const root = fs.realpathSync(os.tmpdir());
  const actual = fs.realpathSync(supplied);
  if (fs.lstatSync(supplied).isSymbolicLink() || !fs.statSync(actual).isDirectory()
      || path.dirname(actual) !== root
      || !/^cortex-l3-fixture-[A-Za-z0-9_-]+$/.test(path.basename(actual))) {
    throw error('ERR_FIXTURE_CWD_OUTSIDE_TEMP_ROOT');
  }
  const workerStat = fs.lstatSync(WORKER);
  if (workerStat.isSymbolicLink() || !workerStat.isFile()) throw error('ERR_FIXTURE_WORKER_INVALID');
  return Object.freeze({ cwd: actual, worker: fs.realpathSync(WORKER) });
}
function createStrictFixtureProcessRuntime(options = {}) {
  if (!plain(options) || Object.keys(options).some((key) => !OPTION_KEYS.has(key))) throw error('ERR_FIXTURE_OPTIONS_INVALID');
  const enabled = options.enabled === undefined ? false : options.enabled;
  if (typeof enabled !== 'boolean') throw error('ERR_FIXTURE_ENABLED_INVALID');
  const maxTaskMs = integer(options.maxTaskMs, 1000, 1, 10000, 'ERR_FIXTURE_TASK_BUDGET');
  const maxTotalMs = integer(options.maxTotalMs, 30000, 1, 60000, 'ERR_FIXTURE_TOTAL_BUDGET');
  const cancelGraceMs = integer(options.cancelGraceMs, 200, 0, 2000, 'ERR_FIXTURE_CANCEL_GRACE');
  const callbacks = Object.freeze({ onStart: options.onStart, onBeforeSpawn: options.onBeforeSpawn, onProposal: options.onProposal, onStop: options.onStop });
  let location = null;
  if (enabled) {
    if (options.fixtureOnly !== true) throw error('ERR_FIXTURE_ONLY_REQUIRED');
    if (process.platform === 'win32') throw error('ERR_FIXTURE_POSIX_REQUIRED');
    for (const name of ['onStart', 'onBeforeSpawn', 'onProposal', 'onStop']) {
      if (typeof callbacks[name] !== 'function') throw error('ERR_FIXTURE_CALLBACK_REQUIRED');
    }
    location = validateLocation(options.cwd);
  }
  // OFF performs no filesystem inspection, process creation, or callbacks.
  const runs = new Map(), attemptedTasks = new Set();
  let activeRun = null, closed = false, quarantined = false;
  let totalDeadline = null, totalTimer = null, closePromise = null;
  const limits = Object.freeze({ max_attempts: 1, max_parallel: 1, max_runs: 3,
    max_task_ms: maxTaskMs, max_total_ms: maxTotalMs, cancel_grace_ms: cancelGraceMs });
  function snapshot(run) {
    return Object.freeze({
      run_ref: run.runRef, task_id: run.taskId, status: run.status,
      accepted: true, task_completion_asserted: false,
      runtime_outcome: run.unknown.length ? 'UNKNOWN' : (run.runtimeEvidence ? 'EVIDENCE_RECORDED' : 'PENDING'),
      created_at: run.createdAt, updated_at: run.updatedAt, spawned: run.spawned, process_exited: run.exitObserved,
      process_tree_verified: false,
      process_outcome: run.processOutcome, exit_code: run.exitCode, exit_signal: run.exitSignal,
      stopping_reason: run.stopReason, reason_codes: Object.freeze([...run.unknown]),
      start_evidence: run.startEvidence, runtime_evidence: run.runtimeEvidence, stop_evidence: run.stopEvidence,
    });
  }
  function findRun(ref) {
    if (typeof ref !== 'string' || !runs.has(ref)) throw error('ERR_FIXTURE_RUN_NOT_FOUND');
    return runs.get(ref);
  }
  function unknown(run, code) {
    if (!run.unknown.includes(code)) run.unknown.push(code);
    quarantined = true; run.effectsOpen = false; run.acceptMessages = false;
    if (!run.abort.signal.aborted) run.abort.abort();
    run.updatedAt = stamp();
  }
  function assertActive(run) {
    const at = performance.now();
    if (closed || quarantined || run.settled || run.finalizing || !run.effectsOpen
        || run.abort.signal.aborted || run.exitObserved || run.stopReason
        || at >= run.deadline || (totalDeadline !== null && at >= totalDeadline)) throw error('ERR_FIXTURE_EFFECT_ADMISSION_CLOSED');
  }
  function clearRunTimers(run) {
    if (run.spawnImmediate !== null) clearImmediate(run.spawnImmediate);
    for (const key of ['taskTimer', 'killTimer', 'observeTimer']) {
      if (run[key] !== null) clearTimeout(run[key]);
      run[key] = null;
    }
    run.spawnImmediate = null;
  }
  function finish(run, proposedStatus) {
    if (run.settled || run.finalizing) return;
    run.finalizing = true; run.effectsOpen = false; run.acceptMessages = false;
    if (!run.abort.signal.aborted) run.abort.abort();
    clearRunTimers(run);
    run.status = run.unknown.length ? 'UNKNOWN' : proposedStatus;
    run.updatedAt = stamp();
    // Exactly once, including a failed or partially applied onStart.
    try {
      const result = syncCall(callbacks.onStop, {
        run_ref: run.runRef, task_id: run.taskId, status: run.status,
        spawned: run.spawned, process_exited: run.exitObserved,
        process_outcome: run.processOutcome, exit_code: run.exitCode, exit_signal: run.exitSignal,
        reason_codes: Object.freeze([...run.unknown]), start_evidence: run.startEvidence, runtime_evidence: run.runtimeEvidence,
      });
      if (result !== undefined) run.stopEvidence = evidence(result, run, null);
    } catch (_) { unknown(run, 'stop_callback_failed'); run.status = 'UNKNOWN'; }
    run.finalizing = false; run.settled = true; run.updatedAt = stamp();
    if (activeRun === run) activeRun = null;
    for (const notify of [...run.waiters]) notify();
    run.waiters.clear();
  }
  function signalGroup(run, signal) {
    if (!run.child || run.exitObserved || !Number.isInteger(run.pid) || run.pid < 1) return false;
    try { process.kill(-run.pid, signal); return true; }
    catch (failure) {
      // ESRCH is not exit evidence. Wait for the observed exit event.
      if (!failure || failure.code !== 'ESRCH') unknown(run, 'termination_signal_failed');
      return false;
    }
  }
  function stoppedStatus(run) {
    return run.unknown.length ? 'UNKNOWN' : run.stopReason === 'timeout' ? 'timed_out' : 'canceled';
  }
  function stop(run, reason) {
    if (run.settled || run.finalizing) return;
    run.effectsOpen = false; run.acceptMessages = false;
    if (!run.abort.signal.aborted) run.abort.abort();
    if (run.stopReason !== null) return;
    run.stopReason = reason; run.status = 'stopping'; run.updatedAt = stamp();
    if (run.taskTimer !== null) clearTimeout(run.taskTimer);
    run.taskTimer = null;
    if (run.spawnImmediate !== null) clearImmediate(run.spawnImmediate);
    run.spawnImmediate = null;
    if (!run.child) { run.processOutcome = 'not_started'; finish(run, stoppedStatus(run)); return; }
    signalGroup(run, 'SIGTERM');
    run.killTimer = setTimeout(() => {
      run.killTimer = null;
      if (run.exitObserved || run.settled) return;
      signalGroup(run, 'SIGKILL');
      run.observeTimer = setTimeout(() => {
        run.observeTimer = null;
        if (run.exitObserved || run.settled) return;
        unknown(run, 'exit_not_observed_after_kill'); run.processOutcome = 'UNKNOWN'; finish(run, 'UNKNOWN');
      }, KILL_OBSERVE_MS);
    }, cancelGraceMs);
  }
  function fail(run, code) {
    if (run.finalizing) return;
    unknown(run, code);
    if (run.settled) { run.status = 'UNKNOWN'; return; }
    stop(run, 'unknown');
  }
  function onExit(run, code, signal) {
    run.exitObserved = true;
    run.exitCode = Number.isInteger(code) ? code : null;
    run.exitSignal = typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null;
    run.acceptMessages = false; run.effectsOpen = false; run.updatedAt = stamp();
    if (run.settled) { run.processOutcome = 'exited_after_unknown'; return; }
    const clean = code === 0 && signal === null;
    const requestedSignal = signal === 'SIGTERM' || signal === 'SIGKILL';
    if (run.stopReason !== null) {
      if (!clean && !requestedSignal) unknown(run, 'child_crash');
      run.processOutcome = run.stopReason === 'timeout' ? 'timed_out'
        : (run.stopReason === 'cancel' || run.stopReason === 'close' ? 'canceled' : 'terminated');
      finish(run, stoppedStatus(run)); return;
    }
    if (!clean) unknown(run, 'child_crash');
    if (!run.runtimeEvidence) unknown(run, 'child_exited_without_runtime_evidence');
    run.processOutcome = clean ? 'exited' : 'crashed'; finish(run, 'exited');
  }
  function send(run, message) {
    if (!run.child || !run.child.connected || run.settled || run.stopReason) {
      if (!run.settled && !run.stopReason) fail(run, 'ipc_unavailable');
      return;
    }
    try {
      run.child.send(message, (failure) => {
        if (failure && !run.settled && !run.stopReason) fail(run, 'ipc_send_failed');
      });
    } catch (_) { if (!run.settled && !run.stopReason) fail(run, 'ipc_send_failed'); }
  }
  function onMessage(run, message) {
    if (!run.acceptMessages || run.settled || run.stopReason || run.exitObserved) return;
    const keys = ['type', 'protocol', 'run_id', 'task_id', 'proposal_id'];
    if (!exact(message, keys) || message.type !== 'proposal' || message.protocol !== PROTOCOL
        || message.run_id !== run.runId || message.task_id !== run.taskId
        || message.proposal_id !== run.proposalId || run.proposalSeen) { fail(run, 'unexpected_child_message'); return; }
    if (performance.now() >= run.deadline || performance.now() >= totalDeadline) { stop(run, 'timeout'); return; }
    run.proposalSeen = true;
    try {
      assertActive(run);
      const result = syncCall(callbacks.onProposal, {
        run_ref: run.runRef, task_id: run.taskId, proposal_id: run.proposalId,
        proposal: Object.freeze({ kind: 'fixture.record', task_id: run.taskId }),
        signal: run.abort.signal, assertActive: () => assertActive(run),
      });
      const receipt = evidence(result, run, run.proposalId);
      assertActive(run); run.runtimeEvidence = receipt; run.updatedAt = stamp();
      send(run, { type: 'proposal_result', protocol: PROTOCOL, run_id: run.runId,
        task_id: run.taskId, proposal_id: run.proposalId, evidence: receipt });
    } catch (_) { fail(run, 'proposal_callback_failed'); }
  }
  function spawnRun(run) {
    run.spawnImmediate = null;
    if (run.settled || run.stopReason || closed) return;
    if (performance.now() >= run.deadline || performance.now() >= totalDeadline) { stop(run, 'timeout'); return; }
    try {
      assertActive(run);
      const admission = syncCall(callbacks.onBeforeSpawn, { run_ref: run.runRef, task_id: run.taskId,
        signal: run.abort.signal, assertActive: () => assertActive(run) });
      evidence(admission, run, null);
      assertActive(run); run.status = 'starting'; run.updatedAt = stamp();
      const child = childProcess.spawn(process.execPath, [location.worker], {
        cwd: location.cwd, env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, shell: false, detached: true,
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
      });
      run.child = child; run.pid = Number.isInteger(child.pid) ? child.pid : null; run.spawned = run.pid !== null;
      child.on('message', (message) => onMessage(run, message));
      child.once('exit', (code, signal) => onExit(run, code, signal));
      child.on('error', () => {
        if (run.settled || run.finalizing) return;
        unknown(run, 'child_process_error');
        if (!run.spawned) { run.processOutcome = 'not_started'; finish(run, 'UNKNOWN'); }
        else stop(run, 'unknown');
      });
      child.once('disconnect', () => {
        if (!run.settled && !run.stopReason && !run.runtimeEvidence) fail(run, 'ipc_disconnected_before_evidence');
      });
      child.once('spawn', () => {
        if (run.settled || run.stopReason) return;
        run.spawned = true; run.pid = child.pid; run.status = 'running'; run.updatedAt = stamp();
        send(run, { type: 'start', protocol: PROTOCOL, run_id: run.runId, task_id: run.taskId });
      });
    } catch (_) { fail(run, 'spawn_failed'); }
  }
  function createRun(payload) {
    if (!enabled) throw error('ERR_FIXTURE_DISABLED');
    if (closed) throw error('ERR_FIXTURE_CLOSED');
    if (quarantined) throw error('ERR_FIXTURE_QUARANTINED');
    if (!exact(payload, ['task_id']) || !TASKS.has(payload.task_id)) throw error('ERR_FIXTURE_TASK_INVALID');
    if (activeRun !== null) throw error('ERR_FIXTURE_PARALLEL_LIMIT');
    if (attemptedTasks.has(payload.task_id)) throw error('ERR_FIXTURE_ATTEMPT_LIMIT');
    if (runs.size >= 3) throw error('ERR_FIXTURE_RUN_LIMIT');
    const at = performance.now();
    if (totalDeadline !== null && at >= totalDeadline) throw error('ERR_FIXTURE_TOTAL_DEADLINE');
    if (totalDeadline === null) {
      totalDeadline = at + maxTotalMs;
      totalTimer = setTimeout(() => { totalTimer = null; if (activeRun !== null) stop(activeRun, 'timeout'); }, maxTotalMs);
      totalTimer.unref();
    }
    const runId = 'strict-fixture-' + crypto.randomUUID();
    const run = { runId, runRef: 'run:' + runId, taskId: payload.task_id,
      proposalId: 'P-FIXTURE-' + payload.task_id.slice(-1), status: 'accepted', createdAt: stamp(), updatedAt: stamp(),
      deadline: Math.min(at + maxTaskMs, totalDeadline), child: null, pid: null, spawned: false, exitObserved: false,
      exitCode: null, exitSignal: null, processOutcome: null, effectsOpen: true, acceptMessages: true,
      abort: new AbortController(), proposalSeen: false, startEvidence: null, runtimeEvidence: null, stopEvidence: null,
      stopReason: null, unknown: [], settled: false, finalizing: false,
      spawnImmediate: null, taskTimer: null, killTimer: null, observeTimer: null, waiters: new Set() };
    runs.set(run.runRef, run); attemptedTasks.add(run.taskId); activeRun = run;
    try {
      const result = syncCall(callbacks.onStart, { run_ref: run.runRef, task_id: run.taskId,
        signal: run.abort.signal, assertActive: () => assertActive(run) });
      run.startEvidence = evidence(result, run, null);
      if (!run.settled && !run.stopReason) assertActive(run);
    } catch (_) {
      fail(run, 'start_callback_failed');
      return Object.freeze({ run_ref: run.runRef, accepted: true, status: run.status });
    }
    if (run.settled || run.stopReason) return Object.freeze({ run_ref: run.runRef, accepted: true, status: run.status });
    run.taskTimer = setTimeout(() => stop(run, 'timeout'), Math.max(0, run.deadline - performance.now()));
    run.spawnImmediate = setImmediate(() => spawnRun(run));
    return Object.freeze({ run_ref: run.runRef, accepted: true, status: run.status });
  }
  function wait(ref, options_ = {}) {
    const run = findRun(ref);
    if (!plain(options_) || Object.keys(options_).some((key) => key !== 'timeout_ms')) throw error('ERR_FIXTURE_WAIT_OPTIONS');
    const timeoutMs = integer(options_.timeout_ms, Math.min(60000, maxTaskMs + cancelGraceMs + KILL_OBSERVE_MS + 100),
      0, 60000, 'ERR_FIXTURE_WAIT_TIMEOUT');
    if (run.settled) return Promise.resolve(Object.freeze({ ...snapshot(run), wait_timed_out: false }));
    return new Promise((resolve) => {
      let timer = null;
      const done = (timedOut) => {
        run.waiters.delete(notify); if (timer !== null) clearTimeout(timer);
        resolve(Object.freeze({ ...snapshot(run), wait_timed_out: timedOut }));
      };
      const notify = () => done(false);
      run.waiters.add(notify); timer = setTimeout(() => done(true), timeoutMs);
    });
  }
  function cancel(ref) {
    const run = findRun(ref);
    if (!run.settled) stop(run, 'cancel');
    return Object.freeze({ run_ref: run.runRef, cancel_requested: true,
      cancelled: run.status === 'canceled' && (!run.spawned || run.exitObserved),
      status: run.status, process_exited: run.exitObserved });
  }
  function awaitTerminal(run) {
    if (run.settled) return Promise.resolve();
    return new Promise((resolve) => run.waiters.add(resolve));
  }
  function close() {
    if (closePromise !== null) return closePromise;
    let resolveClose;
    // Publish the promise before stop/onStop can synchronously call close again.
    closePromise = new Promise((resolve) => { resolveClose = resolve; });
    closed = true;
    if (totalTimer !== null) clearTimeout(totalTimer);
    totalTimer = null;
    const all = [...runs.values()];
    for (const run of all) {
      if (!run.settled) stop(run, 'close');
      else if (run.spawned && !run.exitObserved) signalGroup(run, 'SIGKILL');
    }
    Promise.all(all.map(awaitTerminal)).then(() => resolveClose(Object.freeze({
      closed: true, quarantined, process_tree_verified: false,
      all_workers_exited: all.every((run) => !run.spawned || run.exitObserved),
      runs: Object.freeze(all.map(snapshot)),
    })));
    return closePromise;
  }
  const descriptor = Object.freeze({
    protocol: 'cortex-runtime', protocol_version: '1.0', implementation: 'strict-fixture-process', implementation_version: null,
    capabilities: Object.freeze(['runtime.discover', 'runtime.health', 'runtime.run.create',
      'runtime.run.status', 'runtime.run.wait', 'runtime.run.cancel']),
  });
  const port = createRuntimePort({ descriptor, operations: {
    discoverRuntime: () => Object.freeze({ descriptor, fixture_only: true,
      trust_model: 'cooperative_fixed_script', enabled, limits }),
    health: () => Object.freeze({ ready: enabled && !closed && !quarantined
      && (totalDeadline === null || performance.now() < totalDeadline),
      enabled, closed, quarantined, fixture_only: true, limits }),
    createRun, getStatus: (ref) => snapshot(findRun(ref)), wait, cancel,
  } });
  return Object.freeze({ port, close });
}
module.exports = { createStrictFixtureProcessRuntime, StrictFixtureRuntimeError };
