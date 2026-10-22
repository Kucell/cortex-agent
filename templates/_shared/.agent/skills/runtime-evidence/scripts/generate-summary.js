/**
 * generate-summary.js
 *
 * 聚合已有的四类 metrics 文件，把**仓库健康度**并入 verification-summary.json。
 * 供 /briefing 展示综合健康度。
 *
 * 输入源（均从 .agent/metrics/ 读取）：
 *   - self-check-report.json     → harness 组件
 *   - knowledge-health.json      → knowledge 组件
 *   - entropy-report.json        → entropy 组件（在 .agent/ 根目录）
 *   - coordinator-health.json    → coordinator 组件
 *
 * 输出：
 *   .agent/metrics/verification-summary.json
 *
 * 分工（为什么这里是「合并」而不是「覆盖」）：
 *   verification-summary.json 有两个生产方——本脚本与 runtime-evidence
 *   runner。runner 跑过验证数据集才有资格写 overall_status（pass/fail/
 *   partial）；本脚本只拥有 components 与仓库健康度。
 *   两者写同一个文件，所以本脚本**必须保留**对方已经写下的验证结论：
 *   覆盖写会让「跑过一次验证」的结果退化成 not_run，CLEAN 门禁随之
 *   静默放行——这正是 Phase 8 之后一直存在的那个洞。
 *
 * 零外部依赖，仅使用 Node.js built-in。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { buildDefaults } = require('./init.js');

// ─── 路径解析 ───────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const METRICS_DIR = path.join(ROOT, '.agent', 'metrics');
const AGENT_DIR = path.join(ROOT, '.agent');

const SRC = {
  selfCheck: path.join(METRICS_DIR, 'self-check-report.json'),
  knowledge: path.join(METRICS_DIR, 'knowledge-health.json'),
  entropy: path.join(AGENT_DIR, 'entropy-report.json'),
  coordinator: path.join(METRICS_DIR, 'coordinator-health.json'),
};

const OUT = path.join(METRICS_DIR, 'verification-summary.json');

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 安全读取 JSON 文件；若文件不存在或解析失败，返回 null。
 * @param {string} filePath
 * @returns {object|null}
 */
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 将 0-100 分数映射到状态字符串。
 * @param {number|null} score
 * @returns {'healthy'|'warning'|'critical'|'unknown'}
 */
function scoreToStatus(score) {
  if (score === null || score === undefined) return 'unknown';
  if (score >= 90) return 'healthy';
  if (score >= 70) return 'warning';
  return 'critical';
}

/**
 * 把状态字符串转成数值权重，用于计算综合状态。
 * @param {'healthy'|'warning'|'critical'|'unknown'} status
 * @returns {number}
 */
function statusWeight(status) {
  switch (status) {
    case 'healthy': return 3;
    case 'warning': return 2;
    case 'critical': return 1;
    case 'unknown': return 0;
    default: return 0;
  }
}

/**
 * 根据各组件状态列表，计算综合状态。
 * 规则：任一 critical → critical；任一 warning → warning；否则 healthy。
 * unknown 组件不计入综合状态计算（不因缺数据而降级）。
 * @param {string[]} statuses
 * @returns {'healthy'|'warning'|'critical'|'unknown'}
 */
function computeHealthStatus(statuses) {
  const known = statuses.filter((s) => s !== 'unknown');
  if (known.length === 0) return 'unknown';
  if (known.includes('critical')) return 'critical';
  if (known.includes('warning')) return 'warning';
  return 'healthy';
}

/**
 * 计算综合评分（已知组件的加权平均分）。
 * @param {{ score: number|null }[]} components
 * @returns {number} 0-100
 */
function computeOverallScore(components) {
  const valid = components.filter((c) => c.score !== null && c.score !== undefined);
  if (valid.length === 0) return 0;
  const sum = valid.reduce((acc, c) => acc + c.score, 0);
  return Math.round(sum / valid.length);
}

// ─── 各组件解析 ──────────────────────────────────────────────────────────────

/**
 * 解析 self-check-report.json → harness 组件数据。
 * @returns {{ score: number|null, status: string, drift_level: string|null, source: string }}
 */
function parseHarness() {
  const data = readJson(SRC.selfCheck);
  if (!data) {
    return { score: null, status: 'unknown', drift_level: null, source: 'self-check-report.json' };
  }

  // overall_status: 'pass'|'fail'|'warn'
  // drift_level: 'L0'|'L1'|'L2'
  const overallPass = data.overall_status === 'pass';
  const driftLevel = data.drift_level || 'L0';

  // 把 drift_level + overall_status 转为 0-100 分
  let score = 100;
  if (!overallPass) score = 30;
  else if (driftLevel === 'L2') score = 60;
  else if (driftLevel === 'L1') score = 80;

  return {
    score,
    status: scoreToStatus(score),
    drift_level: driftLevel,
    source: 'self-check-report.json',
    run_at: data.run_at || null,
    failed_areas: data.failed_areas || [],
    actions_needed: data.actions_needed || [],
  };
}

/**
 * 解析 knowledge-health.json → knowledge 组件数据。
 * @returns {{ score: number|null, status: string, source: string }}
 */
function parseKnowledge() {
  const data = readJson(SRC.knowledge);
  if (!data) {
    return { score: null, status: 'unknown', source: 'knowledge-health.json' };
  }

  const score = typeof data.health_score === 'number' ? data.health_score : null;
  return {
    score,
    status: scoreToStatus(score),
    source: 'knowledge-health.json',
    generated_at: data.generated_at || null,
    broken_links: data.summary?.broken_links ?? 0,
    broken_anchors: data.summary?.broken_anchors ?? 0,
    missing_readmes: data.summary?.missing_readmes ?? 0,
  };
}

/**
 * 解析 entropy-report.json → entropy 组件数据。
 * @returns {{ score: number|null, status: string, source: string }}
 */
function parseEntropy() {
  const data = readJson(SRC.entropy);
  if (!data) {
    return { score: null, status: 'unknown', source: 'entropy-report.json' };
  }

  const score = typeof data.health_score === 'number' ? data.health_score : null;
  return {
    score,
    status: scoreToStatus(score),
    source: 'entropy-report.json',
    generated_at: data.generated_at || null,
    l0_fixed: (data.l0_auto_fixed || []).length,
    l1_pending: (data.l1_pending_human || []).length,
    drift_status: data.status || null,
  };
}

/**
 * 解析 coordinator-health.json → coordinator 组件数据。
 * @returns {{ score: number|null, status: string, source: string }}
 */
function parseCoordinator() {
  const data = readJson(SRC.coordinator);
  if (!data) {
    return { score: null, status: 'unknown', source: 'coordinator-health.json' };
  }

  const score = typeof data.health_score === 'number' ? data.health_score : null;
  return {
    score,
    status: scoreToStatus(score),
    source: 'coordinator-health.json',
    generated_at: data.generated_at || null,
    active_agents: data.summary?.active ?? 0,
    held_locks: data.summary?.held_locks ?? 0,
    stale_agents: data.summary?.stale ?? 0,
    warnings: data.warnings || [],
  };
}

// ─── 动作建议生成 ─────────────────────────────────────────────────────────────

/**
 * 基于各组件状态，生成 actions_needed 建议列表。
 * @param {{ harness, knowledge, entropy, coordinator }} components
 * @returns {string[]}
 */
function buildActions(components) {
  const actions = [];

  if (components.harness.status === 'unknown') {
    actions.push('运行 `node .agent/skills/self-check/scripts/index.js check` 生成 harness 基线');
  } else if (components.harness.status === 'critical') {
    actions.push(`Harness 检查失败，查看 self-check-report.json 中的 failed_areas：${(components.harness.failed_areas || []).join(', ') || '（见文件）'}`);
  } else if (components.harness.status === 'warning') {
    actions.push(`Harness 有漂移（${components.harness.drift_level}），建议运行 \`/agent-update\` 修复`);
  }

  if (components.knowledge.status === 'unknown') {
    actions.push('运行 `node .agent/skills/knowledge-lint/scripts/index.js` 生成 knowledge 基线');
  } else if (components.knowledge.status !== 'healthy') {
    const issues = [];
    if (components.knowledge.broken_links > 0) issues.push(`${components.knowledge.broken_links} 个断链`);
    if (components.knowledge.broken_anchors > 0) issues.push(`${components.knowledge.broken_anchors} 个失效锚点`);
    if (components.knowledge.missing_readmes > 0) issues.push(`${components.knowledge.missing_readmes} 个缺失 README`);
    if (issues.length > 0) {
      actions.push(`Knowledge 结构问题（${issues.join('、')}），运行知识 lint 修复`);
    }
  }

  if (components.entropy.status === 'unknown') {
    actions.push('entropy-report.json 不存在，建议运行 `/ship` 后自动生成');
  } else if (components.entropy.l1_pending > 0) {
    actions.push(`有 ${components.entropy.l1_pending} 条熵偏差待人工确认（L1），建议运行 \`/update-refs\``);
  }

  if (components.coordinator.status === 'unknown') {
    actions.push('运行 `node .agent/registry/scripts/coordinator-health.js` 生成 coordinator 基线');
  } else if (components.coordinator.stale_agents > 0) {
    actions.push(`有 ${components.coordinator.stale_agents} 个 stale agent，运行 \`node .agent/registry/scripts/agent-registry.js sweep-stale\` 清理`);
  } else if (components.coordinator.held_locks > 0) {
    actions.push(`有 ${components.coordinator.held_locks} 个锁被持有，检查是否有僵尸 agent`);
  }

  return actions;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

function run() {
  console.log('--- Runtime Evidence: Generate Summary ---');

  // 解析各组件
  const harness = parseHarness();
  const knowledge = parseKnowledge();
  const entropy = parseEntropy();
  const coordinator = parseCoordinator();

  // 汇总
  const componentList = [harness, knowledge, entropy, coordinator];
  const statuses = componentList.map((c) => c.status);
  const healthStatus = computeHealthStatus(statuses);
  const healthScore = computeOverallScore(componentList);
  const actionsNeeded = buildActions({ harness, knowledge, entropy, coordinator });

  const now = new Date();
  const nextCheck = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // 验证侧由 runtime-evidence runner 拥有：只有它跑过数据集才有资格写
  // overall_status。本脚本只做仓库健康度聚合，**不覆盖**验证结论——
  // 否则「仓库健康」会被读成「应用已验证」，CLEAN 门禁随之静默放行。
  const shell = buildDefaults(now.toISOString())['verification-summary.json'];
  const existing = readJson(OUT) || {};
  const verificationStatus = ['pass', 'fail', 'partial'].includes(existing.overall_status)
    ? existing.overall_status
    : 'not_run';

  const summary = {
    generated_at: now.toISOString(),
    triggered_by: 'generate-summary',
    overall_status: verificationStatus,
    coverage: existing.coverage || shell.coverage,
    results: existing.results || shell.results,
    blockers: existing.blockers || shell.blockers,
    warnings: existing.warnings || shell.warnings,
    repo_health_status: healthStatus,
    repo_health_score: healthScore,
    components: {
      harness: {
        score: harness.score,
        status: harness.status,
        drift_level: harness.drift_level,
        source: harness.source,
        run_at: harness.run_at,
        failed_areas: harness.failed_areas,
        actions_needed: harness.actions_needed,
      },
      knowledge: {
        score: knowledge.score,
        status: knowledge.status,
        source: knowledge.source,
        generated_at: knowledge.generated_at,
        broken_links: knowledge.broken_links,
        broken_anchors: knowledge.broken_anchors,
        missing_readmes: knowledge.missing_readmes,
      },
      entropy: {
        score: entropy.score,
        status: entropy.status,
        source: entropy.source,
        generated_at: entropy.generated_at,
        l0_fixed: entropy.l0_fixed,
        l1_pending: entropy.l1_pending,
        drift_status: entropy.drift_status,
      },
      coordinator: {
        score: coordinator.score,
        status: coordinator.status,
        source: coordinator.source,
        generated_at: coordinator.generated_at,
        active_agents: coordinator.active_agents,
        held_locks: coordinator.held_locks,
        stale_agents: coordinator.stale_agents,
        warnings: coordinator.warnings,
      },
    },
    actions_needed: actionsNeeded,
    next_check_recommended: nextCheck.toISOString(),
  };

  // 确保输出目录存在
  fs.mkdirSync(METRICS_DIR, { recursive: true });

  // 写入文件
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  // 控制台摘要
  const statusEmoji = {
    healthy: '✅',
    warning: '⚠️',
    critical: '🔴',
    unknown: '❓',
  };

  console.log(`\n验证状态: ${verificationStatus}`);
  console.log(`仓库健康度: ${statusEmoji[healthStatus] || ''} ${healthStatus} (${healthScore}/100)\n`);
  console.log('各组件状态:');
  console.log(`  harness     : ${statusEmoji[harness.status] || ''} ${harness.status} (${harness.score ?? 'N/A'}/100)`);
  console.log(`  knowledge   : ${statusEmoji[knowledge.status] || ''} ${knowledge.status} (${knowledge.score ?? 'N/A'}/100)`);
  console.log(`  entropy     : ${statusEmoji[entropy.status] || ''} ${entropy.status} (${entropy.score ?? 'N/A'}/100)`);
  console.log(`  coordinator : ${statusEmoji[coordinator.status] || ''} ${coordinator.status} (${coordinator.score ?? 'N/A'}/100)`);

  if (actionsNeeded.length > 0) {
    console.log('\n待处理动作:');
    actionsNeeded.forEach((action, i) => console.log(`  ${i + 1}. ${action}`));
  } else {
    console.log('\n无待处理动作。');
  }

  console.log(`\n输出: ${path.relative(ROOT, OUT)}`);
}

run();
