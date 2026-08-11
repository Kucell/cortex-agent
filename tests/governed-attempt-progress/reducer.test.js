/**
 * tests/governed-attempt-progress/reducer.test.js
 *
 * M-013 SP-002 / VC-003: Worktree with no diff CANNOT upgrade to productive.
 * Only alive + active allowed when no worktree diff / artifact / validation.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reduce, makeInitialState } = require('../../lib/governed-attempt-progress/reducer');

test('reducer: initial state is alive (heartbeat only)', () => {
  const state = makeInitialState({
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  assert.equal(state.evidenceLevel, 'alive');
  assert.equal(state.lastProductiveAt, null);
});

test('reducer: heartbeat-only task stays alive (VC-001)', () => {
  const initial = makeInitialState({
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const next = reduce(initial, {
    heartbeat: { timestamp: '2026-08-11T03:00:01.000Z' }
  });
  assert.equal(next.evidenceLevel, 'alive');
});

test('reducer: read-only tool events promote to active, NOT productive (VC-003)', () => {
  const initial = makeInitialState({
    taskId: 't-001',
    operationId: 'op-001',
    launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const next = reduce(initial, {
    host_event: {
      timestamp: '2026-08-11T03:00:01.000Z',
      category: 'read',
      readOnly: true,
      success: true
    }
  });
  assert.equal(next.evidenceLevel, 'active');
  assert.equal(next.lastProductiveAt, null);
  assert.equal(next.worktree.changedFileCount, 0);
});

test('reducer: worktree diff WITHOUT validation → productive (not verified)', () => {
  const initial = makeInitialState({
    taskId: 't-001',
    operationId: 'op-001',
    launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const next = reduce(initial, {
    worktree_probe: {
      timestamp: '2026-08-11T03:00:01.000Z',
      statusDigest: 'sha256:aaa',
      diffDigest: 'sha256:bbb',
      changedFileCount: 3,
      insertions: 47,
      deletions: 12
    }
  });
  assert.equal(next.evidenceLevel, 'productive');
  assert.equal(next.worktree.changedFileCount, 3);
  assert.equal(next.worktree.insertions, 47);
});

test('reducer: worktree diff + validated → verified', () => {
  const initial = makeInitialState({
    taskId: 't-001',
    operationId: 'op-001',
    launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const next = reduce(initial, {
    worktree_probe: {
      timestamp: '2026-08-11T03:00:01.000Z',
      diffDigest: 'sha256:bbb',
      changedFileCount: 3
    },
    validation_probe: {
      timestamp: '2026-08-11T03:00:02.000Z',
      commandId: 'validate-001',
      status: 'passed'
    }
  });
  assert.equal(next.evidenceLevel, 'verified');
  assert.equal(next.validation.status, 'passed');
});

test('reducer: monotonic promotion — never regress from productive to alive', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const reached = reduce(initial, {
    worktree_probe: {
      timestamp: '2026-08-11T03:00:01.000Z',
      diffDigest: 'sha256:bbb',
      changedFileCount: 1
    }
  });
  assert.equal(reached.evidenceLevel, 'productive');

  // Now send only heartbeat — must stay productive
  const stayed = reduce(reached, {
    heartbeat: { timestamp: '2026-08-11T03:00:02.000Z' }
  });
  assert.equal(stayed.evidenceLevel, 'productive', 'monotonic promotion prevents downgrade');
});

test('reducer: failed tools transition to blocked phase', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const next = reduce(initial, {
    host_event: {
      timestamp: '2026-08-11T03:00:01.000Z',
      category: 'write',
      readOnly: false,
      success: false
    }
  });
  assert.equal(next.phase, 'blocked');
  assert.equal(next.activity.failedToolCount, 1);
  assert.ok(next.diagnostics.length > 0, 'blocked must have diagnostics');
});

test('reducer: diagnostics bounded to 50 entries', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  let state = initial;
  for (let i = 0; i < 60; i++) {
    state = reduce(state, {
      host_event: {
        timestamp: `2026-08-11T03:00:${String(i).padStart(2, '0')}.000Z`,
        category: 'write',
        readOnly: false,
        success: false
      }
    });
  }
  assert.ok(state.diagnostics.length <= 50, 'diagnostics must be capped at 50');
});

test('reducer: lastProductiveAt is set on first productive upgrade', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  assert.equal(initial.lastProductiveAt, null);
  const next = reduce(initial, {
    worktree_probe: {
      timestamp: '2026-08-11T03:00:01.000Z',
      diffDigest: 'sha256:bbb',
      changedFileCount: 1
    }
  });
  assert.ok(next.lastProductiveAt, 'lastProductiveAt must be set on productive');
});
