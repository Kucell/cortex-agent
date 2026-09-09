#!/usr/bin/env node
// memory-curator.js — L1 CLI shell for memory-curator sub-agent
//
// Implements the CLI surface declared in SKILL.md. The actual intelligence
// lives in sub-agents/memory-curator.md (Sonnet); this shell:
//   1) parses + validates args
//   2) prepares a draft / result / error envelope
//   3) emits a JSON envelope compatible with management-api
//   4) honors the failure-rollback contract from workflows/memory-distill.md
//
// Source-of-truth: sub-agents/memory-curator.md owns the *what*.
// This file owns only the *how* (CLI mechanics, envelope shape, gate handling).

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = process.cwd();
const AGENT_ROOT = path.join(PROJECT_ROOT, '.agent');
const MEMORY_ROOT = path.join(AGENT_ROOT, 'memory');
const RUNS_DIR = path.join(AGENT_ROOT, 'runs');
const INDEX_FILE = path.join(MEMORY_ROOT, 'index.yaml');

const ALLOWED_TYPES = ['episodic', 'semantic', 'procedural'];
const ALLOWED_SOURCES = ['sessions', 'conversations'];
const VALID_MEMORY_ID = /^M-[A-Za-z0-9][A-Za-z0-9._-]+$/;
const DEFAULT_MAX_RECORDS = 20;
const DEFAULT_LIST_LIMIT = 20;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(code, message, exitCode = 2) {
  emit({ ok: false, error: code, message });
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');   // --memory-id → memory_id
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function ensureDirs() {
  for (const t of ALLOWED_TYPES) {
    fs.mkdirSync(path.join(MEMORY_ROOT, t), { recursive: true });
  }
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function readIndex() {
  try {
    if (!fs.existsSync(INDEX_FILE)) return { entries: [] };
    // Minimal YAML-ish parse (just lines we own): tolerate absent file.
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const entries = [];
    let cur = null;
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*-\s*id:\s*(\S+)/);
      if (m) { if (cur) entries.push(cur); cur = { id: m[1] }; continue; }
      if (cur) {
        const tm = line.match(/^\s+type:\s*(\S+)/); if (tm) cur.type = tm[1];
        const cm = line.match(/^\s+created_at:\s*(.+)$/); if (cm) cur.created_at = cm[1];
        const fm = line.match(/^\s+title:\s*(.+)$/); if (fm) cur.title = fm[1];
      }
    }
    if (cur) entries.push(cur);
    return { entries };
  } catch (_) {
    return { entries: [] };
  }
}

function filterTypes(args, defaultAll = false) {
  if (!args.type) return defaultAll ? [...ALLOWED_TYPES] : [];
  const ts = String(args.type).split(',').map(s => s.trim()).filter(Boolean);
  const bad = ts.filter(t => !ALLOWED_TYPES.includes(t));
  if (bad.length) fail('invalid_type', `unknown type: ${bad.join(',')} (allowed: ${ALLOWED_TYPES.join(',')})`);
  return ts;
}

// ─────────────────────────────────────────────────────────────
// distill: prepare draft envelope + report what sub-agent should do.
// Actual LLM call lives in sub-agents/memory-curator.md; this shell emits a
// deterministic dry-run report + creates the draft directory.
// ─────────────────────────────────────────────────────────────
function cmdDistill(args) {
  if (!args.source) fail('source_required', '--source sessions|conversations required');
  if (!ALLOWED_SOURCES.includes(args.source)) fail('invalid_source', `--source must be one of: ${ALLOWED_SOURCES.join('|')}`);
  const types = filterTypes(args, true);
  if (!types.length) fail('type_required', `--type must include at least one of: ${ALLOWED_TYPES.join(',')}`);

  ensureDirs();
  const since = args.since || null;
  const max = Number(args.max_records) || DEFAULT_MAX_RECORDS;
  const dryRun = !!args.dry_run;

  const runId = `R-${new Date().toISOString().replace(/[:.]/g, '-')}-memory-distill`;
  const runDir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(path.join(runDir, 'drafts'), { recursive: true });

  // Source scan (count only — actual content extraction is sub-agent's job)
  let sourceCount = 0;
  const sourceDir = path.join(AGENT_ROOT, args.source === 'sessions' ? 'sessions' : 'conversations');
  if (fs.existsSync(sourceDir)) {
    const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'));
    sourceCount = files.length;
  }

  const envelope = {
    ok: true,
    action: 'memory-curator.distill.prepared',
    run_id: runId,
    run_dir: runDir,
    source: args.source,
    source_count: sourceCount,
    since,
    max_records: max,
    types,
    dry_run: dryRun,
    next_action: dryRun
      ? 'dry-run complete — no writes; inspect envelope then rerun without --dry-run'
      : 'invoke sub-agents/memory-curator.md with this envelope; it will generate drafts/, validate, then atomically rename to .agent/memory/<type>/<M-XXX>.md + append index.yaml',
    rollback_contract: {
      on_failure: 'delete drafts/, write error.json, notify parent agent via inbox',
      schema_ref: 'templates/_base/.agent/memory/memory.schema.json (M-001 publish)'
    }
  };
  fs.writeFileSync(path.join(runDir, dryRun ? 'dry-run.json' : 'result.json'),
    JSON.stringify(envelope, null, 2) + '\n');
  emit(envelope);
}

// ─────────────────────────────────────────────────────────────
// list: scan .agent/memory/{type}/ + return entries
// ─────────────────────────────────────────────────────────────
function cmdList(args) {
  ensureDirs();
  const types = filterTypes(args, true);
  const limit = Number(args.limit) || DEFAULT_LIST_LIMIT;
  const entries = [];

  for (const t of types) {
    const dir = path.join(MEMORY_ROOT, t);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const f of files) {
      const id = f.replace(/\.md$/, '');
      entries.push({ id, type: t, path: path.relative(PROJECT_ROOT, path.join(dir, f)) });
      if (entries.length >= limit) break;
    }
    if (entries.length >= limit) break;
  }

  emit({ ok: true, count: entries.length, limit, types, entries });
}

// ─────────────────────────────────────────────────────────────
// inspect: read a single memory record by id
// ─────────────────────────────────────────────────────────────
function cmdInspect(args) {
  if (!args.memory_id) fail('memory_id_required', '--memory-id <M-XXX> required');
  if (!VALID_MEMORY_ID.test(args.memory_id)) fail('invalid_memory_id', '--memory-id must match ' + VALID_MEMORY_ID);

  for (const t of ALLOWED_TYPES) {
    const f = path.join(MEMORY_ROOT, t, args.memory_id + '.md');
    if (fs.existsSync(f)) {
      const body = fs.readFileSync(f, 'utf8');
      emit({ ok: true, id: args.memory_id, type: t, path: path.relative(PROJECT_ROOT, f), body });
      return;
    }
  }
  fail('not_found', `no record with id ${args.memory_id} in any type directory`);
}

// ─────────────────────────────────────────────────────────────
// dispatch
// ─────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'distill': return cmdDistill(args);
    case 'list':    return cmdList(args);
    case 'inspect': return cmdInspect(args);
    case '--help':
    case '-h':
    case undefined:
      emit({
        ok: true,
        usage: {
          distill: 'memory-curator.js distill --source sessions|conversations --since <ISO> [--max-records 20] --type episodic,semantic,procedural [--dry-run]',
          list:    'memory-curator.js list [--type episodic,semantic,procedural] [--limit 20]',
          inspect: 'memory-curator.js inspect --memory-id <M-XXX>'
        },
        authoritative_subagent: 'sub-agents/memory-curator.md'
      });
      return;
    default:
      fail('unknown_command', `unknown command: ${cmd}`);
  }
}

main();
