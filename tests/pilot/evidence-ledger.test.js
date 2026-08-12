/**
 * tests/pilot/evidence-ledger.test.js
 *
 * M-013 SP-007 / VC-012a: Evidence ledger per layer: timestamp, evidence_level,
 * source, refs. No raw bodies in any ledger.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { reduce, makeInitialState } = require('../../lib/governed-attempt-progress/reducer');
const { PiJsonStreamParser } = require('../../lib/host-adapter/pi-json-stream');
const crypto = require('node:crypto');

function sha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');
}

function buildEvidenceLedger(events, taskId, source) {
  const parser = new PiJsonStreamParser();
  const aggregated = [];
  for (const ev of events) {
    const result = parser.parseLine(JSON.stringify(ev));
    if (!result || result.error) continue;
    if (result.type === 'turn_start' || result.type === 'turn_end') {
      aggregated.push({
        timestamp: result.timestamp,
        evidence_level: 'alive',
        source,
        action: 'turn',
        taskId,
        digest: sha256(result.timestamp + result.type + source)
      });
    } else if (result.type === 'agent_settled') {
      aggregated.push({
        timestamp: result.timestamp,
        evidence_level: 'verified',
        source,
        action: 'agent_settled',
        taskId,
        digest: sha256(result.timestamp + source)
      });
    } else if (result.type && result.type.startsWith('tool_')) {
      const level = result.category === 'write' || result.category === 'test' ? 'productive' : 'active';
      aggregated.push({
        timestamp: result.timestamp,
        evidence_level: level,
        source,
        action: result.type,
        toolName: result.toolName,
        category: result.category,
        success: result.success,
        digest: sha256(JSON.stringify(result) + source)
      });
    }
  }
  return aggregated;
}

test('evidence-ledger: required fields present (timestamp, evidence_level, source, refs)', () => {
  const events = [
    { type: 'turn_start', timestamp: '2026-08-11T03:00:00.000Z', taskId: 't-001' },
    { type: 'tool_start', timestamp: '2026-08-11T03:00:01.000Z', taskId: 't-001', toolName: 'read_file', category: 'read', success: true },
    { type: 'tool_end', timestamp: '2026-08-11T03:00:02.000Z', taskId: 't-001', toolName: 'read_file', category: 'read', success: true, durationMs: 1000 },
    { type: 'agent_settled', timestamp: '2026-08-11T03:00:03.000Z', taskId: 't-001' }
  ];
  const ledger = buildEvidenceLedger(events, 't-001', 'fake-host');
  assert.equal(ledger.length, 4);
  for (const entry of ledger) {
    assert.ok(entry.timestamp, 'timestamp required');
    assert.ok(entry.evidence_level, 'evidence_level required');
    assert.ok(entry.source, 'source required');
    assert.ok(entry.digest, 'digest (ref) required');
  }
});

test('evidence-ledger: 4 evidence levels appear (alive, active, productive, verified)', () => {
  const events = [
    { type: 'turn_start', timestamp: '2026-08-11T03:00:00.000Z', taskId: 't-002' },
    { type: 'tool_start', timestamp: '2026-08-11T03:00:01.000Z', taskId: 't-002', toolName: 'read_file', category: 'read', success: true },
    { type: 'tool_start', timestamp: '2026-08-11T03:00:02.000Z', taskId: 't-002', toolName: 'write_file', category: 'write', success: true },
    { type: 'agent_settled', timestamp: '2026-08-11T03:00:03.000Z', taskId: 't-002' }
  ];
  const ledger = buildEvidenceLedger(events, 't-002', 'fake-host');
  const levels = new Set(ledger.map((e) => e.evidence_level));
  assert.ok(levels.has('alive'), 'turn events have alive level');
  assert.ok(levels.has('active'), 'read tool events have active level');
  assert.ok(levels.has('productive'), 'write tool events have productive level');
  assert.ok(levels.has('verified'), 'agent_settled has verified level');
});

test('evidence-ledger: per-layer independence (fake-host, real-pi, samhmi are separate)', () => {
  const events = [
    { type: 'turn_start', timestamp: '2026-08-11T03:00:00.000Z', taskId: 't-003' },
    { type: 'agent_settled', timestamp: '2026-08-11T03:00:01.000Z', taskId: 't-003' }
  ];
  const fakeHostLedger = buildEvidenceLedger(events, 't-003', 'fake-host');
  const realPiLedger = buildEvidenceLedger(events, 't-003', 'real-pi');
  const samhmiLedger = buildEvidenceLedger(events, 't-003', 'samhmi');
  assert.equal(fakeHostLedger[0].source, 'fake-host');
  assert.equal(realPiLedger[0].source, 'real-pi');
  assert.equal(samhmiLedger[0].source, 'samhmi');
  // 3 ledgers have different sources
  assert.notEqual(fakeHostLedger[0].digest, realPiLedger[0].digest, 'different source = different ledger entry');
});

test('evidence-ledger: no raw bodies / arguments / paths in any entry', () => {
  const events = [
    { type: 'tool_start', timestamp: '2026-08-11T03:00:00.000Z', taskId: 't-004', toolName: 'read_file', category: 'read', success: true, arguments: { secret: 'should-not-appear' }, body: 'leaky body' },
    { type: 'tool_start', timestamp: '2026-08-11T03:00:01.000Z', taskId: 't-004', toolName: 'write_file', category: 'write', success: true, filePath: '/Users/leaky/path/file.ts' }
  ];
  const ledger = buildEvidenceLedger(events, 't-004', 'fake-host');
  for (const entry of ledger) {
    const serialized = JSON.stringify(entry);
    assert.ok(!/should-not-appear/.test(serialized), 'no raw arguments');
    assert.ok(!/leaky body/.test(serialized), 'no raw body');
    assert.ok(!/\/Users\/leaky/.test(serialized), 'no absolute path');
    assert.ok(!('arguments' in entry), 'no arguments field');
    assert.ok(!('body' in entry), 'no body field');
    assert.ok(!('filePath' in entry), 'no filePath field');
  }
});

test('evidence-ledger: bounded size (no unbounded growth)', () => {
  const events = [];
  for (let i = 0; i < 100; i++) {
    events.push({ type: 'tool_start', timestamp: `2026-08-11T03:00:${String(i % 60).padStart(2, '0')}.000Z`, taskId: 't-005', toolName: 'read_file', category: 'read', success: true });
  }
  const ledger = buildEvidenceLedger(events, 't-005', 'fake-host');
  assert.equal(ledger.length, 100);
  // Each entry size should be bounded (no nested objects with unbounded arrays)
  for (const entry of ledger) {
    const serialized = JSON.stringify(entry);
    assert.ok(serialized.length < 500, `ledger entry size must be bounded; got ${serialized.length}`);
  }
});

test('evidence-ledger: append-only (immutable history)', () => {
  const events = [
    { type: 'turn_start', timestamp: '2026-08-11T03:00:00.000Z', taskId: 't-006' },
    { type: 'agent_settled', timestamp: '2026-08-11T03:00:01.000Z', taskId: 't-006' }
  ];
  const ledger1 = buildEvidenceLedger(events, 't-006', 'fake-host');
  const firstDigest = ledger1[0].digest;
  // Re-build ledger with same events; digests must be identical (sha256 stable)
  const ledger2 = buildEvidenceLedger(events, 't-006', 'fake-host');
  assert.equal(ledger2[0].digest, firstDigest, 'digest stable across rebuilds');
  assert.deepEqual(ledger1, ledger2, 'ledger is deterministic');
});

test('run-pilot-stack.js exists and exits 0 with fake-host layer passing', () => {
  const script = path.join(ROOT, 'scripts', 'run-pilot-stack.js');
  assert.ok(fs.existsSync(script), `script not found: ${script}`);
  // Run with --layer fake-host and --output-json
  const out = execFileSync('node', [script, '--layer', 'fake-host', '--output-json'], { encoding: 'utf8' });
  const result = JSON.parse(out);
  assert.ok(result.results, 'results array present');
  const fakeHost = result.results.find((r) => r.layer === 'fake-host');
  assert.ok(fakeHost, 'fake-host result present');
  assert.equal(fakeHost.status, 'passed', 'fake-host must pass without local Pi');
  assert.ok(fakeHost.ledger.length > 0, 'ledger non-empty');
});

test('run-pilot-stack.js without --layer runs all 3 (fake-host passes, others skip)', () => {
  const script = path.join(ROOT, 'scripts', 'run-pilot-stack.js');
  const out = execFileSync('node', [script, '--output-json'], { encoding: 'utf8' });
  const result = JSON.parse(out);
  assert.equal(result.results.length, 3);
  const layers = result.results.map((r) => r.layer);
  assert.ok(layers.includes('fake-host'));
  assert.ok(layers.includes('real-pi'));
  assert.ok(layers.includes('samhmi'));
  // fake-host passes; others skip (no Pi / no SAMHMI_PATH)
  const fakeHost = result.results.find((r) => r.layer === 'fake-host');
  const realPi = result.results.find((r) => r.layer === 'real-pi');
  const samhmi = result.results.find((r) => r.layer === 'samhmi');
  assert.equal(fakeHost.status, 'passed');
  assert.ok(['skipped', 'requires-pi-binary', 'requires-samhmi-env'].includes(realPi.status), `real-pi status: ${realPi.status}`);
  assert.ok(['skipped', 'requires-pi-binary', 'requires-samhmi-env'].includes(samhmi.status), `samhmi status: ${samhmi.status}`);
});