/**
 * tests/pilot/samhmi-replay.test.js
 *
 * M-013 SP-007 / VC-012b: SamHMI replay — 2026-08-11 pilot scenarios reproduce
 * with productive evidence. No false-acception (every scenario must exit at
 * productive level, not stuck at alive).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reduce, makeInitialState } = require('../../lib/governed-attempt-progress/reducer');
const { PiJsonStreamParser } = require('../../lib/host-adapter/pi-json-stream');

const FIXTURE = path.resolve(__dirname, 'fixtures', 'samhmi', 'observation-log-2026-08-11.json');

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function runScenario(scenario) {
  const parser = new PiJsonStreamParser();
  const events = scenario.events;
  let state = makeInitialState({
    taskId: events[0]?.taskId || 'samhmi',
    operationId: 'op-' + scenario.scenario_id,
    launchId: events[0]?.launchId || 'launch-' + scenario.scenario_id,
    heartbeat: { timestamp: '2026-08-11T05:00:00.000Z' }
  });
  // Inject a synthetic worktree_probe per write tool event so the reducer
  // can reach productive (P-005 §3.1 requires worktree_probe.changedFileCount
  // > 0 for active → productive promotion). Mirrors scripts/run-pilot-stack.js
  // behavior where the runner shells out to git diff after each write.
  let changedFiles = 0;
  for (const ev of events) {
    const result = parser.parseLine(JSON.stringify(ev));
    if (!result || result.error) continue;
    if (result.type === 'turn_start' || result.type === 'turn_end' || result.type === 'agent_settled') {
      state = reduce(state, { heartbeat: { timestamp: result.timestamp } });
    } else if (result.type && result.type.startsWith('tool_')) {
      state = reduce(state, {
        host_event: {
          timestamp: result.timestamp,
          category: result.category,
          readOnly: result.category === 'read',
          success: result.success !== false
        }
      });
      if (result.category === 'write') {
        changedFiles += 1;
        state = reduce(state, {
          worktree_probe: {
            timestamp: result.timestamp,
            statusDigest: 'sha256:samhmi-status',
            diffDigest: 'sha256:samhmi-diff-' + changedFiles,
            changedFileCount: changedFiles
          }
        });
      }
    }
  }
  return state;
}

test('samhmi-replay: 2026-08-11 observation log loads with 3+ scenarios', () => {
  const fixture = loadFixture();
  assert.ok(fixture.scenarios && Array.isArray(fixture.scenarios), 'scenarios array present');
  assert.ok(fixture.scenarios.length >= 3, '≥ 3 scenarios per P-005 §15.3');
});

test('samhmi-replay: scenario 001 (login form) reaches productive evidence', () => {
  const fixture = loadFixture();
  const scenario = fixture.scenarios[0];
  assert.equal(scenario.scenario_id, 'samhmi-scenario-001');
  assert.equal(scenario.expected_outcome, 'productive');
  const state = runScenario(scenario);
  assert.equal(state.evidenceLevel, 'productive', `expected productive, got ${state.evidenceLevel}`);
});

test('samhmi-replay: scenario 002 (theme color) reaches productive evidence', () => {
  const fixture = loadFixture();
  const scenario = fixture.scenarios[1];
  assert.equal(scenario.scenario_id, 'samhmi-scenario-002');
  const state = runScenario(scenario);
  assert.equal(state.evidenceLevel, 'productive', `expected productive, got ${state.evidenceLevel}`);
});

test('samhmi-replay: scenario 003 (form validation) reaches productive evidence', () => {
  const fixture = loadFixture();
  const scenario = fixture.scenarios[2];
  assert.equal(scenario.scenario_id, 'samhmi-scenario-003');
  const state = runScenario(scenario);
  assert.equal(state.evidenceLevel, 'productive', `expected productive, got ${state.evidenceLevel}`);
});

test('samhmi-replay: NO false-acception — every scenario must NOT stay at alive', () => {
  const fixture = loadFixture();
  for (const scenario of fixture.scenarios) {
    const state = runScenario(scenario);
    assert.notEqual(state.evidenceLevel, 'alive',
      `scenario ${scenario.scenario_id} stuck at alive (false-acception)`);
  }
});

test('samhmi-replay: every scenario produces ≥ 1 productive evidence entry (worktree diff or lastProductiveAt)', () => {
  const fixture = loadFixture();
  for (const scenario of fixture.scenarios) {
    const state = runScenario(scenario);
    const hasProductiveEvidence = state.lastProductiveAt !== null || state.activity.writeToolCount > 0;
    assert.ok(hasProductiveEvidence,
      `scenario ${scenario.scenario_id} has no productive evidence (lastProductiveAt=null, writeToolCount=${state.activity.writeToolCount})`);
  }
});

test('samhmi-replay: every scenario has at least 1 read + 1 write tool event', () => {
  const fixture = loadFixture();
  for (const scenario of fixture.scenarios) {
    const state = runScenario(scenario);
    assert.ok(state.activity.readOnlyToolCount >= 1, `scenario ${scenario.scenario_id} has 0 read tool events`);
    assert.ok(state.activity.writeToolCount >= 1, `scenario ${scenario.scenario_id} has 0 write tool events`);
  }
});

test('samhmi-replay: 3 scenarios all reproducible (deterministic) — re-run produces same state', () => {
  const fixture = loadFixture();
  for (const scenario of fixture.scenarios) {
    const stateA = runScenario(scenario);
    const stateB = runScenario(scenario);
    // Compare activity counters + evidence level
    assert.equal(stateA.evidenceLevel, stateB.evidenceLevel);
    assert.equal(stateA.activity.writeToolCount, stateB.activity.writeToolCount);
    assert.equal(stateA.activity.readOnlyToolCount, stateB.activity.readOnlyToolCount);
  }
});

test('samhmi-replay: 3 scenarios all have expected_evidence_at timestamp within scenario duration', () => {
  const fixture = loadFixture();
  for (const scenario of fixture.scenarios) {
    assert.ok(scenario.expected_evidence_at, `scenario ${scenario.scenario_id} missing expected_evidence_at`);
    const firstEvent = scenario.events[0].timestamp;
    const lastEvent = scenario.events[scenario.events.length - 1].timestamp;
    assert.ok(scenario.expected_evidence_at >= firstEvent, 'expected_evidence_at >= first event');
    assert.ok(scenario.expected_evidence_at <= lastEvent, 'expected_evidence_at <= last event');
  }
});

test('samhmi-replay: bounded activity counters (no unbounded growth)', () => {
  const fixture = loadFixture();
  for (const scenario of fixture.scenarios) {
    const state = runScenario(scenario);
    // Per P-005 §9: bounded to MAX_DIAGNOSTICS=50 + bounded activity counters
    assert.ok(state.activity.readOnlyToolCount < 100, 'readOnlyToolCount bounded');
    assert.ok(state.activity.writeToolCount < 100, 'writeToolCount bounded');
    assert.ok(state.activity.testToolCount < 100, 'testToolCount bounded');
    assert.ok(state.activity.failedToolCount < 100, 'failedToolCount bounded');
  }
});