/**
 * tests/governed-attempt-progress/reducer-promotion.test.js
 *
 * M-013 SP-002 / VC-004: New diff or artifact triggers productive upgrade
 * within one sampling cycle.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reduce, makeInitialState } = require('../../lib/governed-attempt-progress/reducer');

test('promotion: alive → active (single host_event)', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
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
});

test('promotion: active → productive (worktree diff arrives)', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const active = reduce(initial, {
    host_event: {
      timestamp: '2026-08-11T03:00:01.000Z',
      category: 'read',
      readOnly: true,
      success: true
    }
  });
  assert.equal(active.evidenceLevel, 'active');

  const productive = reduce(active, {
    worktree_probe: {
      timestamp: '2026-08-11T03:00:02.000Z',
      diffDigest: 'sha256:diff-fresh',
      changedFileCount: 5,
      insertions: 100,
      deletions: 20
    }
  });
  assert.equal(productive.evidenceLevel, 'productive');
  assert.ok(productive.lastProductiveAt);
});

test('promotion: productive → verified (validation passed)', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const productive = reduce(initial, {
    worktree_probe: {
      timestamp: '2026-08-11T03:00:01.000Z',
      diffDigest: 'sha256:diff',
      changedFileCount: 3
    }
  });
  assert.equal(productive.evidenceLevel, 'productive');

  const verified = reduce(productive, {
    validation_probe: {
      timestamp: '2026-08-11T03:00:02.000Z',
      commandId: 'cmd-001',
      status: 'passed'
    }
  });
  assert.equal(verified.evidenceLevel, 'verified');
});

test('promotion: validation alone (artifact = receipt) → productive', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const next = reduce(initial, {
    validation_probe: {
      timestamp: '2026-08-11T03:00:01.000Z',
      commandId: 'cmd-001',
      status: 'passed'
    }
  });
  // validation passed with artifact counting as evidence → productive
  assert.equal(next.evidenceLevel, 'productive');
});

test('promotion: failed validation stays at active (no productive upgrade)', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const active = reduce(initial, {
    host_event: {
      timestamp: '2026-08-11T03:00:01.000Z',
      category: 'read',
      readOnly: true,
      success: true
    }
  });
  const stillActive = reduce(active, {
    validation_probe: {
      timestamp: '2026-08-11T03:00:02.000Z',
      commandId: 'cmd-001',
      status: 'failed'
    }
  });
  assert.equal(stillActive.evidenceLevel, 'active');
});

test('promotion: 4 evidence levels progression in single cycle', () => {
  const initial = makeInitialState({
    taskId: 't-001', operationId: 'op-001', launchId: 'launch-001',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  // alive → active → productive → verified (3 sequential reduces)
  let s = initial;
  assert.equal(s.evidenceLevel, 'alive');

  s = reduce(s, {
    host_event: { timestamp: '2026-08-11T03:00:01.000Z', category: 'read', readOnly: true, success: true }
  });
  assert.equal(s.evidenceLevel, 'active');

  s = reduce(s, {
    worktree_probe: { timestamp: '2026-08-11T03:00:02.000Z', diffDigest: 'sha256:x', changedFileCount: 1 }
  });
  assert.equal(s.evidenceLevel, 'productive');

  s = reduce(s, {
    validation_probe: { timestamp: '2026-08-11T03:00:03.000Z', commandId: 'v-001', status: 'passed' }
  });
  assert.equal(s.evidenceLevel, 'verified');
});
