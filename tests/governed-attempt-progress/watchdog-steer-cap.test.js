/**
 * tests/governed-attempt-progress/watchdog-steer-cap.test.js
 *
 * M-013 SP-005 / VC-006b: Steer capped at 1 per attempt; idempotency-key required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tick, makeInitialState, STATES } = require('../../lib/governed-attempt-progress/watchdog');
const { getDefaultPolicy } = require('../../lib/governed-attempt-progress/policy-loader');
const { DIAGNOSTIC_CODES } = require('../../lib/governed-attempt-progress/notification');

const POLICY = getDefaultPolicy();
const NOW = '2026-08-11T10:00:00.000Z';

function attemptState(overrides = {}) {
  return {
    taskId: 'T-WD-003',
    attempt: 1,
    evidenceLevel: 'alive',
    lastActivityAt: '2026-08-11T09:50:00.000Z',
    lastProductiveAt: null,
    activity: { readOnlyToolCount: 0, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
    ...overrides,
  };
}

test('VC-006b: steer requires idempotency-key', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);

  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { reason: 'stale_progress' }, // missing idempotencyKey
  }, POLICY);
  const rejected = s.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.STEER_REJECTED);
  assert.ok(rejected, 'STEER_REJECTED must fire when idempotencyKey missing');
  assert.equal(rejected.detail.reason, 'missing_idempotency_key');
  assert.equal(s.state, STATES.NO_PROGRESS);
});

test('VC-006b: second steer attempt with different key → rejected (max 1 per attempt)', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);

  // First steer with key-1 → accepted → GRACE
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'key-1', reason: 'stale_progress' },
  }, POLICY);
  assert.equal(s.state, STATES.GRACE);
  assert.equal(s.steerCount, 1);

  // Try to steer again with key-2 → rejected (cap reached)
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'key-2', reason: 'second_try' },
  }, POLICY);
  const rejected = s.diagnostics.find(
    (d) => d.code === DIAGNOSTIC_CODES.STEER_REJECTED && d.detail.reason === 'max_steer_attempts_exceeded'
  );
  assert.ok(rejected, 'second steer with new key must be rejected');
  assert.equal(s.state, STATES.GRACE, 'rejected steer must NOT change state');
  assert.equal(s.steerCount, 1, 'steerCount must not increment on rejection');
});

test('VC-006b: same idempotency-key replay → no double-firing (idempotency conflict)', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);

  // First steer with key-1
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'key-1', reason: 'stale_progress' },
  }, POLICY);
  assert.equal(s.state, STATES.GRACE);
  const diagCountAfter1st = s.diagnostics.length;

  // Replay same key → idempotency conflict, no second STEER_ATTEMPTED
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'key-1', reason: 'replay' },
  }, POLICY);
  const conflict = s.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.STEER_IDEMPOTENCY_CONFLICT);
  assert.ok(conflict, 'idempotency conflict diagnostic must fire');
  assert.equal(s.diagnostics.length, diagCountAfter1st + 1, 'exactly one new diagnostic (conflict, not double-firing)');
  assert.equal(s.state, STATES.GRACE);
});

test('VC-006b: steer attempts are tracked with idempotency-key + timestamp', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'key-001', reason: 'stale_progress' },
  }, POLICY);

  assert.equal(s.steerAttempts.length, 1);
  const entry = s.steerAttempts[0];
  assert.equal(entry.idempotencyKey, 'key-001');
  assert.equal(entry.at, NOW);
  assert.equal(entry.reason, 'stale_progress');
  assert.ok(Object.isFrozen(entry), 'steerAttempts entry must be frozen');
});

test('VC-006b: policy with maxSteerAttempts=0 accepts no steer at all', () => {
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
  // First tick: provide steerAttempt along with no_progress detection
  // — attemptSteer rejects because maxSteerAttempts=0 reached immediately.
  s = tick(s, {
    now: NOW,
    attemptState: attemptState(),
    steerAttempt: { idempotencyKey: 'k-1', reason: 'try' },
  }, noSteerPolicy);
  assert.equal(s.steerCount, 0);
  const rejected = s.diagnostics.find(
    (d) => d.code === DIAGNOSTIC_CODES.STEER_REJECTED && d.detail.reason === 'max_steer_attempts_exceeded'
  );
  assert.ok(rejected, 'STEER_REJECTED with reason max_steer_attempts_exceeded expected');
});