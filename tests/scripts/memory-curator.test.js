'use strict';

// MS-3A — memory-curator skill CLI shell tests
// Validates the 3 declared subcommands (distill / list / inspect) + envelope shape + failure paths.
// Acceptance target: ≥ 6/6 PASS; we ship 8 cases.
//
// Test fixture layout: each test builds an isolated .agent/ + .agent/memory/ in a tmp dir
// and runs the CLI from that cwd.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', '..', 'templates', 'general', '.agent', 'skills', 'memory-curator', 'scripts', 'memory-curator.js');

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
  fs.mkdirSync(path.join(dir, '.agent', 'memory', 'episodic'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agent', 'memory', 'semantic'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agent', 'memory', 'procedural'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agent', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.agent', 'sessions'), { recursive: true });
  return dir;
}

function run(args, cwd) {
  const out = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

function runExit(args, cwd) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, body: JSON.parse(out) };
  } catch (e) {
    return { code: e.status || 1, body: e.stdout ? JSON.parse(e.stdout) : null };
  }
}

function rmTmp(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { console.log('  ✓ ' + name); passed++; }
  else { console.error('  ✗ ' + name); failed++; }
}

// ──────────────────────────────────────────────
console.log('memory-curator.test.js — MS-3A');

// Case 1: --help returns valid usage envelope
{
  const cwd = mkTmp();
  const r = run(['--help'], cwd);
  assert('--help → ok=true', r.ok === true);
  assert('--help → usage.distill present', typeof r.usage.distill === 'string');
  assert('--help → usage.list present', typeof r.usage.list === 'string');
  assert('--help → usage.inspect present', typeof r.usage.inspect === 'string');
  assert('--help → authoritative_subagent refs sub-agents/memory-curator.md',
    r.authoritative_subagent === 'sub-agents/memory-curator.md');
  rmTmp(cwd);
}

// Case 2: distill --dry-run prepares envelope + writes dry-run.json, no schema mutation
{
  const cwd = mkTmp();
  const r = run(['distill', '--source', 'sessions', '--max-records', '5', '--type', 'episodic,semantic', '--dry-run'], cwd);
  assert('distill --dry-run → ok=true', r.ok === true);
  assert('distill → action includes .prepared', r.action === 'memory-curator.distill.prepared');
  assert('distill → dry_run=true', r.dry_run === true);
  assert('distill → source_count >= 0', typeof r.source_count === 'number');
  assert('distill → types excludes procedural', !r.types.includes('procedural'));
  assert('distill → types includes episodic+semantic',
    r.types.includes('episodic') && r.types.includes('semantic'));
  const dryRunFile = path.join(cwd, '.agent', 'runs', r.run_id, 'dry-run.json');
  assert('distill → dry-run.json written', fs.existsSync(dryRunFile));
  // No memory dir written
  const episodicFiles = fs.readdirSync(path.join(cwd, '.agent', 'memory', 'episodic')).filter(f => f.endsWith('.md'));
  assert('distill dry-run → no episodic records written', episodicFiles.length === 0);
  rmTmp(cwd);
}

// Case 3: distill without --source fails with structured error
{
  const cwd = mkTmp();
  const r = runExit(['distill', '--type', 'episodic'], cwd);
  assert('distill no-source → exit != 0', r.code !== 0);
  assert('distill no-source → error=source_required', r.body && r.body.error === 'source_required');
  rmTmp(cwd);
}

// Case 4: distill with invalid source fails with structured error
{
  const cwd = mkTmp();
  const r = runExit(['distill', '--source', 'twitter', '--type', 'episodic'], cwd);
  assert('distill bad-source → exit != 0', r.code !== 0);
  assert('distill bad-source → error=invalid_source', r.body && r.body.error === 'invalid_source');
  rmTmp(cwd);
}

// Case 5: distill with bad type fails with structured error
{
  const cwd = mkTmp();
  const r = runExit(['distill', '--source', 'sessions', '--type', 'redis'], cwd);
  assert('distill bad-type → exit != 0', r.code !== 0);
  assert('distill bad-type → error=invalid_type', r.body && r.body.error === 'invalid_type');
  rmTmp(cwd);
}

// Case 6: list returns empty when no records exist
{
  const cwd = mkTmp();
  const r = run(['list'], cwd);
  assert('list empty → ok=true', r.ok === true);
  assert('list empty → count=0', r.count === 0);
  assert('list empty → entries=[]', Array.isArray(r.entries) && r.entries.length === 0);
  assert('list empty → types covers all 3', r.types.length === 3);
  rmTmp(cwd);
}

// Case 7: list picks up seeded records across all 3 types
{
  const cwd = mkTmp();
  fs.writeFileSync(path.join(cwd, '.agent', 'memory', 'episodic', 'M-E001.md'), '# E001');
  fs.writeFileSync(path.join(cwd, '.agent', 'memory', 'semantic', 'M-S001.md'), '# S001');
  fs.writeFileSync(path.join(cwd, '.agent', 'memory', 'procedural', 'M-P001.md'), '# P001');
  const r = run(['list'], cwd);
  assert('list seeded → count=3', r.count === 3);
  const ids = r.entries.map(e => e.id).sort();
  assert('list seeded → ids = [M-E001, M-P001, M-S001]',
    JSON.stringify(ids) === JSON.stringify(['M-E001', 'M-P001', 'M-S001']));
  rmTmp(cwd);
}

// Case 8: inspect missing → not_found; inspect seeded → returns body
{
  const cwd = mkTmp();
  fs.writeFileSync(path.join(cwd, '.agent', 'memory', 'episodic', 'M-E007.md'), '# E007 body\nseed');
  // Missing
  const miss = runExit(['inspect', '--memory-id', 'M-XXX'], cwd);
  assert('inspect missing → exit != 0', miss.code !== 0);
  assert('inspect missing → error=not_found', miss.body && miss.body.error === 'not_found');
  // Found
  const hit = run(['inspect', '--memory-id', 'M-E007'], cwd);
  assert('inspect found → ok=true', hit.ok === true);
  assert('inspect found → type=episodic', hit.type === 'episodic');
  assert('inspect found → body contains "seed"', hit.body.indexOf('seed') >= 0);
  // Bad id
  const bad = runExit(['inspect', '--memory-id', 'bad-id'], cwd);
  assert('inspect bad-id → error=invalid_memory_id', bad.body && bad.body.error === 'invalid_memory_id');
  rmTmp(cwd);
}

// ──────────────────────────────────────────────
console.log(`\n  passed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
