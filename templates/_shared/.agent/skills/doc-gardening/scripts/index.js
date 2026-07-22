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
        `Repair broken link: ${item.source} -> ${item.target}`,
        'Broken links directly damage knowledge navigation and should be fixed first.',
        [item.source],
        'Update the referenced path or restore the missing file.'
      )
    );
  }

  for (const item of findings.broken_anchors || []) {
    actions.push(
      createAction(
        'P1',
        'anchor-repair',
        `Repair invalid anchor: ${item.source} -> #${item.anchor}`,
        'Anchor drift does not remove files, but it breaks deep links into documentation.',
        [item.source, item.resolved],
        'Update the anchor or align the heading with the reference.'
      )
    );
  }

  for (const item of findings.missing_readmes || []) {
    actions.push(
      createAction(
        'P1',
        'readme-bootstrap',
        `Add knowledge entry point: ${item.path}`,
        'A missing README makes the knowledge domain harder to discover and maintain.',
        [item.path],
        'Add directory responsibilities, entry links, and maintenance boundaries.'
      )
    );
  }

  for (const item of findings.plan_issues || []) {
    actions.push(
      createAction(
        'P1',
        'plan-lifecycle',
        `Reconcile plan lifecycle: ${item.type}`,
        item.message,
        ['.agent/plans/task-progress.md', 'docs/exec-plans/active/', 'docs/exec-plans/completed/'],
        'Sync task-progress with active/completed plan state.'
      )
    );
  }

  for (const item of findings.architecture_doc_mismatches || []) {
    actions.push(
      createAction(
        'P1',
        'architecture-sync',
        `Sync architecture documentation: ${item.name}`,
        'Architecture drift makes future planning and review depend on stale structure.',
        ['docs/architecture.md'],
        'Update docs/architecture.md or remove the stale reference.'
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
  if (actions.length === 0) return 'No gardening action is currently needed.';

  const first = actions[0];
  if (first.category === 'link-repair') return 'Repair broken links first to restore navigation reliability.';
  if (first.category === 'readme-bootstrap') return 'Add missing README entry points first to restore discoverability.';
  if (first.category === 'plan-lifecycle') return 'Reconcile active/completed plan lifecycle first to avoid execution drift.';
  if (first.category === 'architecture-sync') return 'Sync architecture documentation first so planning and review use current structure.';
  return 'Handle quick wins first, then schedule the items that need human judgment.';
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
    recommended_focus: 'Generate knowledge health before running doc-gardening.',
    actions: [
      createAction(
        'P0',
        'missing-input',
        'Run knowledge-lint first',
        'doc-gardening depends on knowledge-health.json as its input.',
        ['.agent/metrics/knowledge-health.json'],
        'Run node .agent/skills/knowledge-lint/scripts/index.js.'
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
