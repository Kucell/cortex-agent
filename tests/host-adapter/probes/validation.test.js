/**
 * tests/host-adapter/probes/validation.test.js
 *
 * M-013 SP-007 / VC-013: Unit tests for the validation probe receipt parser.
 * Source: lib/host-adapter/probes/validation.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseValidationReceipt } = require('../../../lib/host-adapter/probes/validation');

test('parseValidationReceipt: exitCode=0 → status=passed', () => {
  const parsed = parseValidationReceipt({
    commandId: 'validate-001',
    exitCode: 0,
    durationMs: 5000,
    artifactRef: 'sha256:abc',
    summary: 'all good'
  });
  assert.equal(parsed.status, 'passed');
  assert.equal(parsed.commandId, 'validate-001');
  assert.equal(parsed.evidenceRef, 'sha256:abc');
  assert.equal(parsed.durationMs, 5000);
  assert.equal(parsed.summary, 'all good');
});

test('parseValidationReceipt: exitCode=1 → status=failed', () => {
  const parsed = parseValidationReceipt({
    commandId: 'validate-002',
    exitCode: 1,
    durationMs: 1234,
    artifactRef: 'sha256:fail'
  });
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.commandId, 'validate-002');
  assert.equal(parsed.evidenceRef, 'sha256:fail');
});

test('parseValidationReceipt: exitCode missing → status=not_run', () => {
  const parsed = parseValidationReceipt({
    commandId: 'validate-003',
    durationMs: 0,
    artifactRef: null
  });
  assert.equal(parsed.status, 'not_run');
  assert.equal(parsed.commandId, 'validate-003');
  assert.equal(parsed.evidenceRef, null);
});

test('parseValidationReceipt: commandId trimmed and required', () => {
  const parsed = parseValidationReceipt({ commandId: '  validate-trim  ', exitCode: 0 });
  assert.equal(parsed.commandId, 'validate-trim');
  assert.throws(
    () => parseValidationReceipt({ exitCode: 0 }),
    /commandId is required/,
    'missing commandId throws'
  );
  assert.throws(
    () => parseValidationReceipt({ commandId: '', exitCode: 0 }),
    /commandId is required/,
    'empty commandId throws'
  );
  assert.throws(
    () => parseValidationReceipt({ commandId: '   ', exitCode: 0 }),
    /commandId is required/,
    'whitespace-only commandId throws'
  );
});

test('parseValidationReceipt: rejects null / non-object input', () => {
  assert.throws(() => parseValidationReceipt(null), /non-null object/);
  assert.throws(() => parseValidationReceipt(undefined), /non-null object/);
  assert.throws(() => parseValidationReceipt('not-an-object'), /non-null object/);
  assert.throws(() => parseValidationReceipt(42), /non-null object/);
});

test('parseValidationReceipt: durationMs defaults 0 and clamps negatives', () => {
  const a = parseValidationReceipt({ commandId: 'a', exitCode: 0 });
  assert.equal(a.durationMs, 0);

  const b = parseValidationReceipt({ commandId: 'b', exitCode: 0, durationMs: -500 });
  assert.equal(b.durationMs, 0, 'negative clamped to 0');

  const c = parseValidationReceipt({ commandId: 'c', exitCode: 0, durationMs: 3.7 });
  assert.equal(c.durationMs, 3, 'truncates fractional');
});

test('parseValidationReceipt: artifactRef trimmed; whitespace → null', () => {
  const a = parseValidationReceipt({ commandId: 'a', exitCode: 0, artifactRef: '  sha256:x  ' });
  assert.equal(a.evidenceRef, 'sha256:x');

  const b = parseValidationReceipt({ commandId: 'b', exitCode: 0, artifactRef: '   ' });
  assert.equal(b.evidenceRef, null, 'whitespace-only → null');

  const c = parseValidationReceipt({ commandId: 'c', exitCode: 0, artifactRef: '' });
  assert.equal(c.evidenceRef, null, 'empty → null');

  const d = parseValidationReceipt({ commandId: 'd', exitCode: 0 });
  assert.equal(d.evidenceRef, null, 'missing → null');
});

test('parseValidationReceipt: summary kept only when non-empty', () => {
  const a = parseValidationReceipt({ commandId: 'a', exitCode: 0, summary: 'hello' });
  assert.equal(a.summary, 'hello');

  const b = parseValidationReceipt({ commandId: 'b', exitCode: 0, summary: '   ' });
  assert.ok(!('summary' in b), 'whitespace summary dropped');

  const c = parseValidationReceipt({ commandId: 'c', exitCode: 0 });
  assert.ok(!('summary' in c), 'missing summary dropped');
});

test('parseValidationReceipt: capturedAt defaults to ISO now when missing', () => {
  const parsed = parseValidationReceipt({ commandId: 'a', exitCode: 0 });
  assert.ok(parsed.capturedAt, 'capturedAt present');
  assert.ok(!Number.isNaN(Date.parse(parsed.capturedAt)), 'capturedAt is parseable ISO');
});

test('parseValidationReceipt: capturedAt honored when provided', () => {
  const ts = '2026-08-11T03:00:00.000Z';
  const parsed = parseValidationReceipt({ commandId: 'a', exitCode: 0, capturedAt: ts });
  assert.equal(parsed.capturedAt, ts);
});

test('parseValidationReceipt: result is frozen (immutable)', () => {
  const parsed = parseValidationReceipt({ commandId: 'a', exitCode: 0 });
  assert.throws(() => { parsed.status = 'failed'; }, /Cannot assign|TypeError/);
  assert.throws(() => { parsed.commandId = 'changed'; }, /Cannot assign|TypeError/);
});

test('parseValidationReceipt: reducer-compatible shape (commandId/status/evidenceRef)', () => {
  // Verifies the field names match what reducer.js:94-99 reads.
  const parsed = parseValidationReceipt({
    commandId: 'vc-013',
    exitCode: 0,
    artifactRef: 'sha256:reducer-input'
  });
  assert.ok('commandId' in parsed);
  assert.ok('status' in parsed);
  assert.ok('evidenceRef' in parsed);
  assert.equal(parsed.commandId, 'vc-013');
  assert.equal(parsed.status, 'passed');
  assert.equal(parsed.evidenceRef, 'sha256:reducer-input');
});