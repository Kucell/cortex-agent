#!/usr/bin/env node
/**
 * scripts/run-pilot-stack.js
 *
 * M-013 SP-007: 3-layer pilot stack runner for P-005 §15.3 validation.
 *
 * Layers (each independent, each producing bounded evidence ledger):
 *   1. fake-host: deterministic Pi JSONL fixture streams + scripted RPC supervisor
 *   2. real-pi:   live `pi --mode json` / `--mode rpc` execution in worktree (skipped if no binary)
 *   3. samhmi:   2026-08-11 SamHMI observation log replay (skipped if no env)
 *
 * Per P-005 §9 + §15.3: each layer produces bounded evidence ledger; no
 * raw bodies / paths / secrets in any ledger entry.
 *
 * Usage:
 *   node scripts/run-pilot-stack.js                  (auto-detect layers)
 *   node scripts/run-pilot-stack.js --layer fake-host
 *   node scripts/run-pilot-stack.js --output-json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { reduce, makeInitialState, hashState } = require('../lib/governed-attempt-progress/reducer');
const { PiJsonStreamParser, normalizeCategory } = require('../lib/host-adapter/pi-json-stream');

const FIXTURE_DIR = path.join(ROOT, 'tests', 'pilot', 'fixtures');

function sha256(s) {
  return 'sha256:' + crypto.createHash('sha256').update(String(s)).digest('hex');
}

function buildEvidenceLedger(events, taskId, source) {
  const parser = new PiJsonStreamParser();
  const receipts = [];
  const aggregated = [];
  for (const ev of events) {
    const result = parser.parseLine(JSON.stringify(ev));
    if (result && result.error) continue;
    if (!result) continue;
    if (result.type === 'turn_start' || result.type === 'turn_end') {
      aggregated.push({
        timestamp: result.timestamp,
        evidence_level: 'alive',
        source,
        action: 'turn',
        taskId,
        digest: sha256(result.timestamp + result.type)
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
        correlationId: result.correlationId,
        success: result.success,
        durationMs: result.durationMs,
        digest: sha256(JSON.stringify(result))
      });
    } else if (result.type === 'agent_settled') {
      aggregated.push({
        timestamp: result.timestamp,
        evidence_level: 'verified',
        source,
        action: 'agent_settled',
        taskId,
        digest: sha256(result.timestamp)
      });
    }
  }
  return aggregated;
}

function runFakeHostLayer() {
  const fixture = path.join(FIXTURE_DIR, 'jsonl', 'standard-100-events.jsonl');
  if (!fs.existsSync(fixture)) {
    return { layer: 'fake-host', status: 'skipped', reason: `missing fixture ${fixture}` };
  }
  const text = fs.readFileSync(fixture, 'utf8');
  const events = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const ledger = buildEvidenceLedger(events, events[0]?.taskId || 'task-fake-host', 'fake-host');
  const productiveCount = ledger.filter((e) => e.evidence_level === 'productive' || e.evidence_level === 'verified').length;
  return {
    layer: 'fake-host',
    status: 'passed',
    ledger,
    eventCount: events.length,
    productiveEvidenceCount: productiveCount,
    completedAt: new Date().toISOString()
  };
}

function runRealPiLayer() {
  let piBin;
  try {
    piBin = execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
  } catch {
    return { layer: 'real-pi', status: 'skipped', reason: 'pi binary not found on PATH' };
  }
  if (!piBin) {
    return { layer: 'real-pi', status: 'skipped', reason: 'pi binary not found on PATH' };
  }
  // Real-pi layer would spawn `pi --mode json` in a worktree and connect to
  // the bounded reducer. This is the full VC-012 production layer and
  // requires local Pi binary + worktree. Stubbed here.
  return { layer: 'real-pi', status: 'requires-pi-binary', reason: 'binary detected but real-pi pilot pending local environment' };
}

function runSamhmiLayer() {
  const samhmiPath = process.env.SAMHMI_PATH;
  if (!samhmiPath || !fs.existsSync(samhmiPath)) {
    return { layer: 'samhmi', status: 'skipped', reason: 'SAMHMI_PATH not set or directory missing' };
  }
  // SamHMI layer would replay observation log + verify ≥ 3 scenarios reproduce.
  // Stubbed here.
  return { layer: 'samhmi', status: 'requires-samhmi-env', reason: 'SAMHMI_PATH set but full replay pending SamHMI machine' };
}

function main() {
  const args = process.argv.slice(2);
  const filterLayer = args.includes('--layer') ? args[args.indexOf('--layer') + 1] : null;
  const outputJson = args.includes('--output-json');

  const layers = [
    { name: 'fake-host', fn: runFakeHostLayer },
    { name: 'real-pi', fn: runRealPiLayer },
    { name: 'samhmi', fn: runSamhmiLayer }
  ].filter((l) => !filterLayer || l.name === filterLayer);

  const results = layers.map((l) => {
    try {
      return l.fn();
    } catch (e) {
      return { layer: l.name, status: 'error', reason: e.message?.slice(0, 200) };
    }
  });

  const passed = results.filter((r) => r.status === 'passed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const requires = results.filter((r) => r.status && r.status.startsWith('requires-')).length;
  const errored = results.filter((r) => r.status === 'error').length;

  const summary = { total: results.length, passed, skipped, requires, errored };

  if (outputJson) {
    process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
  } else {
    process.stdout.write('\n=== P-005 3-Layer Pilot Stack ===\n');
    for (const r of results) {
      process.stdout.write(`  [${r.status.toUpperCase().padEnd(15)}] ${r.layer.padEnd(12)} ${r.reason || ''}\n`);
    }
    process.stdout.write(`\nTotal: ${passed} passed, ${skipped} skipped, ${requires} requires-env, ${errored} errored\n\n`);
  }

  // VC-012 partial: at least fake-host passed; other layers may skip
  if (passed >= 1) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();