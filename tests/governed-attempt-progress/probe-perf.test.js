/**
 * tests/governed-attempt-progress/probe-perf.test.js
 *
 * M-013 SP-002 / VC-005b: Git probe debounced — fast on common repo sizes.
 * Note: this is a smoke test, not strict perf gate; real perf depends on
 * repo size. Cache hit enables sub-1ms repeat calls.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { probeWorktree, clearCache } = require('../../lib/governed-attempt-progress/probes/worktree');

const REPO = path.resolve(__dirname, '..', '..'); // 主仓根

test('probe: first call returns success', () => {
  clearCache();
  const result = probeWorktree(REPO);
  assert.ok(result.head, 'probe must return head');
  assert.ok(result.statusDigest, 'probe must return statusDigest');
  assert.ok(result.diffDigest, 'probe must return diffDigest');
  assert.equal(typeof result.changedFileCount, 'number');
});

test('probe: cached repeat call returns same result', () => {
  clearCache();
  const first = probeWorktree(REPO);
  const second = probeWorktree(REPO); // cache hit
  assert.deepEqual(first, second);
});

test('probe: cache hit is fast (< 5ms)', () => {
  clearCache();
  probeWorktree(REPO); // warm cache
  const start = process.hrtime.bigint();
  probeWorktree(REPO);
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < 5, `cached probe should be < 5ms, got ${elapsed}ms`);
});

test('probe: never modifies index / files / branches', () => {
  clearCache();
  const before = require('node:child_process').execSync('git status --porcelain', { cwd: REPO, encoding: 'utf8' });
  probeWorktree(REPO);
  const after = require('node:child_process').execSync('git status --porcelain', { cwd: REPO, encoding: 'utf8' });
  assert.equal(before, after, 'probe must not modify working tree');
});

test('probe: 100 repeated calls have uniform results (cache deterministic)', () => {
  clearCache();
  probeWorktree(REPO);
  const first = JSON.stringify(probeWorktree(REPO));
  let allSame = true;
  for (let i = 0; i < 100; i++) {
    const next = JSON.stringify(probeWorktree(REPO));
    if (next !== first) {
      allSame = false;
      break;
    }
  }
  assert.ok(allSame, '100 cached calls must all return same result');
});
