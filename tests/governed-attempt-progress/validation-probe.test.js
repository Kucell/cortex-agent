/**
 * tests/governed-attempt-progress/validation-probe.test.js
 *
 * M-013 SP-002 / VC-005: Test PASS/FAIL derived from structured receipt,
 * never natural language. Status enum: not_run | running | passed | failed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseValidationReceipt, mapStatus, classify } = require('../../lib/governed-attempt-progress/probes/validation');

test('mapStatus: exitCode 0 → passed', () => {
  assert.equal(mapStatus(0), 'passed');
});

test('mapStatus: non-zero exitCode → failed', () => {
  assert.equal(mapStatus(1), 'failed');
  assert.equal(mapStatus(2), 'failed');
  assert.equal(mapStatus(127), 'failed');
});

test('mapStatus: null/undefined → not_run', () => {
  assert.equal(mapStatus(null), 'not_run');
  assert.equal(mapStatus(undefined), 'not_run');
});

test('mapStatus: "running" string → running', () => {
  assert.equal(mapStatus('running'), 'running');
});

test('parseValidationReceipt: valid passed receipt', () => {
  const r = parseValidationReceipt({ status: 'passed', commandId: 'cmd-1', exitCode: 0 });
  assert.equal(r.status, 'passed');
  assert.equal(r.commandId, 'cmd-1');
  assert.equal(r.exitCode, 0);
});

test('parseValidationReceipt: valid failed receipt', () => {
  const r = parseValidationReceipt({ status: 'failed', commandId: 'cmd-1', exitCode: 1 });
  assert.equal(r.status, 'failed');
});

test('parseValidationReceipt: reject missing commandId', () => {
  assert.throws(() => parseValidationReceipt({ status: 'passed', exitCode: 0 }), /commandId/);
});

test('parseValidationReceipt: reject missing exitCode', () => {
  assert.throws(() => parseValidationReceipt({ status: 'passed', commandId: 'cmd-1' }), /exitCode/);
});

test('parseValidationReceipt: bounded fields only (no raw summary)', () => {
  const r = parseValidationReceipt({ status: 'passed', commandId: 'cmd-1', exitCode: 0 });
  // The probe must NOT carry raw stdout/stderr/free text forward.
  for (const forbidden of ['stdout', 'stderr', 'output', 'log', 'text', 'body', 'summary']) {
    assert.ok(!(forbidden in r), `receipt must not include raw field: ${forbidden}`);
  }
});

test('parseValidationReceipt: artifactRef → sha256 hashed', () => {
  const r = parseValidationReceipt({
    status: 'passed',
    commandId: 'cmd-1',
    exitCode: 0,
    artifactRef: '/Users/x/repo/lib/x.js',
  });
  // The probe must NOT expose absolute paths; only opaque sha256 digests.
  assert.match(r.evidenceRef, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(r.evidenceRef, '/Users/x/repo/lib/x.js');
});

test('parseValidationReceipt: handle status=running (long-running command)', () => {
  const r = parseValidationReceipt({ status: 'running', commandId: 'cmd-1', exitCode: null });
  assert.equal(r.status, 'running');
});

test('classify: status → evidence level', () => {
  assert.equal(classify('passed'), 'verified');
  assert.equal(classify('failed'), 'blocked');
  assert.equal(classify('running'), 'testing');
  assert.equal(classify('not_run'), 'alive');
});