/**
 * tests/governed-attempt-progress/watchdog.test.js
 *
 * M-013 SP-005 / VC-006: 8 read-only actions or 10 min no productive →
 * versioned diagnostic. Default policy fires no_progress_detected.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tick, makeInitialState, STATES } = require('../../lib/governed-attempt-progress/watchdog');
const { getDefaultPolicy } = require('../../lib/governed-attempt-progress/policy-loader');
const { DIAGNOSTIC_CODES } = require('../../lib/governed-attempt-progress/notification');

const POLICY = getDefaultPolicy();
const NOW = '2026-08-11T10:00:00.000Z';
const T1 = '2026-08-11T10:01:00.000Z'; // +1 min
const T10M = '2026-08-11T10:10:00.000Z'; // +10 min

function attemptState(overrides = {}) {
  return {
    taskId: 'T-WD-001',
    attempt: 1,
    evidenceLevel: 'alive',
    lastActivityAt: NOW,
    lastProductiveAt: null,
    activity: {
      readOnlyToolCount: 0,
      writeToolCount: 0,
      testToolCount: 0,
      failedToolCount: 0,
    },
    ...overrides,
  };
}

test('VC-006: 8 consecutive read-only actions trigger no_progress_detected', () => {
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });

  // Cycle 1: 7 reads — should stay OBSERVING
  let s = tick(initial, {
    now: NOW,
    attemptState: attemptState({ activity: { readOnlyToolCount: 7, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 } }),
  }, POLICY);
  assert.equal(s.state, STATES.OBSERVING);

  // Cycle 2: 8 reads — should fire no_progress_detected → NO_PROGRESS
  s = tick(s, {
    now: T1,
    attemptState: attemptState({
      activity: { readOnlyToolCount: 8, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
      lastActivityAt: T1,
    }),
  }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);
  const diag = s.diagnostics[s.diagnostics.length - 1];
  assert.equal(diag.code, DIAGNOSTIC_CODES.NO_PROGRESS_DETECTED);
  assert.equal(diag.detail.reason, 'excessive_read_only');
});

test('VC-006: 10 min no productive evidence triggers no_progress_detected', () => {
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });
  // Setup: never reached productive, lastActivityAt 10 min ago
  const tenMinAgo = '2026-08-11T09:50:00.000Z';
  let s = tick(initial, {
    now: NOW,
    attemptState: attemptState({
      lastActivityAt: tenMinAgo,
      lastProductiveAt: null,
      activity: { readOnlyToolCount: 0, writeToolCount: 0, testToolCount: 0, failedToolCount: 0 },
    }),
  }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);
  assert.equal(s.diagnostics[0].detail.reason, 'no_productive_ever');
});

test('VC-006: productive evidence resets no-progress window', () => {
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });
  // Reach productive
  let s = tick(initial, {
    now: NOW,
    attemptState: attemptState({
      evidenceLevel: 'productive',
      lastProductiveAt: NOW,
      lastActivityAt: NOW,
      worktree: { changedFileCount: 1 },
    }),
  }, POLICY);
  assert.equal(s.state, STATES.OBSERVING);

  // 9 min later: still observing (within 10 min window)
  s = tick(s, {
    now: '2026-08-11T10:09:00.000Z',
    attemptState: attemptState({
      evidenceLevel: 'productive',
      lastProductiveAt: NOW,
      lastActivityAt: NOW,
    }),
  }, POLICY);
  assert.equal(s.state, STATES.OBSERVING);

  // 11 min later: no-progress triggered
  s = tick(s, {
    now: '2026-08-11T10:11:00.000Z',
    attemptState: attemptState({
      evidenceLevel: 'productive',
      lastProductiveAt: NOW,
      lastActivityAt: NOW,
    }),
  }, POLICY);
  assert.equal(s.state, STATES.NO_PROGRESS);
  assert.equal(s.diagnostics[s.diagnostics.length - 1].detail.reason, 'no_productive_timeout');
});

test('VC-006: heartbeat_lost fires when lastActivityAt is too old', () => {
  const initial = makeInitialState(POLICY, { attemptState: attemptState() });
  const ninetyOneSecAgo = '2026-08-11T09:58:29.000Z';
  const s = tick(initial, {
    now: NOW,
    attemptState: attemptState({ lastActivityAt: ninetyOneSecAgo }),
  }, POLICY);
  // Heartbeat lost but state stays OBSERVING (no_progress not yet triggered)
  assert.equal(s.state, STATES.OBSERVING);
  const heartbeat = s.diagnostics.find((d) => d.code === DIAGNOSTIC_CODES.HEARTBEAT_LOST);
  assert.ok(heartbeat, 'heartbeat_lost diagnostic must be present');
  assert.ok(heartbeat.detail.msSinceLastActivity >= 90000);
});

test('VC-006: diagnostics list bounded to 50 entries', () => {
  let s = makeInitialState(POLICY, { attemptState: attemptState() });
  for (let i = 0; i < 60; i++) {
    s = tick(s, {
      now: `2026-08-11T10:${String(i).padStart(2, '0')}:00.000Z`,
      attemptState: attemptState({
        lastActivityAt: `2026-08-11T10:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    }, POLICY);
  }
  assert.ok(s.diagnostics.length <= 50, `diagnostics must be capped at 50, got ${s.diagnostics.length}`);
});