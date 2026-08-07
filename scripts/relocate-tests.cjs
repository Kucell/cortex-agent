'use strict';
// Reorganize tests/ root files into subdirectories.
//
// For each move we:
//   1. git mv the file into tests/<sub>/
//   2. Re-relativize every relative require(): resolve the true absolute target
//      (stripping a leading "../" until it resolves on disk — handles the broken
//      "extra .." depth left by the previous partial revert), then recompute the
//      relative path from the NEW (deeper) location.
//   3. Upgrade every `path.{resolve,join}(__dirname, ".."` so the project root
//      still resolves correctly (the file is now one level deeper).
//
// Pure path math + existence checks => idempotent and safe.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');

// src (basename at tests/ root) -> dest subdir (relative to tests/)
const MAP = {
  '_base-extraction.test.js': 'template',
  'archive-missions.test.js': 'workflow',
  'attempt-disposition.test.js': 'attempt',
  'capability-aware-dispatch.test.js': 'runtime-adapters',
  'cli-contract.test.js': 'cli',
  'communication-runtime.test.js': 'communication',
  'communication-template-parity.test.js': 'communication',
  'communication-workflow-contract.test.js': 'communication',
  'consumer-registry.test.js': 'event-bus',
  'context-budget.test.js': 'context',
  'context-trajectory.test.js': 'runtime-adapters',
  'cross-host-handoff.test.js': 'runtime-adapters',
  'cross-repo-workspace.test.js': 'cross-project',
  'dev-cli.test.js': 'dev',
  'execution-surface-matcher.test.js': 'runtime-adapters',
  'github-repo-research.test.js': 'knowledge-retrieval',
  'host-adapter-protocol-v1.test.js': 'runtime-adapters',
  'host-event-bridge.test.js': 'coordination',
  'lease-command.test.js': 'coordination',
  'local-host-binding.test.js': 'coordination',
  'm002-e2e-matrix.test.js': 'agent',
  'natural-language-approval.test.js': 'coordination',
  'operation-lifecycle.test.js': 'runtime-state',
  'parallel-isolation.test.js': 'runtime-state',
  'pi-runtime-adapter.test.js': 'runtime-adapters',
  'runtime-continuity.test.js': 'runtime-state',
  'runtime-event-contract.test.js': 'event-bus',
  'runtime-tool-gate.test.js': 'runtime-adapters',
  'secrets-skill-backend.test.js': 'secrets',
  'skill-dispatch-quad-layer.test.js': 'dispatch',
  'task-pipeline.test.js': 'coordination',
  'weekly-activity-contract.test.js': 'activity-recording',
};

function existsCands(p) {
  return [p, p + '.js', p + '.json', p + '.cjs',
    path.join(p, 'index.js'), path.join(p, 'index.json'), path.join(p, 'index.cjs')];
}
function resolveExists(p) {
  for (const c of existsCands(p)) if (fs.existsSync(c)) return c;
  return null;
}
// Resolve a relative require string to its true absolute path, tolerating an
// extra leading "../" (the broken depth from the partial revert).
function resolveTrue(baseDir, target) {
  let cur = target;
  for (let i = 0; i < 4; i++) {
    const abs = path.resolve(baseDir, cur);
    const found = resolveExists(abs);
    if (found) return found;
    if (cur.startsWith('../')) cur = cur.slice(3);
    else break;
  }
  return null;
}

const REQUIRE_RE = /require\(\s*(["'])([^"']+)\1\s*\)/g;
// Bare root-computing form: path.{resolve,join}(__dirname, "..")  -> add ".."
// Group 1 INCLUDES the closing ")" so the replacement keeps it.
const DIRNAME_BARE_RE = /(path\.(?:resolve|join)\(\s*__dirname\s*,\s*["']\.\.["']\s*\))/g;
// Multi-arg form starting with "..": path.{resolve,join}(__dirname, "..", X) -> add ".."
// Negative lookahead keeps it idempotent (won't re-add when already "..", "..").
const DIRNAME_MULTI_RE = /(path\.(?:resolve|join)\(\s*__dirname\s*,\s*["']\.\.["']\s*,\s*)(?!["']\.\.["'])/g;

let moved = 0;
for (const [base, sub] of Object.entries(MAP)) {
  const src = path.join(TESTS, base);
  const destDir = path.join(TESTS, sub);
  const dest = path.join(destDir, base);
  if (!fs.existsSync(src)) { console.log(`SKIP (missing): ${base}`); continue; }
  if (fs.existsSync(dest)) { console.log(`SKIP (dest exists): ${base} -> ${sub}`); continue; }

  fs.mkdirSync(destDir, { recursive: true });
  execSync(`git mv ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { cwd: ROOT, stdio: 'pipe' });

  let content = fs.readFileSync(dest, 'utf8');
  const baseDir = TESTS; // original dir of the file
  const newDir = destDir;

  // 1) re-relativize relative requires
  content = content.replace(REQUIRE_RE, (m, q, target) => {
    if (!target.startsWith('.')) return m;
    const trueAbs = resolveTrue(baseDir, target);
    if (!trueAbs) return m; // dynamic / unresolved — leave alone
    let rel = path.relative(newDir, trueAbs);
    if (!rel.startsWith('.')) rel = './' + rel;
    return `require(${q}${rel}${q})`;
  });

  // 2) upgrade __dirname depth for path.resolve/join (idempotent)
  content = content.replace(DIRNAME_BARE_RE, '$1, ".."');
  content = content.replace(DIRNAME_MULTI_RE, '$1"..", ');

  fs.writeFileSync(dest, content);
  moved++;
  console.log(`MOVED ${base} -> ${sub}/`);
}
console.log(`\nDone. ${moved} files moved.`);
