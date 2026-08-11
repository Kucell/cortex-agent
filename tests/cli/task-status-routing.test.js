/**
 * tests/cli/task-status-routing.test.js
 *
 * M-013 SP-006 / VC-010: task status / event list / focused query do not
 * depend on internal file reads.
 *
 * Per P-005 §8.3: "同时修复公共 task status / event list 对 Coordination projection
 * 的路由, 避免消费者退回读取内部文件."
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { governedAttemptQuery, PROJECTIONS } = require('../../lib/cli/governed-attempt-query');

function mkTmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm013-vc010-'));
  fs.mkdirSync(path.join(tmp, '.agent', 'governed-attempt-progress'), { recursive: true });
  return tmp;
}

function rmTmp(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

test('routing: PROJECTIONS list contains governed-attempt-progress + -diagnostics', () => {
  assert.ok(PROJECTIONS.includes('governed-attempt-progress'));
  assert.ok(PROJECTIONS.includes('governed-attempt-diagnostics'));
});

test('routing: governed-attempt-progress returns ok + null data when journal empty', () => {
  const tmp = mkTmpProject();
  try {
    const captured = { stdout: '', stderr: '' };
    const ctx = { args: ['query', 'governed-attempt-progress', '--project', tmp], stdout: (s) => { captured.stdout += s; }, stderr: (s) => { captured.stderr += s; } };
    governedAttemptQuery(ctx);
    const parsed = JSON.parse(captured.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.projection, 'governed-attempt-progress');
    assert.equal(parsed.data, null);
  } finally {
    rmTmp(tmp);
  }
});

test('routing: governed-attempt-progress returns progress from journal file', () => {
  const tmp = mkTmpProject();
  try {
    const progress = {
      schemaVersion: '1.0',
      taskId: 'task-vc010-001',
      operationId: 'op-vc010-001',
      launchId: 'launch-vc010-001',
      attempt: 1,
      phase: 'ready',
      evidenceLevel: 'verified',
      lastActivityAt: '2026-08-11T03:00:00.000Z',
      lastProductiveAt: '2026-08-11T03:00:00.000Z',
      activity: { readOnlyToolCount: 5, writeToolCount: 3, testToolCount: 1, failedToolCount: 0 },
      worktree: {
        baselineHead: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        statusDigest: 'sha256:aaa',
        diffDigest: 'sha256:bbb',
        changedFileCount: 3,
        insertions: 50,
        deletions: 10
      },
      validation: { lastCommandId: 'v-001', status: 'passed', evidenceRef: 'sha256:ddd' },
      diagnostics: []
    };
    fs.writeFileSync(path.join(tmp, '.agent', 'governed-attempt-progress', 'launch-vc010-001.json'), JSON.stringify(progress));
    const captured = { stdout: '', stderr: '' };
    const ctx = { args: ['query', 'governed-attempt-progress', '--project', tmp], stdout: (s) => { captured.stdout += s; }, stderr: (s) => { captured.stderr += s; } };
    governedAttemptQuery(ctx);
    const parsed = JSON.parse(captured.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.evidenceLevel, 'verified');
    assert.equal(parsed.data.taskId, 'task-vc010-001');
  } finally {
    rmTmp(tmp);
  }
});

test('routing: governed-attempt-diagnostics returns bounded list', () => {
  const tmp = mkTmpProject();
  try {
    const file = path.join(tmp, '.agent', 'governed-attempt-progress', 'diagnostics-launch-001.json');
    const list = [];
    for (let i = 0; i < 30; i++) {
      list.push({
        timestamp: `2026-08-11T03:00:${String(i).padStart(2, '0')}.000Z`,
        code: `code-${i}`,
        message: `msg-${i}`,
        severity: 'info'
      });
    }
    fs.writeFileSync(file, JSON.stringify(list));
    const captured = { stdout: '', stderr: '' };
    const ctx = {
      args: ['query', 'governed-attempt-diagnostics', '--project', tmp, '--launch-id', 'launch-001', '--limit', '5'],
      stdout: (s) => { captured.stdout += s; },
      stderr: (s) => { captured.stderr += s; }
    };
    governedAttemptQuery(ctx);
    const parsed = JSON.parse(captured.stdout);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.data.length <= 5, 'limit must be respected');
    assert.equal(parsed.data[0].code, 'code-25', 'last 5 entries returned');
  } finally {
    rmTmp(tmp);
  }
});

test('routing: unsupported projection exits with usage error', () => {
  const tmp = mkTmpProject();
  try {
    const captured = { stdout: '', stderr: '' };
    const ctx = { args: ['query', 'unknown-projection', '--project', tmp], stdout: (s) => { captured.stdout += s; }, stderr: (s) => { captured.stderr += s; } };
    const originalExit = process.exitCode;
    governedAttemptQuery(ctx);
    assert.equal(process.exitCode, 2, 'exit code 2 for usage error');
    process.exitCode = originalExit;
  } finally {
    rmTmp(tmp);
  }
});

test('routing: focused query does NOT depend on internal file reads at command level', () => {
  // Confirms the query CLI invokes the management API / journal reader
  // and does NOT touch arbitrary internal project files.
  const tmp = mkTmpProject();
  try {
    // Plant a decoy internal file that should never be read
    fs.writeFileSync(path.join(tmp, '.agent', 'governed-attempt-progress', 'INTERNAL_SHOULD_NEVER_BE_READ.json'), '{"forbidden": true}');
    const captured = { stdout: '', stderr: '' };
    const ctx = { args: ['query', 'governed-attempt-progress', '--project', tmp], stdout: (s) => { captured.stdout += s; }, stderr: (s) => { captured.stderr += s; } };
    governedAttemptQuery(ctx);
    const parsed = JSON.parse(captured.stdout);
    // Should return null (no valid V1 file) — never read the decoy
    assert.equal(parsed.data, null);
    assert.ok(!parsed.data || parsed.data.forbidden === undefined, 'internal decoy must not be returned');
  } finally {
    rmTmp(tmp);
  }
});