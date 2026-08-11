/**
 * tests/cli/agent-supervise-cli.test.js
 *
 * M-013 SP-006 / VC-010a: CLI contract for `cortex-agent agent supervise <action>`.
 * Tests use the existing pure functions exported from lib/cli/agent-supervise.js.
 *
 * Reason codes (per existing lib/cli/agent-supervise.js REASON_CODES):
 *   stale_progress, host_unresponsive, user_request, policy_violation,
 *   scope_expansion_detected, explicit_abort
 *
 * Abort envelope shape: result.preserve = { worktree, journal, receipt, cleanupInvoked }
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidAction,
  isValidReason,
  isValidIdempotencyKey,
  verifyFourGates,
  statusProjection,
  buildSteerRequest,
  buildAbortRequest,
  cliDispatch,
  SUPERVISE_ACTIONS
} = require('../../lib/cli/agent-supervise');

const VALID_REASONS = [
  'stale_progress',
  'host_unresponsive',
  'user_request',
  'policy_violation',
  'scope_expansion_detected',
  'explicit_abort'
];

const ALL_GATES = { capability: true, lease: true, operation: true, authorization: true };
const ANY_GATE_OFF = { capability: true, lease: true, operation: true, authorization: false };

test('contract: SUPERVISE_ACTIONS contains status/steer/abort', () => {
  assert.deepEqual([...SUPERVISE_ACTIONS], ['status', 'steer', 'abort']);
});

test('contract: isValidAction accepts only 3 actions', () => {
  assert.equal(isValidAction('status'), true);
  assert.equal(isValidAction('steer'), true);
  assert.equal(isValidAction('abort'), true);
  assert.equal(isValidAction('rm_rf'), false);
  assert.equal(isValidAction(''), false);
  assert.equal(isValidAction(null), false);
});

test('contract: isValidReason bounded enum (no arbitrary shell)', () => {
  for (const r of VALID_REASONS) {
    assert.equal(isValidReason(r), true, `${r} should be valid`);
  }
  assert.equal(isValidReason('rm_rf_root'), false);
  assert.equal(isValidReason('cat /etc/passwd'), false);
  assert.equal(isValidReason('no_progress_detected'), false, 'old reason code removed');
  assert.equal(isValidReason(''), false);
});

test('contract: isValidIdempotencyKey pattern (8-128 chars [a-zA-Z0-9_-])', () => {
  assert.equal(isValidIdempotencyKey('k-001-abc'), true);
  assert.equal(isValidIdempotencyKey('a'.repeat(128)), true);
  assert.equal(isValidIdempotencyKey('short'), false);
  assert.equal(isValidIdempotencyKey('a'.repeat(129)), false);
  assert.equal(isValidIdempotencyKey('has spaces'), false);
  assert.equal(isValidIdempotencyKey(''), false);
});

test('verifyFourGates: ok when all 4 gates pass', () => {
  const result = verifyFourGates(ALL_GATES);
  assert.deepEqual(result, { ok: true });
});

test('verifyFourGates: missing each gate reports the missing list', () => {
  for (const missing of ['capability', 'lease', 'operation', 'authorization']) {
    const gates = { ...ALL_GATES };
    gates[missing] = false;
    const result = verifyFourGates(gates);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [missing]);
  }
});

test('verifyFourGates: all 4 missing reports all 4', () => {
  const result = verifyFourGates({});
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 4);
});

test('statusProjection: returns state with privacy-bound fields', () => {
  const state = {
    schemaVersion: '1.0',
    taskId: 't-001', operationId: 'op-001', launchId: 'L-001', attempt: 1,
    phase: 'ready', evidenceLevel: 'verified',
    lastActivityAt: '2026-08-11T03:00:00.000Z',
    lastProductiveAt: '2026-08-11T03:00:00.000Z',
    activity: { readOnlyToolCount: 5, writeToolCount: 3, testToolCount: 1, failedToolCount: 0 },
    worktree: {
      baselineHead: 'sha256:h', statusDigest: 'sha256:s', diffDigest: 'sha256:d',
      changedFileCount: 3, insertions: 50, deletions: 10
    },
    validation: { lastCommandId: 'v-001', status: 'passed', evidenceRef: 'sha256:r' },
    diagnostics: []
  };
  const result = statusProjection(state, { launchId: 'L-001' });
  assert.equal(result.ok, true);
  assert.equal(result.evidenceLevel, 'verified');
  assert.equal(result.phase, 'ready');
  assert.equal(result.worktree.changedFileCount, 3);
  assert.ok(!('content' in result), 'no content field');
  assert.ok(!('text' in result), 'no text field');
  assert.ok(!('raw' in result), 'no raw field');
});

test('statusProjection: STATE_UNAVAILABLE when state is null', () => {
  const result = statusProjection(null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STATE_UNAVAILABLE');
});

test('buildSteerRequest: ok with all 4 gates + reason + idempotencyKey', () => {
  const result = buildSteerRequest({
    launchId: 'L-001',
    reason: 'stale_progress',
    idempotencyKey: 'k-001-abc',
    gates: ALL_GATES
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'steer');
  assert.equal(result.launchId, 'L-001');
  assert.equal(result.reason, 'stale_progress');
  assert.equal(result.idempotencyKey, 'k-001-abc');
  assert.ok(result.nonce, 'nonce present');
});

test('buildSteerRequest: GATE_VIOLATION when any gate missing', () => {
  const result = buildSteerRequest({
    launchId: 'L-001',
    reason: 'stale_progress',
    idempotencyKey: 'k-001-abc',
    gates: ANY_GATE_OFF
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GATE_VIOLATION');
  assert.deepEqual(result.error.details.missing, ['authorization']);
});

test('buildSteerRequest: INVALID_REASON rejects arbitrary reason', () => {
  const result = buildSteerRequest({
    launchId: 'L-001',
    reason: 'rm_rf_root',
    idempotencyKey: 'k-001-abc',
    gates: ALL_GATES
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REASON');
});

test('buildAbortRequest: ok with all 4 gates; preserve invariants recorded', () => {
  const result = buildAbortRequest({
    launchId: 'L-001',
    reason: 'explicit_abort',
    idempotencyKey: 'k-001-abc',
    gates: ALL_GATES
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'abort');
  // Per P-005 §6.3 — abort NEVER executes cleanup
  assert.ok(result.preserve, 'preserve object present');
  assert.equal(result.preserve.worktree, true, 'worktree preserved');
  assert.equal(result.preserve.journal, true, 'journal preserved');
  assert.equal(result.preserve.receipt, true, 'receipt preserved');
  assert.equal(result.preserve.cleanupInvoked, false, 'cleanup NEVER invoked');
});

test('buildAbortRequest: GATE_VIOLATION when any gate missing', () => {
  const result = buildAbortRequest({
    launchId: 'L-001',
    reason: 'explicit_abort',
    idempotencyKey: 'k-001-abc',
    gates: ANY_GATE_OFF
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'GATE_VIOLATION');
});

test('cliDispatch: routes status with positional args', () => {
  const state = {
    schemaVersion: '1.0',
    taskId: 't-001', operationId: 'op-001', launchId: 'L-001', attempt: 1,
    phase: 'ready', evidenceLevel: 'verified',
    lastActivityAt: '2026-08-11T03:00:00.000Z',
    lastProductiveAt: '2026-08-11T03:00:00.000Z',
    activity: { readOnlyToolCount: 0, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
    worktree: { baselineHead: 'h', statusDigest: 's', diffDigest: 'd', changedFileCount: 0, insertions: 0, deletions: 0 },
    validation: { lastCommandId: null, status: 'not_run', evidenceRef: null },
    diagnostics: []
  };
  const result = cliDispatch(['status', 'L-001'], state);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'status');
  assert.equal(result.launchId, 'L-001');
});

test('cliDispatch: steer with positional args + hard-code gates ok', () => {
  const result = cliDispatch(['steer', 'L-001', 'stale_progress', 'k-001-abc'], null);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'steer');
  assert.equal(result.launchId, 'L-001');
  assert.equal(result.reason, 'stale_progress');
});

test('cliDispatch: abort with positional args preserves worktree/journal/receipt', () => {
  const result = cliDispatch(['abort', 'L-001', 'explicit_abort', 'k-001-abc'], null);
  assert.equal(result.ok, true);
  assert.equal(result.action, 'abort');
  assert.equal(result.preserve.worktree, true);
  assert.equal(result.preserve.journal, true);
  assert.equal(result.preserve.receipt, true);
  assert.equal(result.preserve.cleanupInvoked, false);
});

test('cliDispatch: rejects unknown action with INVALID_ACTION', () => {
  const result = cliDispatch(['rm_rf'], null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ACTION');
});

test('cliDispatch: rejects invalid reason with INVALID_REASON', () => {
  const result = cliDispatch(['steer', 'L-001', 'rm_rf_root', 'k-001-abc'], null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_REASON');
});

test('cliDispatch: rejects invalid idempotencyKey with INVALID_IDEMPOTENCY_KEY', () => {
  const result = cliDispatch(['steer', 'L-001', 'stale_progress', 'short'], null);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_IDEMPOTENCY_KEY');
});