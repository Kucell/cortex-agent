/**
 * tests/governed-attempt-progress/watchdog-default.test.js
 *
 * M-013 SP-005 / VC-006a: Default behavior is NOTIFY (not auto-abort).
 * Steer requires 4-gate verification (capability + lease + Operation + authz).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tick, makeInitialState, STATES } = require('../../lib/governed-attempt-progress/watchdog');
const { getDefaultPolicy } = require('../../lib/governed-attempt-progress/policy-loader');
const { DIAGNOSTIC_CODES } = require('../../lib/governed-attempt-progress/notification');

const POLICY = getDefaultPolicy();
const NOW = '2026-08-11T10:00:00.000Z';
const FUTURE = '2026-08-11T11:00:00.000Z'; // 1 hour later (way past grace)

function attemptState(overrides = {}) {
  return {
    taskId: 'T-WD-002',
    attempt: 1,
    evidenceLevel: 'alive',
    lastActivityAt: '2026-08-11T09:50:00.000Z', // 10 min ago
    lastProductiveAt: null,
    activity: { readOnlyToolCount: 0, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
    ...overrides,
  };
}

test('VC-006a: default policy onExhausted=notify (NOT abort)', () => {
  assert.equal(POLICY.onExhausted, 'notify', 'default policy must be notify');
});

test('VC-006a: grace expired with default policy → NOTIFIED (not ABORTED)', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  // Trigger no_progress_detected
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);

  // Steer with idempotency key → enter GRACE
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'k-1', reason: 'stale_progress' },
  }, POLICY);
  assert.equal(s.state, STATES.GRACE);

  // Wait past graceMs (default 120s = 2 min)
  s = tick(s, {
    now: '2026-08-11T10:05:00.000Z', // 5 min after steer
    attemptState: attemptState({ lastActivityAt: '2026-08-11T10:05:00.000Z' }),
  }, POLICY);
  assert.equal(s.state, STATES.NOTIFIED, 'grace expired → NOTIFIED (default), not ABORTED');
  const diag = s.diagnostics[s.diagnostics.length - 1];
  assert.equal(diag.code, DIAGNOSTIC_CODES.GRACE_EXPIRED);
});

test('VC-006a: policy with onExhausted=abort requires explicit maxSteerAttempts=1', () => {
  const { validatePolicy } = require('../../lib/governed-attempt-progress/policy-loader');
  // Valid: abort + maxSteerAttempts=1
  const valid = validatePolicy({
    policyId: 'v1-default',
    maxReadOnlyActionsWithoutEvidence: 8,
    maxNoProductiveMs: 600000,
    maxNoHeartbeatMs: 90000,
    maxSteerAttempts: 1,
    steerGraceMs: 120000,
    onExhausted: 'abort',
  });
  assert.equal(valid.onExhausted, 'abort');

  // Invalid: abort + maxSteerAttempts=0 (P-005 §7.2 bounded steer template)
  assert.throws(() => validatePolicy({
    policyId: 'v1-default',
    maxReadOnlyActionsWithoutEvidence: 8,
    maxNoProductiveMs: 600000,
    maxNoHeartbeatMs: 90000,
    maxSteerAttempts: 0,
    steerGraceMs: 120000,
    onExhausted: 'abort',
  }), /maxSteerAttempts/);
});

test('VC-006a: policy can disable steer via maxSteerAttempts=0 → straight to NOTIFIED', () => {
  const { validatePolicy } = require('../../lib/governed-attempt-progress/policy-loader');
  const noSteerPolicy = validatePolicy({
    policyId: 'v1-default',
    maxReadOnlyActionsWithoutEvidence: 8,
    maxNoProductiveMs: 600000,
    maxNoHeartbeatMs: 90000,
    maxSteerAttempts: 0,
    steerGraceMs: 120000,
    onExhausted: 'notify',
  });
  let s = makeInitialState(noSteerPolicy, { attemptState: attemptState() });
  // First tick: no_progress detected; with noSteer policy, immediate NOTIFIED
  // (no grace period because steer is disabled entirely)
  s = tick(s, { now: NOW, attemptState: attemptState() }, noSteerPolicy);
  assert.equal(s.state, STATES.NOTIFIED, 'no-steer policy must skip GRACE and go straight to NOTIFIED');
});

test('VC-006a: 4-gate verification (capability + lease + Operation + authz) is enforced upstream', () => {
  // The 4-gate is enforced by the steer caller (control port supervisor), not
  // by the watchdog state machine. Watchdog validates idempotency-key only.
  // This test asserts the watchdog emits a steer_rejected diagnostic when
  // idempotency-key is missing — the upstream caller is responsible for the
  // 4-gate before issuing a steer attempt.
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);

  // Steer without idempotency-key → rejected
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { reason: 'stale_progress' /* missing idempotencyKey */ },
  }, POLICY);
  const rejected = s.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.STEER_REJECTED);
  assert.ok(rejected, 'watchdog must emit STEER_REJECTED when idempotency-key missing');
  assert.equal(rejected.detail.reason, 'missing_idempotency_key');
  assert.equal(s.state, STATES.NO_PROGRESS, 'rejected steer must NOT advance state');
});