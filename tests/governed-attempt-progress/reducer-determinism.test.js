/**
 * tests/governed-attempt-progress/reducer-determinism.test.js
 *
 * M-013 SP-002 / VC-005a: Reducer is deterministic — identical inputs produce
 * identical outputs (sha256 stable across runs).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reduce, makeInitialState, hashState } = require('../../lib/governed-attempt-progress/reducer');

test('determinism: reduce 100 times with same inputs produces same hash', () => {
  const initial = makeInitialState({
    taskId: 't-determinism',
    operationId: 'op-determinism',
    launchId: 'launch-determinism',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });
  const events = {
    host_event: { timestamp: '2026-08-11T03:00:01.000Z', category: 'read', readOnly: true, success: true },
    worktree_probe: {
      timestamp: '2026-08-11T03:00:02.000Z',
      diffDigest: 'sha256:fixed-diff',
      changedFileCount: 3,
      insertions: 50,
      deletions: 10
    },
    validation_probe: {
      timestamp: '2026-08-11T03:00:03.000Z',
      commandId: 'v-001',
      status: 'passed'
    }
  };

  const hashes = new Set();
  for (let i = 0; i < 100; i++) {
    const next = reduce(initial, events);
    hashes.add(hashState(next));
  }

  assert.equal(hashes.size, 1, `expected 1 unique hash, got ${hashes.size}`);
});

test('determinism: sequential reduces over same events produce same final hash', () => {
  const initial = makeInitialState({
    taskId: 't-seq', operationId: 'op-seq', launchId: 'launch-seq',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });

  const events = [
    { host_event: { timestamp: '2026-08-11T03:00:01.000Z', category: 'read', readOnly: true, success: true } },
    { worktree_probe: { timestamp: '2026-08-11T03:00:02.000Z', diffDigest: 'sha256:d1', changedFileCount: 1 } },
    { validation_probe: { timestamp: '2026-08-11T03:00:03.000Z', commandId: 'v1', status: 'passed' } }
  ];

  // Run sequence 50 times
  const finalHashes = new Set();
  for (let i = 0; i < 50; i++) {
    let state = initial;
    for (const ev of events) {
      state = reduce(state, ev);
    }
    finalHashes.add(hashState(state));
  }
  assert.equal(finalHashes.size, 1, `sequential reducer must be deterministic, got ${finalHashes.size} unique hashes`);
});

test('determinism: randomized inputs produce reproducible hashes', () => {
  const initial = makeInitialState({
    taskId: 't-rand', operationId: 'op-rand', launchId: 'launch-rand',
    heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' }
  });

  const deterministicPairs = [];
  for (let i = 0; i < 20; i++) {
    const events = {
      host_event: {
        timestamp: '2026-08-11T03:00:01.000Z',
        category: i % 3 === 0 ? 'read' : i % 3 === 1 ? 'write' : 'test',
        readOnly: i % 3 === 0,
        success: true
      },
      worktree_probe: {
        timestamp: '2026-08-11T03:00:02.000Z',
        diffDigest: 'sha256:rand-' + (i % 2 ? 'a' : 'b'),
        changedFileCount: i
      }
    };
    const result = reduce(initial, events);
    deterministicPairs.push(hashState(result));
  }

  // Re-run and verify same hashes
  const reRun = [];
  for (let i = 0; i < 20; i++) {
    const events = {
      host_event: {
        timestamp: '2026-08-11T03:00:01.000Z',
        category: i % 3 === 0 ? 'read' : i % 3 === 1 ? 'write' : 'test',
        readOnly: i % 3 === 0,
        success: true
      },
      worktree_probe: {
        timestamp: '2026-08-11T03:00:02.000Z',
        diffDigest: 'sha256:rand-' + (i % 2 ? 'a' : 'b'),
        changedFileCount: i
      }
    };
    const result = reduce(initial, events);
    reRun.push(hashState(result));
  }

  assert.deepEqual(reRun, deterministicPairs, 'randomized inputs must produce reproducible hashes');
});

test('determinism: hash same input produces same hash', () => {
  const state = {
    schemaVersion: '1.0',
    taskId: 't-001',
    operationId: 'op-001',
    launchId: 'launch-001',
    attempt: 1,
    phase: 'editing',
    evidenceLevel: 'productive',
    lastActivityAt: '2026-08-11T03:00:00.000Z',
    lastProductiveAt: '2026-08-11T03:00:00.000Z',
    activity: { readOnlyToolCount: 5, writeToolCount: 3, testToolCount: 0, failedToolCount: 0 },
    worktree: {
      baselineHead: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      statusDigest: 'sha256:aaa',
      diffDigest: 'sha256:bbb',
      changedFileCount: 3,
      insertions: 50,
      deletions: 10
    },
    validation: { lastCommandId: null, status: 'not_run', evidenceRef: null },
    diagnostics: []
  };
  const h1 = hashState(state);
  const h2 = hashState(state);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // sha256 hex
});

test('determinism: different inputs produce different hashes', () => {
  const a = makeInitialState({ taskId: 'a', operationId: 'a', launchId: 'a', heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' } });
  const b = makeInitialState({ taskId: 'b', operationId: 'b', launchId: 'b', heartbeat: { timestamp: '2026-08-11T03:00:00.000Z' } });
  assert.notEqual(hashState(a), hashState(b));
});
