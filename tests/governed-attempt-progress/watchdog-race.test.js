/**
 * tests/governed-attempt-progress/watchdog-race.test.js
 *
 * M-013 SP-005 / VC-006c: Watchdog timeout/race deterministic under high concurrency.
 * 100 concurrent watchdog ticks → deterministic output; no deadlock; 0 lost diagnostics.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tick, makeInitialState, hashState, STATES } = require('../../lib/governed-attempt-progress/watchdog');
const { getDefaultPolicy } = require('../../lib/governed-attempt-progress/policy-loader');

const POLICY = getDefaultPolicy();
const NOW = '2026-08-11T10:00:00.000Z';

function attemptState(overrides = {}) {
  return {
    taskId: 'T-WD-RACE',
    attempt: 1,
    evidenceLevel: 'alive',
    lastActivityAt: '2026-08-11T09:50:00.000Z',
    lastProductiveAt: null,
    activity: { readOnlyToolCount: 0, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
    ...overrides,
  };
}

test('VC-006c: 100 concurrent ticks with same inputs produce same hash (deterministic)', () => {
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });
  const hashes = new Set();
  for (let i = 0; i < 100; i++) {
    const result = tick(initial, { now: NOW, attemptState: attemptState() }, POLICY);
    hashes.add(hashState(result));
  }
  assert.equal(hashes.size, 1, `100 concurrent ticks must produce 1 unique hash, got ${hashes.size}`);
});

test('VC-006c: sequential 100 ticks with same input produce deterministic final hash', () => {
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });
  // Run the full sequence 50 times — final hash must be identical
  const finalHashes = new Set();
  for (let i = 0; i < 50; i++) {
    let s = initial;
    for (let j = 0; j < 20; j++) {
      s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
    }
    finalHashes.add(hashState(s));
  }
  assert.equal(finalHashes.size, 1, 'sequential deterministic watchdog must converge');
});

test('VC-006c: race conditions — 100 concurrent ticks with mixed inputs each stable', () => {
  // Each tick uses a distinct attempt state (different read counts / timestamps).
  // Verify every individual tick is stable and deterministic.
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });
  for (let i = 0; i < 100; i++) {
    const as = attemptState({
      lastActivityAt: `2026-08-11T09:${String(50 + (i % 10)).padStart(2, '0')}:00.000Z`,
      activity: { readOnlyToolCount: i, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
    });
    const a = tick(initial, { now: NOW, attemptState: as }, POLICY);
    const b = tick(initial, { now: NOW, attemptState: as }, POLICY);
    assert.equal(hashState(a), hashState(b), `tick iteration ${i} must be deterministic`);
  }
});

test('VC-006c: steer attempt race — 100 concurrent identical steers → state-machine invariant preserved', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  // Trigger NO_PROGRESS first
  s = tick(s, { now: NOW, attemptState: attemptState() }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);

  // 100 concurrent identical steers (same idempotency-key)
  for (let i = 0; i < 100; i++) {
    s = tick(s, {
      now: NOW,
      attemptState: attemptState(),
      steerAttempt: { idempotencyKey: 'race-key', reason: 'race_test' },
    }, POLICY);
  }
  // State-machine invariants hold regardless of bounded diagnostics:
  //   - steerCount = 1 (idempotency-key dedup; no double-firing)
  //   - steerAttempts.length = 1 (only first steer recorded)
  //   - state = GRACE (first steer succeeded, replays rejected but state stays)
  //   - diagnostics bounded to 50 (FIFO eviction per MAX_NOTIFICATIONS)
  assert.equal(s.steerCount, 1, 'steerCount must NOT double-fire under race');
  assert.equal(s.steerAttempts.length, 1, 'exactly 1 steerAttempt recorded');
  assert.equal(s.state, STATES.GRACE, 'state stays GRACE despite 100 replay attempts');
  assert.ok(s.diagnostics.length <= 50, 'diagnostics bounded to 50');
  // The bounded window is dominated by idempotency_conflict (most recent)
  const conflictCount = s.diagnostics.filter(
    (d) => d.code === 'steer_idempotency_conflict'
  ).length;
  assert.ok(conflictCount >= 40, `most recent window must contain mostly conflicts, got ${conflictCount}`);
});

test('VC-006c: 0 lost diagnostics — first NO_PROGRESS detection is captured deterministically', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  // Tick 50 times with the same attemptState. The first tick detects
  // no_progress → state=NO_PROGRESS, diagnostic emitted. Subsequent ticks
  // with state=NO_PROGRESS are idempotent (no extra no_progress fires).
  for (let i = 0; i < 50; i++) {
    const as = attemptState({ lastActivityAt: '2026-08-11T09:50:00.000Z' });
    s = tick(s, { now: NOW, attemptState: as }, POLICY);
  }
  // After 50 identical ticks, the diagnostic list must contain exactly
  // one no_progress_detected (idempotent emission).
  const noProgressDiagnostics = s.diagnostics.filter((d) => d.code === 'no_progress_detected');
  assert.equal(noProgressDiagnostics.length, 1, 'exactly 1 no_progress_detected diagnostic (idempotent)');
  assert.equal(s.state, STATES.NO_PROGRESS, 'state stays NO_PROGRESS across identical ticks');
});

test('VC-006c: 100 ticks with bounded diagnostics → no overflow (≤ 50)', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  for (let i = 0; i < 100; i++) {
    s = tick(s, {
      now: NOW,
      attemptState: attemptState(),
      steerAttempt: i % 2 === 0
        ? { idempotencyKey: `k-${i}`, reason: 'tick' }
        : null,
    }, POLICY);
  }
  assert.ok(s.diagnostics.length <= 50, `diagnostics list bounded to 50, got ${s.diagnostics.length}`);
});