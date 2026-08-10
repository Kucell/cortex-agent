#!/usr/bin/env node
// scripts/test-runner.cjs
// ---------------------------------------------------------------------------
// Parallel test runner for *.test.js under tests/.
//
// Why this exists:
//   - The legacy `find ... | xargs -0 node --test` invocation is serial and
//     has no per-file timeout, so a single hanging test (e.g. one that
//     spawns a long-lived subprocess and forgets to kill it) blocks the
//     entire suite indefinitely.
//   - Re-running the full suite serially after every change is slow.
//
// What it does:
//   - Discovers tests/**/*.test.js (recursively, cross-platform).
//   - Runs them in N parallel `node --test <file>` child processes.
//   - Each worker has a hard per-file timeout (default 60s) so a single
//     hang never stalls the run; the worker is SIGKILL'd and reported as
//     TIMEOUT with a clear pointer to the file.
//   - Prints a one-line pass/fail per file with duration, then a summary.
//   - Supports filtering:
//       --module <name>          run only tests/commands/<name>.test.js
//                                or tests/commands/<name>/**/*.test.js
//       --scope <path>           run only tests/<path>/**/*.test.js
//       --file <relpath>         run a specific file
//   - Exits 0 only if every file passes.
//
// Usage:
//   node scripts/test-runner.cjs
//   node scripts/test-runner.cjs --module init
//   node scripts/test-runner.cjs --module surface/hook
//   node scripts/test-runner.cjs --scope commands
//   node scripts/test-runner.cjs --scope agent --workers 4
//   node scripts/test-runner.cjs --serial
//   node scripts/test-runner.cjs --workers 8 --timeout 30
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');

// ---- CLI parsing --------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    serial: false,
    workers: 0,
    module: null,
    scope: null,
    file: null,
    timeoutSec: 60,
    maxTimeSec: 0,  // 0 = no global wall-clock cap. Set --max-time SEC to enforce.
    perTestTimeoutMs: 0,  // 0 = no per-test timeout. Set --per-test-timeout MS to enforce (Node 24+).
    idleTimeoutSec: 0,    // 0 = no activity timeout. Set --idle-timeout SEC to kill children that print nothing for N seconds.
    help: false,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--serial':         opts.serial = true; break;
      case '--parallel':       opts.serial = false; break;
      case '-w': case '--workers': opts.workers = parseInt(argv[++i], 10); break;
      case '-m': case '--module':  opts.module = argv[++i]; break;
      case '-s': case '--scope':   opts.scope = argv[++i]; break;
      case '-f': case '--file':    opts.file = argv[++i]; break;
      case '--timeout':            opts.timeoutSec = parseInt(argv[++i], 10); break;
      case '--max-time':           opts.maxTimeSec = parseInt(argv[++i], 10); break;
      case '--per-test-timeout':  opts.perTestTimeoutMs = parseInt(argv[++i], 10); break;
      case '--idle-timeout':       opts.idleTimeoutSec = parseInt(argv[++i], 10); break;
      case '-q': case '--quiet':   opts.quiet = true; break;
      case '-h': case '--help':    opts.help = true; break;
      default:
        if (a.startsWith('-')) {
          console.error(`Unknown option: ${a}`);
          process.exit(2);
        }
    }
  }
  return opts;
}

function showHelp() {
  console.log(`Usage: node scripts/test-runner.cjs [options]

Options:
  --serial                Run tests serially in a single node process
  --parallel              Run tests in parallel workers (default)
  -w, --workers N         Number of workers (default: cpu.length, max 8)
  -m, --module NAME       Run only tests/commands/NAME[.test.js|/**/*.test.js]
  -s, --scope PATH        Run only tests/PATH/**.test.js
  -f, --file RELPATH      Run a specific file relative to tests/
  --timeout SEC           Per-file timeout (default 60)
  --max-time SEC          Global wall-clock cap (default 0 = no cap)
  --per-test-timeout MS   Pass through to node --test --test-timeout (Node 24+)
  --idle-timeout SEC      Kill a child if it prints nothing for N seconds (default 0 = off)
  -q, --quiet             Suppress per-file output, only print summary
  -h, --help              Show this help

Examples:
  node scripts/test-runner.cjs
  node scripts/test-runner.cjs --module init
  node scripts/test-runner.cjs --module surface/hook
  node scripts/test-runner.cjs --scope commands
  node scripts/test-runner.cjs --scope agent --workers 4
  node scripts/test-runner.cjs --timeout 30
`);
}

// ---- File discovery -----------------------------------------------------

function listTestFiles(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (e) {
      return; // missing dir
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

function toRel(p) {
  return path.relative(TESTS_DIR, p).replace(/\\/g, '/');
}

function filterFiles(files, opts) {
  if (opts.file) {
    const abs = path.resolve(TESTS_DIR, opts.file);
    return files.filter(f => f === abs);
  }
  if (opts.module) {
    // --module <name> matches any test file whose path ends with the name
    // (commands/<name>.test.js) OR lives in a directory named <name> or
    // <name>/**. This lets `--module init` cover both commands/init.test.js
    // and tests/init/*.test.js, and `--module surface/hook` cover
    // commands/surface/hook.test.js.
    const target = opts.module.replace(/\\/g, '/').replace(/\.test\.js$/, '');
    const last = target.split('/').pop();
    return files.filter(f => {
      const rel = toRel(f);
      return rel === `${target}.test.js`
        || rel.startsWith(`${target}/`)
        || rel.endsWith(`/${last}.test.js`);
    });
  }
  if (opts.scope) {
    const scope = opts.scope.replace(/\\/g, '/').replace(/\/$/, '');
    return files.filter(f => toRel(f).startsWith(`${scope}/`));
  }
  return files;
}

// ---- Worker -------------------------------------------------------------

function runOne(file, timeoutSec, perTestTimeoutMs, idleTimeoutSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    const rel = toRel(file);
    // Build child argv. Node 24+ supports --test-timeout for per-test
    // granularity (independent of the file-level timeout we set below).
    const childArgv = ['--test', file];
    if (perTestTimeoutMs > 0) childArgv.push(`--test-timeout=${perTestTimeoutMs}`);
    const child = spawn(process.execPath, childArgv, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); lastActivity = Date.now(); });
    child.stderr.on('data', d => { stderr += d.toString(); lastActivity = Date.now(); });

    let killed = false;
    let killReason = 'timeout';
    let lastActivity = Date.now();

    const timer = setTimeout(() => {
      killed = true;
      killReason = `file-timeout(${timeoutSec}s)`;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutSec * 1000);

    // Idle timeout: if the child hasn't printed anything for N seconds,
    // it is almost certainly hung (e.g. deadlocked subprocess, infinite
    // poll). Kill it so the suite doesn't drag on.
    let idleTimer = null;
    if (idleTimeoutSec > 0) {
      idleTimer = setInterval(() => {
        if (Date.now() - lastActivity < idleTimeoutSec * 1000) return;
        killed = true;
        killReason = `idle-timeout(${idleTimeoutSec}s-no-stdout)`;
        try { child.kill('SIGKILL'); } catch (_) {}
      }, Math.max(250, Math.floor(idleTimeoutSec * 1000 / 4)));
      if (idleTimer.unref) idleTimer.unref();
    }

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (idleTimer) clearInterval(idleTimer);
      resolve({
        file,
        rel,
        ok: !killed && code === 0 && !signal,
        code,
        signal: signal || null,
        killed,
        killReason: killed ? killReason : null,
        duration: Date.now() - start,
        stdout,
        stderr,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        file,
        rel,
        ok: false,
        code: -1,
        signal: null,
        killed: false,
        duration: Date.now() - start,
        stdout,
        stderr: stderr + `\n[SPAWN ERROR: ${err.message}]`,
      });
    });
  });
}

// ---- Runners ------------------------------------------------------------

async function runParallel(files, workers, timeoutSec, quiet, perTestTimeoutMs, idleTimeoutSec) {
  const queue = files.slice();
  const results = [];
  let inflight = 0;
  let completed = 0;
  const total = files.length;

  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      if (!file) return;
      inflight += 1;
      const r = await runOne(file, timeoutSec, perTestTimeoutMs, idleTimeoutSec);
      inflight -= 1;
      completed += 1;
      results.push(r);
      if (!quiet) printResult(r, completed, total);
    if (r.killed && r.killReason) {
      console.error(`  ⏱ kill-reason: ${r.killReason}`);
    }
    }
  }
  const w = Math.max(1, Math.min(workers, files.length || 1));
  await Promise.all(Array.from({ length: w }, worker));
  return results;
}

function runSerial(files, timeoutSec) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      console.error(`\n[TIMEOUT after ${timeoutSec}s — process killed]`);
      resolve([{
        file: '<serial>',
        rel: '<serial>',
        ok: false,
        code: -1,
        signal: 'SIGKILL',
        killed: true,
        duration: Date.now() - start,
        stdout: '',
        stderr: '',
      }]);
    }, timeoutSec * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve([{
        file: '<serial>',
        rel: '<serial>',
        ok: code === 0,
        code: code || 0,
        signal: null,
        killed: false,
        duration: Date.now() - start,
        stdout: '',
        stderr: '',
      }]);
    });
  });
}

// ---- Output -------------------------------------------------------------

const COLOR = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
};

function colorize(s, color, enabled) {
  if (!enabled) return s;
  return `${COLOR[color]}${s}${COLOR.reset}`;
}

function printResult(r, idx, total) {
  const useColor = process.stdout.isTTY;
  const tag = r.killed
    ? colorize('⏱ TIMEOUT', 'yellow', useColor)
    : r.ok
      ? colorize('✓', 'green', useColor)
      : colorize('✗', 'red', useColor);
  const where = r.signal
    ? `signal=${r.signal}`
    : `exit=${r.code}`;
  const idxStr = total ? `[${String(idx).padStart(String(total).length)}/${total}]` : '';
  console.log(`${tag} ${idxStr} ${r.rel}  (${r.duration}ms, ${where})`);
  if (!r.ok && (r.stderr || r.stdout)) {
    const text = (r.stderr || r.stdout);
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const tail = lines.slice(-25).join('\n');
    if (tail) {
      const dim = colorize('', 'dim', useColor);
      console.log(dim + '    ' + tail.split('\n').join('\n    ') + COLOR.reset);
    }
  }
}

// ---- Main ---------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { showHelp(); return; }

  const allFiles = listTestFiles(TESTS_DIR);
  const files = filterFiles(allFiles, opts);
  if (files.length === 0) {
    console.error('No test files matched.');
    process.exit(2);
  }

  const cpuCount = os.cpus().length;
  const defaultWorkers = Math.min(8, Math.max(2, cpuCount));
  const workers = opts.workers || defaultWorkers;
  const useColor = process.stdout.isTTY;

  console.log(colorize(
    `[test-runner] mode=${opts.serial ? 'serial' : 'parallel'} workers=${opts.serial ? 1 : workers} ` +
    `timeout=${opts.timeoutSec}s files=${files.length}` +
    (opts.scope ? ` scope=${opts.scope}` : '') +
    (opts.module ? ` module=${opts.module}` : '') +
    (opts.file ? ` file=${opts.file}` : ''),
    'dim', useColor,
  ));

  // Global wall-clock cap: abort the whole run if --max-time SEC is set.
  // Without this, the parallel runner only times out per file; if many files
  // each timeout, the cumulative wall-clock can still be 60s × N. Set a
  // hard cap so a CI / interactive run can't get stuck indefinitely.
  let globalTimer = null;
  if (opts.maxTimeSec > 0) {
    globalTimer = setTimeout(() => {
      console.error(`\n[GLOBAL TIMEOUT after ${opts.maxTimeSec}s — aborting run]`);
      process.exit(2);
    }, opts.maxTimeSec * 1000);
    if (globalTimer.unref) globalTimer.unref();
  }

  const t0 = Date.now();
  let results;
  if (opts.serial || files.length === 1) {
    results = await runSerial(files, opts.timeoutSec * Math.max(1, files.length));
  } else {
    results = await runParallel(files, workers, opts.timeoutSec, opts.quiet, opts.perTestTimeoutMs, opts.idleTimeoutSec);
  }
  if (globalTimer) clearTimeout(globalTimer);
  const total = Date.now() - t0;

  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  const timeouts = results.filter(r => r.killed).length;

  console.log('');
  console.log(colorize(
    `[test-runner] ${pass}/${results.length} passed in ${total}ms` +
    (timeouts ? ` (${timeouts} TIMEOUT)` : '') +
    (fail ? `, ${fail} FAILED` : ''),
    fail === 0 ? 'green' : 'red', useColor,
  ));

  if (fail > 0) {
    console.log('');
    for (const r of results) {
      if (!r.ok) {
        const tag = r.killed ? '⏱ TIMEOUT' : '✗ FAIL';
        console.log(`  ${tag}  ${r.rel}  (${r.duration}ms)`);
      }
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[test-runner] fatal:', err && err.stack || err);
  process.exit(2);
});

// ---- Signal handling: kill all spawned children on Ctrl-C / SIGTERM ----------
//
// Without this, `npm test` could leave orphaned test-runner or node --test
// children behind when the user Ctrl-C's the run. We trap the signal,
// forward SIGTERM to any tracked child PID set, and exit with the standard
// 130 (128 + SIGINT) or 143 (128 + SIGTERM) code so callers can detect an
// aborted run vs a clean pass/fail.
//
// Implementation: the parallel runner doesn't expose a child-pid registry,
// so we use a fallback — spawn a kill tree walk via `pgrep -P <ppid>` plus
// SIGKILL on the runner's own PID. This is best-effort: on macOS without
// gtimeout / Linux without pgrep the cleanup may be incomplete, but the
// runner always exits cleanly so the shell that invoked it can proceed.

let aborted = false;
function abortRun(signal) {
  if (aborted) return;
  aborted = true;
  console.error(`\n[test-runner] aborted by ${signal} — killing children`);
  try {
    // Try pgrep-based tree walk; fall back to pkill on the runner's own
    // process group. pgrep is available on macOS and Linux by default.
    const { spawnSync } = require('child_process');
    const myPid = process.pid;
    spawnSync('pkill', ['-P', String(myPid)], { stdio: 'ignore' });
    spawnSync('pkill', ['-TERM', '-P', String(myPid)], { stdio: 'ignore' });
  } catch (_) { /* best-effort */ }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
process.on('SIGINT', () => abortRun('SIGINT'));
process.on('SIGTERM', () => abortRun('SIGTERM'));
process.on('SIGHUP', () => abortRun('SIGHUP'));
