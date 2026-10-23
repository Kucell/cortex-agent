/**
 * maturity-tracker/scripts/index.js
 *
 * 收集 Harness 各组件表现指标，追加到 .agent/metrics/component-health.json。
 * 零依赖，纯 Node.js。
 *
 * 用法：
 *   node .agent/skills/maturity-tracker/scripts/index.js [--task <task_id>] [--seed]
 *
 *   --task <id>    指定本次记录的 task_id（默认 manual）
 *   --seed         注入一条基于当前真实数据的种子记录
 *   --dry-run      构建记录但不写入 metrics 文件
 *   --status       只读：打印健康度看板摘要（不修改任何文件）
 *   --report PATH  只读：把看板写成 markdown 文件
 *   --help         打印帮助
 *
 * 幂等性：如果新记录的 metrics fingerprint 与最近一条完全一致，跳过追加并打印 no-op。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 路径常量
// ---------------------------------------------------------------------------
const root = process.cwd();
const outputPath = path.join(root, '.agent', 'metrics', 'component-health.json');

const ENTROPY_REPORT = path.join(root, '.agent', 'entropy-report.json');
const SELF_CHECK_REPORT = path.join(root, '.agent', 'metrics', 'self-check-report.json');
const REASONING_CONFIG = path.join(root, '.agent', 'config', 'reasoning-config.yml');
const CONTEXT_MANIFEST = path.join(root, '.agent', 'metrics', 'context-manifest.json');
const EXECUTION_REPORT = path.join(root, '.agent', 'metrics', 'execution_report.json');
const HARNESS_MANIFEST = path.join(root, '.agent', 'harness-manifest.yml');

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let taskId = 'manual';
let seedMode = false;
let dryRun = false;
let statusMode = false;
let reportPath = null;
let showHelp = false;

function printHelp() {
  var line = [];
  line.push('maturity-tracker — Harness component health tracker');
  line.push('');
  line.push('Usage:');
  line.push('  node .agent/skills/maturity-tracker/scripts/index.js [options]');
  line.push('');
  line.push('Write modes (default):');
  line.push('  (no flag)             追加一条记录（带幂等检查：与最近一条 fingerprint 完全一致则跳过）');
  line.push('  --task <id>           指定本次记录的 task_id（默认 manual）');
  line.push('  --seed                注入种子记录（基于当前真实数据）');
  line.push('  --dry-run             构建但不写入 metrics 文件');
  line.push('');
  line.push('Read-only modes:');
  line.push('  --status              打印健康度看板摘要（stdout），不修改任何文件');
  line.push('  --report <out.md>     把当前看板导出为 markdown 文件（不修改 metrics）');
  line.push('');
  line.push('Other:');
  line.push('  --help, -h            打印本帮助');
  line.push('');
  line.push('Output file: .agent/metrics/component-health.json');
  console.log(line.join('\n'));
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--task' && args[i + 1]) {
    taskId = args[i + 1];
    i++;
  } else if (args[i] === '--seed') {
    seedMode = true;
  } else if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--status') {
    statusMode = true;
  } else if (args[i] === '--report' && args[i + 1]) {
    reportPath = args[i + 1];
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    showHelp = true;
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 安全读取 JSON 文件，不存在或解析失败返回 null */
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 安全读取文本文件，不存在返回 null */
function readText(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/** 从 YAML 文本中 grep 出第一个匹配 key 的值（不引入 yaml 库） */
function grepYamlValue(text, key) {
  if (!text) return null;
  const pattern = new RegExp(`^\\s*${key}:\\s*([^#\\n\\r]+)`, 'm');
  const match = pattern.exec(text);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

/** 确保目录存在 */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** 计算一条记录的 metrics fingerprint（用于幂等检查）。规范化 null / 顺序无关。 */
function metricsFingerprint(record) {
  if (!record || !record.metrics) return '';
  var keys = Object.keys(record.metrics).sort();
  var sorted = {};
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    sorted[k] = record.metrics[k];
  }
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// 指标收集
// ---------------------------------------------------------------------------

function collectEntropyScanner() {
  const report = readJson(ENTROPY_REPORT);
  if (!report) {
    return { health_score: null, auto_fixes: null, l2_pending: null };
  }
  return {
    health_score: report.health_score != null ? report.health_score : null,
    auto_fixes: Array.isArray(report.l0_auto_fixed) ? report.l0_auto_fixed.length : null,
    l2_pending: Array.isArray(report.l2_observations) ? report.l2_observations.length : null,
  };
}

function collectAgentFirewall() {
  const report = readJson(SELF_CHECK_REPORT);
  if (!report) {
    return { contamination_detected: null, blocked_steps_count: null };
  }

  // self-check-report 里没有直接的 input_contamination 字段，
  // 通过 overall_status / failed_areas 推断污染状态
  let contamination = null;
  if (report.overall_status != null) {
    contamination = report.overall_status === 'fail' &&
      Array.isArray(report.failed_areas) &&
      report.failed_areas.includes('schema_validation');
  }

  const execReport = readJson(EXECUTION_REPORT);
  const blockedSteps = execReport && Array.isArray(execReport.blocked_steps)
    ? execReport.blocked_steps.length
    : null;

  return {
    contamination_detected: contamination,
    blocked_steps_count: blockedSteps,
  };
}

function collectReasoningSandwich() {
  const text = readText(REASONING_CONFIG);
  const costMode = grepYamlValue(text, 'cost_mode');

  // context-manifest.json 可能不存在，first_pass / retry_count 来自执行日志
  const execReport = readJson(EXECUTION_REPORT);
  const retryCount = execReport && execReport.retry_count != null
    ? execReport.retry_count
    : null;
  const firstPass = retryCount != null ? retryCount === 0 : null;

  return {
    first_pass: firstPass,
    retry_count: retryCount,
    cost_mode_used: costMode,
  };
}

function collectContextBudget() {
  const manifest = readJson(CONTEXT_MANIFEST);
  if (!manifest) {
    return { overflow_prevented: null, actual_utilization: null, within_limit: null };
  }
  return {
    overflow_prevented: manifest.overflow_prevented != null ? manifest.overflow_prevented : null,
    actual_utilization: manifest.utilization != null ? manifest.utilization : null,
    within_limit: manifest.within_limit != null ? manifest.within_limit : null,
  };
}

function collectPhaseGate() {
  const execReport = readJson(EXECUTION_REPORT);
  if (!execReport) {
    return { gates_passed: null, gates_blocked: null };
  }
  return {
    gates_passed: execReport.gates_passed != null ? execReport.gates_passed : null,
    gates_blocked: execReport.gates_blocked != null ? execReport.gates_blocked : null,
  };
}

/** 组装一条完整的指标记录 */
function buildRecord(id, timestamp) {
  return {
    task_id: id,
    timestamp: timestamp || new Date().toISOString(),
    metrics: {
      context_budget: collectContextBudget(),
      reasoning_sandwich: collectReasoningSandwich(),
      agent_firewall: collectAgentFirewall(),
      entropy_scanner: collectEntropyScanner(),
      phase_gate: collectPhaseGate(),
    },
  };
}

// ---------------------------------------------------------------------------
// 滚动平均值计算（最近 30 条）
// ---------------------------------------------------------------------------

/** 计算数值数组的平均值，过滤掉 null */
function avg(values) {
  const nums = values.filter((v) => v != null && typeof v === 'number');
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

/** 计算布尔数组的 true 比例，格式化为百分比字符串 */
function rateStr(values) {
  const bools = values.filter((v) => v != null && typeof v === 'boolean');
  if (bools.length === 0) return null;
  const rate = bools.filter(Boolean).length / bools.length;
  return `${Math.round(rate * 1000) / 10}%`;
}

/** 将百分比字符串（如 "25.4%"）解析为数字 */
function parsePercent(str) {
  if (str == null) return null;
  if (typeof str === 'number') return str;
  const m = /^([\d.]+)%$/.exec(String(str).trim());
  return m ? parseFloat(m[1]) : null;
}

function computeRollingAverages(records) {
  if (!records || records.length === 0) return null;

  const m = (record, ...keys) => {
    let val = record && record.metrics;
    for (const k of keys) val = val && val[k];
    return val != null ? val : null;
  };

  // context_budget
  const overflowPrevented = records.map((r) => m(r, 'context_budget', 'overflow_prevented'));
  const utilizations = records.map((r) => parsePercent(m(r, 'context_budget', 'actual_utilization')));
  const withinLimits = records.map((r) => m(r, 'context_budget', 'within_limit'));

  // reasoning_sandwich
  const firstPasses = records.map((r) => m(r, 'reasoning_sandwich', 'first_pass'));
  const retryCounts = records.map((r) => m(r, 'reasoning_sandwich', 'retry_count'));

  // agent_firewall
  const contaminations = records.map((r) => m(r, 'agent_firewall', 'contamination_detected'));
  const blockedSteps = records.map((r) => m(r, 'agent_firewall', 'blocked_steps_count'));

  // entropy_scanner
  const healthScores = records.map((r) => m(r, 'entropy_scanner', 'health_score'));
  const autoFixes = records.map((r) => m(r, 'entropy_scanner', 'auto_fixes'));

  // phase_gate
  const gatesBlocked = records.map((r) => m(r, 'phase_gate', 'gates_blocked'));

  const avgUtil = avg(utilizations);

  return {
    window_days: 30,
    context_budget: {
      overflow_rate: rateStr(overflowPrevented.map((v) => v === false ? true : v === true ? false : null)),
      avg_utilization: avgUtil != null ? `${avgUtil}%` : null,
      within_limit_rate: rateStr(withinLimits),
    },
    reasoning_sandwich: {
      first_pass_rate: rateStr(firstPasses),
      avg_retry_count: avg(retryCounts),
    },
    agent_firewall: {
      contamination_rate: rateStr(contaminations),
      avg_blocked_steps: avg(blockedSteps),
    },
    entropy_scanner: {
      avg_health_score: avg(healthScores),
      avg_auto_fixes_per_ship: avg(autoFixes),
    },
    phase_gate: {
      avg_gates_blocked_per_ship: avg(gatesBlocked),
    },
  };
}

// ---------------------------------------------------------------------------
// 退化建议生成
// ---------------------------------------------------------------------------

/**
 * 从 harness-manifest.yml 解析 advisory trigger 条件（文本 grep，不用 yaml 库）。
 * 只处理最常见的 "连续 N 天 metric_name > threshold" 形式，其他视为 "满足条件"。
 */
function generateDegradationSuggestions(rollingAverages) {
  if (!rollingAverages) return [];

  const text = readText(HARNESS_MANIFEST);
  if (!text) return [];

  const suggestions = [];

  // entropy_scanner: health_score > 95 连续 30 天
  if (rollingAverages.entropy_scanner && rollingAverages.entropy_scanner.avg_health_score != null) {
    const score = rollingAverages.entropy_scanner.avg_health_score;
    if (score > 95) {
      suggestions.push(
        'entropy_scanner 退化建议：rolling avg_health_score = ' + score +
        ' > 95，满足 advisory 触发条件。\n' +
        '  建议将独立 entropy-scanner 改为 /ship 内置轻量检查步骤。\n' +
        '  操作：手动修改 harness-manifest.yml 中 entropy_scanner.status = advisory'
      );
    }
  }

  // agent_firewall: contamination_rate = 0% 连续 30 天
  if (rollingAverages.agent_firewall && rollingAverages.agent_firewall.contamination_rate != null) {
    const rate = parseFloat(rollingAverages.agent_firewall.contamination_rate);
    if (!isNaN(rate) && rate === 0) {
      suggestions.push(
        'agent_firewall 退化建议：rolling contamination_rate = 0%，满足 advisory 触发条件。\n' +
        '  建议将严格 JSON 契约改为半结构化输出。\n' +
        '  操作：手动修改 harness-manifest.yml 中 agent_firewall.status = advisory'
      );
    }
  }

  // context_budget: overflow_rate = 0%（即 overflow_prevented_rate > 90%）
  if (rollingAverages.context_budget && rollingAverages.context_budget.overflow_rate != null) {
    const rate = parseFloat(rollingAverages.context_budget.overflow_rate);
    if (!isNaN(rate) && rate === 0) {
      suggestions.push(
        'context_budget 退化建议：rolling overflow_rate = 0%，满足 advisory 触发条件。\n' +
        '  建议将 40% 硬上限改为 60% 软建议，允许 AI 自行判断是否超出。\n' +
        '  操作：手动修改 harness-manifest.yml 中 context_budget.status = advisory'
      );
    }
  }

  // reasoning_sandwich: first_pass_rate > 90%
  if (rollingAverages.reasoning_sandwich && rollingAverages.reasoning_sandwich.first_pass_rate != null) {
    const rate = parseFloat(rollingAverages.reasoning_sandwich.first_pass_rate);
    if (!isNaN(rate) && rate > 90) {
      suggestions.push(
        'reasoning_sandwich 退化建议：rolling first_pass_rate = ' + rate +
        '% > 90%，满足 advisory 触发条件。\n' +
        '  建议将三模型配置降为双模型（planning=sonnet, execution=haiku, verification=sonnet）。\n' +
        '  操作：手动修改 harness-manifest.yml 中 reasoning_sandwich.status = advisory'
      );
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// 读写 component-health.json
// ---------------------------------------------------------------------------

function loadHealth() {
  const data = readJson(outputPath);
  if (data && Array.isArray(data.records)) return data;
  // 返回默认骨架
  return {
    _meta: {
      description: 'Harness 组件表现指标，由 maturity-tracker skill 在每次 /ship CLEAN 后写入',
      rolling_window_days: 30,
      max_records: 30,
    },
    records: [],
    rolling_averages: null,
    degradation_suggestions: [],
    last_updated: null,
    total_records: 0,
  };
}

function saveHealth(health) {
  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, JSON.stringify(health, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

// 只读模式：打印 status 摘要
function printStatus(health) {
  console.log('--- Maturity Tracker (read-only) ---');
  console.log('output           :', path.relative(root, outputPath));
  console.log('total_records    :', health.total_records || 0);
  console.log('last_updated     :', health.last_updated || '(none)');

  const ra = health.rolling_averages || {};
  const cb = ra.context_budget || {};
  const rs = ra.reasoning_sandwich || {};
  const af = ra.agent_firewall || {};
  const es = ra.entropy_scanner || {};
  const pg = ra.phase_gate || {};

  console.log('window_days      :', ra.window_days || 30);
  console.log('');
  console.log('Rolling Averages:');
  console.log('  context_budget    : overflow_rate=' + (cb.overflow_rate == null ? 'null' : cb.overflow_rate) +
    ' avg_util=' + (cb.avg_utilization == null ? 'null' : cb.avg_utilization) +
    ' within_limit=' + (cb.within_limit_rate == null ? 'null' : cb.within_limit_rate));
  console.log('  reasoning_sandwich: first_pass=' + (rs.first_pass_rate == null ? 'null' : rs.first_pass_rate) +
    ' avg_retry=' + (rs.avg_retry_count == null ? 'null' : rs.avg_retry_count));
  console.log('  agent_firewall   : contamination_rate=' + (af.contamination_rate == null ? 'null' : af.contamination_rate) +
    ' avg_blocked=' + (af.avg_blocked_steps == null ? 'null' : af.avg_blocked_steps));
  console.log('  entropy_scanner  : avg_health_score=' + (es.avg_health_score == null ? 'null' : es.avg_health_score) +
    ' avg_fixes=' + (es.avg_auto_fixes_per_ship == null ? 'null' : es.avg_auto_fixes_per_ship));
  console.log('  phase_gate       : avg_gates_blocked=' + (pg.avg_gates_blocked_per_ship == null ? 'null' : pg.avg_gates_blocked_per_ship));

  const ds = health.degradation_suggestions || [];
  if (ds.length > 0) {
    console.log('');
    console.log('=== Degradation Suggestions (' + ds.length + ') ===');
    ds.forEach(function(s, i) {
      console.log('');
      console.log('[' + (i + 1) + '] ' + s);
    });
  } else {
    console.log('');
    console.log('=== Degradation Suggestions: none ===');
  }

  console.log('');
  console.log('Records (most recent first, max 5):');
  const recent = (health.records || []).slice(-5).reverse();
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    const esR = r.metrics && r.metrics.entropy_scanner;
    const afR = r.metrics && r.metrics.agent_firewall;
    const rsR = r.metrics && r.metrics.reasoning_sandwich;
    console.log('  ' + r.timestamp + '  task=' + r.task_id +
      '  entropy_health=' + (esR && esR.health_score) +
      '  firewall=' + (afR && afR.contamination_detected) +
      '  cost_mode=' + (rsR && rsR.cost_mode_used));
  }
}

// 只读模式：渲染 markdown 报告
function renderMarkdownReport(health) {
  const lines = [];
  const now = new Date().toISOString().slice(0, 10);
  lines.push('# Maturity Tracker Report — ' + now);
  lines.push('');
  lines.push('> Generated by node .agent/skills/maturity-tracker/scripts/index.js --report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push('| Total records | ' + (health.total_records || 0) + ' |');
  lines.push('| Last updated | ' + (health.last_updated || '(none)') + ' |');
  lines.push('| Window | ' + ((health.rolling_averages && health.rolling_averages.window_days) || 30) + ' days |');
  lines.push('');

  const ra = health.rolling_averages || {};
  const cb = ra.context_budget || {};
  const rs = ra.reasoning_sandwich || {};
  const af = ra.agent_firewall || {};
  const es = ra.entropy_scanner || {};
  const pg = ra.phase_gate || {};

  lines.push('## Rolling Averages');
  lines.push('');
  lines.push('| Component | Metric | Value |');
  lines.push('|-----------|--------|-------|');
  lines.push('| context_budget | overflow_rate | ' + (cb.overflow_rate == null ? '—' : cb.overflow_rate) + ' |');
  lines.push('| context_budget | avg_utilization | ' + (cb.avg_utilization == null ? '—' : cb.avg_utilization) + ' |');
  lines.push('| context_budget | within_limit_rate | ' + (cb.within_limit_rate == null ? '—' : cb.within_limit_rate) + ' |');
  lines.push('| reasoning_sandwich | first_pass_rate | ' + (rs.first_pass_rate == null ? '—' : rs.first_pass_rate) + ' |');
  lines.push('| reasoning_sandwich | avg_retry_count | ' + (rs.avg_retry_count == null ? '—' : rs.avg_retry_count) + ' |');
  lines.push('| agent_firewall | contamination_rate | ' + (af.contamination_rate == null ? '—' : af.contamination_rate) + ' |');
  lines.push('| agent_firewall | avg_blocked_steps | ' + (af.avg_blocked_steps == null ? '—' : af.avg_blocked_steps) + ' |');
  lines.push('| entropy_scanner | avg_health_score | ' + (es.avg_health_score == null ? '—' : es.avg_health_score) + ' |');
  lines.push('| entropy_scanner | avg_auto_fixes_per_ship | ' + (es.avg_auto_fixes_per_ship == null ? '—' : es.avg_auto_fixes_per_ship) + ' |');
  lines.push('| phase_gate | avg_gates_blocked_per_ship | ' + (pg.avg_gates_blocked_per_ship == null ? '—' : pg.avg_gates_blocked_per_ship) + ' |');
  lines.push('');

  lines.push('## Degradation Suggestions');
  lines.push('');
  const ds = health.degradation_suggestions || [];
  if (ds.length > 0) {
    ds.forEach(function(s, i) {
      lines.push('### [' + (i + 1) + ']');
      lines.push('');
      lines.push('```');
      lines.push(s);
      lines.push('```');
      lines.push('');
    });
  } else {
    lines.push('_None — current metrics do not trigger any advisory conditions._');
    lines.push('');
  }

  lines.push('## Recent Records (last 10)');
  lines.push('');
  lines.push('| Timestamp | task_id | entropy_health | firewall | cost_mode |');
  lines.push('|-----------|---------|----------------|----------|-----------|');
  const recent = (health.records || []).slice(-10).reverse();
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    const esR = r.metrics && r.metrics.entropy_scanner;
    const afR = r.metrics && r.metrics.agent_firewall;
    const rsR = r.metrics && r.metrics.reasoning_sandwich;
    lines.push('| ' + r.timestamp + ' | ' + r.task_id +
      ' | ' + (esR && esR.health_score != null ? esR.health_score : '—') +
      ' | ' + (afR && afR.contamination_detected != null ? afR.contamination_detected : '—') +
      ' | ' + (rsR && rsR.cost_mode_used != null ? rsR.cost_mode_used : '—') + ' |');
  }
  lines.push('');

  return lines.join('\n');
}

function run() {
  if (showHelp) {
    printHelp();
    return;
  }

  // 只读分支：不动 metrics 文件
  if (statusMode) {
    const health = loadHealth();
    printStatus(health);
    return;
  }

  if (reportPath) {
    const health2 = loadHealth();
    const md = renderMarkdownReport(health2);
    const outAbs = path.resolve(root, reportPath);
    ensureDir(path.dirname(outAbs));
    fs.writeFileSync(outAbs, md, 'utf8');
    console.log('--- Maturity Tracker (read-only) ---');
    console.log('report written    :', reportPath);
    console.log('total_records    :', health2.total_records || 0);
    console.log('last_updated     :', health2.last_updated || '(none)');
    console.log('degradation_count:', (health2.degradation_suggestions || []).length);
    return;
  }

  // 写模式（默认）
  const healthW = loadHealth();
  const maxRecords = (healthW._meta && healthW._meta.max_records) || 30;

  const now = new Date().toISOString();
  const record = buildRecord(taskId, now);

  // 幂等检查：与最近一条记录比对 fingerprint
  const lastRecord = healthW.records.length > 0 ? healthW.records[healthW.records.length - 1] : null;
  const lastFp = lastRecord ? metricsFingerprint(lastRecord) : '';
  const newFp = metricsFingerprint(record);

  if (lastFp && lastFp === newFp) {
    console.log('--- Maturity Tracker ---');
    console.log('task_id          :', record.task_id);
    console.log('timestamp        :', record.timestamp);
    console.log('seed_mode        :', seedMode);
    console.log('action           : no-op (metrics fingerprint identical to last record)');
    console.log('total_records    :', healthW.total_records);
    console.log('last_record_ts   :', lastRecord.timestamp);
    console.log('');
    console.log('Output: ' + path.relative(root, outputPath) + ' (unchanged)');
    return;
  }

  // 追加记录，保留最近 max_records 条
  healthW.records.push(record);
  if (healthW.records.length > maxRecords) {
    healthW.records = healthW.records.slice(healthW.records.length - maxRecords);
  }

  // 重新计算 rolling_averages
  healthW.rolling_averages = computeRollingAverages(healthW.records);

  // 生成退化建议
  healthW.degradation_suggestions = generateDegradationSuggestions(healthW.rolling_averages);

  // 更新元数据
  healthW.last_updated = now.slice(0, 10);
  healthW.total_records = healthW.records.length;

  if (dryRun) {
    console.log('--- Maturity Tracker (dry-run) ---');
    console.log('task_id          :', record.task_id);
    console.log('timestamp        :', record.timestamp);
    console.log('seed_mode        :', seedMode);
    console.log('would_append     : yes');
    console.log('would_total      :', healthW.total_records);
    console.log('');
    console.log('Output: ' + path.relative(root, outputPath) + ' (NOT written)');
    return;
  }

  saveHealth(healthW);

  console.log('--- Maturity Tracker ---');
  console.log('task_id          :', record.task_id);
  console.log('timestamp        :', record.timestamp);
  console.log('seed_mode        :', seedMode);
  console.log('action           : appended (fingerprint differs from last)');
  console.log('total_records    :', healthW.total_records);

  const esR = record.metrics.entropy_scanner;
  console.log('entropy_scanner  : health_score=' + esR.health_score +
    ' auto_fixes=' + esR.auto_fixes + ' l2_pending=' + esR.l2_pending);

  const afR = record.metrics.agent_firewall;
  console.log('agent_firewall   : contamination_detected=' + afR.contamination_detected);

  const rsR = record.metrics.reasoning_sandwich;
  console.log('reasoning_sandwich: cost_mode=' + rsR.cost_mode_used);

  if (healthW.degradation_suggestions.length > 0) {
    console.log('');
    console.log('=== Degradation Suggestions ===');
    healthW.degradation_suggestions.forEach(function(s) { console.log('\n' + s); });
  }

  console.log('');
  console.log('Output: ' + path.relative(root, outputPath));
}

run();
