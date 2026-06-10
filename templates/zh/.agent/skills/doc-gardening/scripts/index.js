const fs = require('fs');
const path = require('path');

const root = process.cwd();
const metricsDir = path.join(root, '.agent', 'metrics');
const knowledgeHealthPath = path.join(metricsDir, 'knowledge-health.json');
const outputPath = path.join(metricsDir, 'doc-gardening-report.json');

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function readJson(targetPath) {
  return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
}

function writeOutput(payload) {
  ensureDir(metricsDir);
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function createAction(priority, category, title, rationale, files, suggestedAction) {
  return {
    priority,
    category,
    title,
    rationale,
    files,
    suggested_action: suggestedAction,
  };
}

function buildActions(findings) {
  const actions = [];

  for (const item of findings.broken_links || []) {
    actions.push(
      createAction(
        'P0',
        'link-repair',
        `修复断链：${item.source} -> ${item.target}`,
        '断链会直接破坏知识导航，应优先修复。',
        [item.source],
        '更新链接路径，或恢复缺失文件。'
      )
    );
  }

  for (const item of findings.broken_anchors || []) {
    actions.push(
      createAction(
        'P1',
        'anchor-repair',
        `修复失效锚点：${item.source} -> #${item.anchor}`,
        '锚点漂移不会让文件消失，但会让深链引用失效。',
        [item.source, item.resolved],
        '更新锚点，或修正文档标题使其与引用一致。'
      )
    );
  }

  for (const item of findings.missing_readmes || []) {
    actions.push(
      createAction(
        'P1',
        'readme-bootstrap',
        `补知识入口：${item.path}`,
        '缺少 README 会让知识域职责边界不清晰。',
        [item.path],
        '为目录补职责说明、入口链接和维护边界。'
      )
    );
  }

  for (const item of findings.plan_issues || []) {
    actions.push(
      createAction(
        'P1',
        'plan-lifecycle',
        `整理计划生命周期：${item.type}`,
        item.message,
        ['.agent/plans/task-progress.md', 'docs/exec-plans/active/', 'docs/exec-plans/completed/'],
        '同步 task-progress 与 active/completed plan 的状态。'
      )
    );
  }

  for (const item of findings.architecture_doc_mismatches || []) {
    actions.push(
      createAction(
        'P1',
        'architecture-sync',
        `同步架构文档：${item.name}`,
        '架构文档与真实结构失配会导致后续规划和审查失真。',
        ['docs/architecture.md'],
        '更新 docs/architecture.md，或删除已失效引用。'
      )
    );
  }

  return actions;
}

function summarizeActions(actions) {
  return {
    actionable_items: actions.length,
    p0_items: actions.filter((item) => item.priority === 'P0').length,
    p1_items: actions.filter((item) => item.priority === 'P1').length,
    quick_wins: actions.filter((item) => item.category === 'link-repair' || item.category === 'anchor-repair' || item.category === 'readme-bootstrap').length,
    manual_review_items: actions.filter((item) => item.category === 'plan-lifecycle' || item.category === 'architecture-sync').length,
  };
}

function pickStatus(knowledgeScore, actionSummary) {
  if (actionSummary.actionable_items === 0) return 'healthy';
  if (knowledgeScore < 80 || actionSummary.p0_items > 0) return 'attention';
  return 'advisory';
}

function pickRecommendedFocus(actions) {
  if (actions.length === 0) return '当前无需整理动作，维持现有节奏即可。';

  const first = actions[0];
  if (first.category === 'link-repair') return '优先修复断链，先恢复知识导航可达性。';
  if (first.category === 'readme-bootstrap') return '优先补 README 入口，先恢复知识域可发现性。';
  if (first.category === 'plan-lifecycle') return '优先整理 active/completed plan 生命周期，避免执行现场失真。';
  if (first.category === 'architecture-sync') return '优先同步架构文档，避免规划与审查依赖过时结构。';
  return '先处理 quick wins，再安排需要人工判断的结构同步。';
}

function createMissingKnowledgePayload() {
  const payload = {
    scan: 'doc-gardening',
    generated_at: new Date().toISOString(),
    status: 'blocked',
    based_on: {
      knowledge_health_path: '.agent/metrics/knowledge-health.json',
      knowledge_generated_at: null,
      knowledge_score: null,
    },
    summary: {
      actionable_items: 1,
      p0_items: 1,
      p1_items: 0,
      quick_wins: 0,
      manual_review_items: 0,
    },
    recommended_focus: '先生成 knowledge health，再进行 doc-gardening。',
    actions: [
      createAction(
        'P0',
        'missing-input',
        '先运行 knowledge-lint',
        'doc-gardening 依赖 knowledge-health.json 作为输入。',
        ['.agent/metrics/knowledge-health.json'],
        '执行 node .agent/skills/knowledge-lint/scripts/index.js。'
      ),
    ],
  };

  writeOutput(payload);
  return payload;
}

function run() {
  if (!exists(knowledgeHealthPath)) {
    const payload = createMissingKnowledgePayload();
    console.log('--- Doc-Gardening ---');
    console.log('Knowledge health missing. Run knowledge-lint first.');
    console.log(`Output: ${path.relative(root, outputPath)}`);
    return payload;
  }

  const knowledge = readJson(knowledgeHealthPath);
  const actions = buildActions(knowledge.findings || {});
  const summary = summarizeActions(actions);
  const payload = {
    scan: 'doc-gardening',
    generated_at: new Date().toISOString(),
    status: pickStatus(knowledge.health_score || 0, summary),
    based_on: {
      knowledge_health_path: '.agent/metrics/knowledge-health.json',
      knowledge_generated_at: knowledge.generated_at || null,
      knowledge_score: knowledge.health_score || 0,
    },
    summary,
    recommended_focus: pickRecommendedFocus(actions),
    actions,
  };

  writeOutput(payload);

  console.log('--- Doc-Gardening ---');
  console.log(`Knowledge score: ${payload.based_on.knowledge_score}`);
  console.log(`Actionable items: ${summary.actionable_items}`);
  console.log(`P0 items: ${summary.p0_items}`);
  console.log(`Quick wins: ${summary.quick_wins}`);
  console.log(`Status: ${payload.status}`);
  console.log(`Output: ${path.relative(root, outputPath)}`);

  return payload;
}

run();
