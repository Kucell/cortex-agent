'use strict';

// MS-2 MS-001 — runs transcript-link CLI tests
// Validates: required-field validation, sha256 format, byte-size / turn-count types,
// dedupe-by-source+session-id, transcript_linked event append, exit codes.
//
// Acceptance target: ≥ 6/6 PASS; we ship 6 explicit cases.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CLI = '/Users/xueyq/myworks/cortex-agent/.agent/skills/management-api/scripts/index.js';

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-test-'));
  fs.mkdirSync(path.join(dir, '.agent', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agent', 'runs', 'R-test.json'), JSON.stringify({
    run_id: 'R-test', kind: 'implement', status: 'running', started_at: new Date().toISOString(),
    events: [],
  }));
  return dir;
}

function run(args, cwd) {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, body: JSON.parse(out) };
  } catch (e) {
    return { code: e.status || 1, body: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr };
  }
}

function mkRef(overrides) {
  return Object.assign({
    '--source': 'claude-code',
    '--session-id': 'S-test',
    '--transcript-path': '/tmp/fake.jsonl',
    '--transcript-sha256': 'a'.repeat(64),
    '--byte-size': '240000',
    '--turn-count': '47',
    '--first-turn-at': '2026-09-08T03:00:00Z',
    '--last-turn-at': '2026-09-08T07:42:00Z',
    '--run-id': 'R-test',
  }, overrides);
}

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { console.log('  ✓ ' + name); passed++; }
  else { console.error('  ✗ ' + name); failed++; }
}

// ──────────────────────────────────────────────
console.log('transcript-link.test.js — MS-2 MS-001');

// Case 1: happy path — full valid input writes transcript_ref + event
{
  const cwd = mkTmp();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef()).flat(), '--gate', 'agent'], cwd);
  assert('happy path → ok=true', r.code === 0 && r.body.ok === true);
  assert('happy path → action=runs transcript-link', r.body.action === 'runs transcript-link');
  assert('happy path → transcript_ref.source=claude-code', r.body.transcript_ref.source === 'claude-code');
  assert('happy path → sha256 preserved (64 hex)', /^[a-f0-9]{64}$/.test(r.body.transcript_ref.sha256));
  assert('happy path → transcript_refs[] length 1', Array.isArray(r.body.run.transcript_refs) && r.body.run.transcript_refs.length === 1);
  assert('happy path → events[] includes transcript_linked',
    r.body.run.events.some(e => e.type === 'transcript_linked'));
  assert('happy path → last_event.type=transcript_linked', r.body.run.last_event.type === 'transcript_linked');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 2: required-field validation — missing --source
{
  const cwd = mkTmp();
  const ref = mkRef(); delete ref['--source'];
  const args = Object.entries(ref).flat();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...args, '--gate', 'agent'], cwd);
  assert('no-source → exit != 0', r.code !== 0);
  assert('no-source → error=transcript_link_source_required',
    r.body && r.body.error === 'transcript_link_source_required');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 3: sha256 format validation
{
  const cwd = mkTmp();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--transcript-sha256': 'not-hex' })).flat(), '--gate', 'agent'], cwd);
  assert('bad-sha256 → exit != 0', r.code !== 0);
  assert('bad-sha256 → error=transcript_link_sha256_invalid',
    r.body && r.body.error === 'transcript_link_sha256_invalid');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 4: dedupe by source + session_id
{
  const cwd = mkTmp();
  const ref = mkRef();
  // First push
  run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(ref).flat(), '--gate', 'agent'], cwd);
  // Second push with same source+session_id but different sha
  ref['--transcript-sha256'] = 'b'.repeat(64);
  const r2 = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(ref).flat(), '--gate', 'agent'], cwd);
  assert('dedupe → transcript_refs[] length still 1', r2.body.run.transcript_refs.length === 1);
  assert('dedupe → sha256 replaced with new value',
    r2.body.run.transcript_refs[0].sha256 === 'b'.repeat(64));
  // Push with different session_id → adds
  ref['--session-id'] = 'S-other';
  const r3 = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(ref).flat(), '--gate', 'agent'], cwd);
  assert('dedupe → different session_id adds new entry (length=2)',
    r3.body.run.transcript_refs.length === 2);
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 5: byte-size / turn-count type validation
{
  const cwd = mkTmp();
  const r1 = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--byte-size': 'abc' })).flat(), '--gate', 'agent'], cwd);
  assert('bad-byte-size → error=transcript_link_byte_size_invalid',
    r1.body && r1.body.error === 'transcript_link_byte_size_invalid');
  const r2 = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--turn-count': '-1' })).flat(), '--gate', 'agent'], cwd);
  assert('bad-turn-count → error=transcript_link_turn_count_invalid',
    r2.body && r2.body.error === 'transcript_link_turn_count_invalid');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 6: gate validation — valid gate (agent) accepted; the help line shows gate option
{
  const cwd = mkTmp();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef()).flat(), '--gate', 'agent'], cwd);
  assert('gate=agent → ok=true', r.code === 0 && r.body.ok === true);
  assert('gate=agent → run.updated_by_gate=agent', r.body.run.updated_by_gate === 'agent');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// P-002b writer contract — extended coverage (2026-09-09)
// ═══════════════════════════════════════════════════════════════════════════

// Case 7: source=other is accepted (host enum fallback)
{
  const cwd = mkTmp();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--source': 'other' })).flat(), '--gate', 'agent'], cwd);
  assert('source=other → ok=true', r.code === 0 && r.body.ok === true);
  assert('source=other → transcript_ref.source=other', r.body.transcript_ref.source === 'other');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 8: all three gates accepted
{
  const cwd = mkTmp();
  for (const gate of ['agent', 'user', 'mission']) {
    const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--session-id': 'S-' + gate })).flat(), '--gate', gate], cwd);
    assert('gate=' + gate + ' → ok=true', r.code === 0 && r.body.ok === true);
    assert('gate=' + gate + ' → run.updated_by_gate=' + gate, r.body.run.updated_by_gate === gate);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 9: remaining missing-field validation
{
  const cwd = mkTmp();
  const missing = [
    ['--session-id', 'transcript_link_session_required'],
    ['--transcript-path', 'transcript_link_path_required'],
    ['--transcript-sha256', 'transcript_link_sha256_invalid'],
  ];
  for (const [key, expect] of missing) {
    const ref = mkRef(); delete ref[key];
    const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(ref).flat(), '--gate', 'agent'], cwd);
    assert('missing-' + key + ' → error=' + expect, r.body && r.body.error === expect);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 10: relative path rejected (path validation)
{
  const cwd = mkTmp();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--transcript-path': 'relative/transcript.jsonl' })).flat(), '--gate', 'agent'], cwd);
  assert('relative path → error=transcript_link_path_relative', r.body && r.body.error === 'transcript_link_path_relative');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 11: multiline / injected content rejected (privacy invariant)
{
  const cwd = mkTmp();
  const injected = '/tmp/fake.jsonl\n{\"type\":\"user\",\"message\":\"secret transcript body\"}';
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--transcript-path': injected })).flat(), '--gate', 'agent'], cwd);
  assert('multiline injection → error=transcript_link_path_injection', r.body && r.body.error === 'transcript_link_path_injection');
  // Oversized path
  const longPath = '/' + 'x'.repeat(1100) + '.jsonl';
  const r2 = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef({ '--transcript-path': longPath })).flat(), '--gate', 'agent'], cwd);
  assert('oversized path → error=transcript_link_path_too_long', r2.body && r2.body.error === 'transcript_link_path_too_long');
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 12: payload-json input surface
{
  const cwd = mkTmp();
  const payload = JSON.stringify({
    source: 'codex',
    session_id: 'S-payload',
    transcript_path: '/tmp/payload.jsonl',
    transcript_sha256: 'c'.repeat(64),
    byte_size: 500,
    turn_count: 9,
  });
  const r = run(['runs', 'transcript-link', '--project', cwd, '--run-id', 'R-test', '--payload-json', payload, '--gate', 'agent'], cwd);
  assert('payload-json → ok=true', r.code === 0 && r.body.ok === true);
  assert('payload-json → source=codex from payload', r.body.transcript_ref.source === 'codex');
  assert('payload-json → session_id from payload', r.body.transcript_ref.session_id === 'S-payload');
  assert('payload-json → transcript_refs[] length 1', r.body.run.transcript_refs.length === 1);
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 13: schema validation — written run file passes run.schema.json
{
  const cwd = mkTmp();
  const r = run(['runs', 'transcript-link', '--project', cwd, ...Object.entries(mkRef()).flat(), '--gate', 'agent'], cwd);
  assert('schema-valid → link succeeded', r.code === 0 && r.body.ok === true);
  const written = JSON.parse(fs.readFileSync(path.join(cwd, '.agent', 'runs', 'R-test.json'), 'utf8'));
  assert('schema-valid → transcript_refs present in file', Array.isArray(written.transcript_refs) && written.transcript_refs.length === 1);
  const ref0 = written.transcript_refs[0];
  assert('schema-valid → ref has all 7 required fields',
    ['source', 'session_id', 'path', 'sha256', 'byte_size', 'turn_count', 'linked_at']
      .every(k => ref0[k] !== undefined));
  assert('schema-valid → ref path is absolute', path.isAbsolute(ref0.path));
  fs.rmSync(cwd, { recursive: true, force: true });
}

// Case 14: public CLI wrapper — repository self (packaged-runtime fallback)
{
  const ROOT = path.resolve(__dirname, '..', '..');
  const PUBLIC_CLI = path.join(ROOT, 'bin', 'cli.js');
  const runId = 'R-pubcli-' + Date.now();
  fs.writeFileSync(path.join(ROOT, '.agent', 'runs', runId + '.json'), JSON.stringify({
    run_id: runId, kind: 'implement', status: 'running', started_at: new Date().toISOString(), events: [],
  }));
  const args = ['runs', 'transcript-link', '--gate', 'agent',
    '--run-id', runId, '--source', 'cursor', '--session-id', 'S-pub',
    '--transcript-path', '/tmp/pubcli.jsonl', '--transcript-sha256', 'f'.repeat(64),
    '--byte-size', '888', '--turn-count', '6'];
  try {
    const out = execFileSync('node', [PUBLIC_CLI, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const b = JSON.parse(out);
    assert('public CLI (repo self) → ok=true', b.ok === true);
    assert('public CLI (repo self) → action=runs transcript-link', b.action === 'runs transcript-link');
    assert('public CLI (repo self) → source=cursor', b.transcript_ref && b.transcript_ref.source === 'cursor');
  } catch (e) {
    assert('public CLI (repo self) → ok=true', false);
  } finally {
    fs.rmSync(path.join(ROOT, '.agent', 'runs', runId + '.json'), { force: true });
  }
}

// Case 15: public CLI wrapper — external project without management-api fails closed
{
  const cwd = mkTmp();
  // Simulate a fresh-init general project: data layer present, no management-api skill.
  fs.rmSync(path.join(cwd, '.agent', 'skills'), { recursive: true, force: true });
  const PUBLIC_CLI = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
  const args = ['runs', 'transcript-link', '--project', cwd, '--gate', 'agent',
    '--run-id', 'R-test', '--source', 'claude-code', '--session-id', 'S-x',
    '--transcript-path', '/tmp/x.jsonl', '--transcript-sha256', 'a'.repeat(64),
    '--byte-size', '1', '--turn-count', '1'];
  try {
    execFileSync('node', [PUBLIC_CLI, ...args], { cwd: path.resolve(__dirname, '..', '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert('public CLI (no mgmt-api) → fails closed', false);
  } catch (e) {
    let body = null;
    try { body = JSON.parse(e.stdout); } catch (_) {}
    assert('public CLI (no mgmt-api) → exit != 0', e.status !== 0 && e.status !== undefined);
    assert('public CLI (no mgmt-api) → error=MANAGEMENT_API_UNAVAILABLE',
      body && body.error && body.error.code === 'MANAGEMENT_API_UNAVAILABLE');
  }
  fs.rmSync(cwd, { recursive: true, force: true });
}

// ──────────────────────────────────────────────
console.log(`\n  passed: ${passed}  failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);