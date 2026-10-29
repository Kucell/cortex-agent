/**
 * heartbeat.js — Knowledge Maintenance Heartbeat
 *
 * 依次运行 knowledge-lint 和 doc-gardening，输出摘要。
 *
 * 用法:
 *   node .agent/scripts/heartbeat.js
 *   node .agent/scripts/heartbeat.js --dry-run
 *
 * 退出码:
 *   0 — 两个脚本都通过（无 P0 问题）
 *   1 — 任一脚本报告存在 P0 问题
 *   2 — 脚本运行失败（执行错误）
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const isDryRun = process.argv.includes('--dry-run');

const SCRIPTS = [
  {
    name: 'knowledge-lint',
    script: '.agent/skills/knowledge-lint/scripts/index.js',
    output: '.agent/metrics/knowledge-health.json',
  },
  {
    name: 'doc-gardening',
    script: '.agent/skills/doc-gardening/scripts/index.js',
    output: '.agent/metrics/doc-gardening-report.json',
  },
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractP0Count(name, outputPath) {
  const data = readJson(path.join(root, outputPath));
  if (!data) return null;

  if (name === 'knowledge-lint') {
    const s = data.summary || {};
    const total =
      (s.broken_links || 0) +
      (s.broken_anchors || 0) +
      (s.missing_readmes || 0) +
      (s.plan_issues || 0) +
      (s.architecture_doc_mismatches || 0);
    return { healthScore: data.health_score, totalIssues: total };
  }

  if (name === 'doc-gardening') {
    const s = data.summary || {};
    return { p0: s.p0_items || 0, status: data.status };
  }

  return null;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function runScript(entry) {
  const scriptPath = path.join(root, entry.script);
  const start = Date.now();

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const duration = Date.now() - start;

  return {
    name: entry.name,
    script: entry.script,
    output: entry.output,
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration,
    error: result.error || null,
  };
}

function printSeparator() {
  console.log('─'.repeat(50));
}

function printHeader() {
  printSeparator();
  console.log(' Cortex-Agent Heartbeat');
  if (isDryRun) {
    console.log(' Mode: DRY-RUN (no scripts will be executed)');
  }
  console.log(` Time: ${new Date().toISOString()}`);
  printSeparator();
}

function printDryRun() {
  printHeader();
  console.log('\nPlanned steps:\n');
  SCRIPTS.forEach((entry, idx) => {
    console.log(`  ${idx + 1}. ${entry.name}`);
    console.log(`     script : ${entry.script}`);
    console.log(`     output : ${entry.output}`);
  });
  console.log('\nRun without --dry-run to execute.');
  printSeparator();
}

function printResult(run, metrics) {
  const ok = run.exitCode === 0 && !run.error;
  const status = run.error ? 'ERROR' : ok ? 'OK' : 'WARN';
  const mark = status === 'OK' ? '[OK]' : status === 'WARN' ? '[WARN]' : '[ERR]';

  console.log(`\n${mark} ${run.name}  (${formatDuration(run.duration)})`);
  console.log(`     script : ${run.script}`);
  console.log(`     output : ${run.output}`);

  if (run.error) {
    console.log(`     error  : ${run.error.message}`);
    return;
  }

  if (run.exitCode !== 0) {
    console.log(`     exitCode: ${run.exitCode}`);
    if (run.stderr) {
      console.log('     stderr :');
      run.stderr
        .trim()
        .split('\n')
        .forEach((line) => console.log(`       ${line}`));
    }
    return;
  }

  if (metrics) {
    if (run.name === 'knowledge-lint') {
      console.log(`     health score : ${metrics.healthScore}/100`);
      console.log(`     total issues : ${metrics.totalIssues}`);
    } else if (run.name === 'doc-gardening') {
      console.log(`     status : ${metrics.status}`);
      console.log(`     P0 items : ${metrics.p0}`);
    }
  }
}

function printSummary(results) {
  const hasError = results.some((r) => r.error || r.exitCode === null);
  const hasP0 = results.some((r) => {
    if (r.error || r.exitCode !== 0) return false;
    const m = extractP0Count(r.name, r.output);
    if (!m) return false;
    if (r.name === 'doc-gardening') return m.p0 > 0;
    return false;
  });

  console.log('\nSummary:');

  results.forEach((r) => {
    const ok = !r.error && r.exitCode === 0;
    const tag = r.error ? 'ERROR' : ok ? 'pass' : 'warn';
    console.log(`  ${r.name.padEnd(18)} ${tag}  (${formatDuration(r.duration)})`);
  });

  const totalMs = results.reduce((acc, r) => acc + r.duration, 0);
  console.log(`\n  Total time: ${formatDuration(totalMs)}`);

  if (hasError) {
    console.log('\n  Exit 2 — one or more scripts failed to run.');
  } else if (hasP0) {
    console.log('\n  Exit 1 — P0 issues detected. Action required.');
  } else {
    console.log('\n  Exit 0 — All checks passed.');
  }

  printSeparator();

  if (hasError) return 2;
  if (hasP0) return 1;
  return 0;
}

function main() {
  if (isDryRun) {
    printDryRun();
    process.exit(0);
  }

  printHeader();

  const results = [];

  for (const entry of SCRIPTS) {
    console.log(`\nRunning: ${entry.name} ...`);
    const run = runScript(entry);

    if (run.error) {
      results.push(run);
      printResult(run, null);
      continue;
    }

    // Print the script's own stdout (indented)
    if (run.stdout.trim()) {
      run.stdout
        .trim()
        .split('\n')
        .forEach((line) => console.log(`  ${line}`));
    }

    const metrics = extractP0Count(entry.name, entry.output);
    results.push(run);
    printResult(run, metrics);
  }

  const exitCode = printSummary(results);
  process.exit(exitCode);
}

main();
