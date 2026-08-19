#!/usr/bin/env node
// ─── token-savings-demo (实战项目 token 降耗验证) ─────────────────────────
//
// Uses the cortex-agent repo itself as the 实战项目. Measures two context
// assembly strategies for a single agent task turn:
//   baseline : full base_instructions + full task.json + all 44 skill
//              frontmatter cards injected (current naive behavior).
//   optimized: P-006 core layer + M3 task-state summary + M2 top-3 skills
//              scoped to the task's area.
//
// Token estimate: cjk/1.5 + latin/4 (matches lib/memory/select.js tokenizer).
// Zero dependencies: only node:fs/path. Reads real files; no mocks.

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CCSWITCH = path.join(os.homedir(), ".codex", "cc-switch-model-catalog.json");
const SKILL_DIRS = [
  "templates/zh/.agent/skills",
  "templates/en/.agent/skills",
  "templates/_shared/.agent/skills",
  "templates/general/.agent/skills",
];

function tokenize(s) {
  if (typeof s !== "string") return 0;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = s.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

function loadBaseInstructions() {
  if (!fs.existsSync(CCSWITCH)) return null;
  const cat = JSON.parse(fs.readFileSync(CCSWITCH, "utf8"));
  const arr = Array.isArray(cat) ? cat : (cat.models || cat.providers || []);
  const models = Array.isArray(arr) ? arr : Object.values(arr).flat();
  if (models.length === 0) return null;
  const m = models.find((x) => (x.name || "").includes("terra")) || models[0];
  return m.base_instructions || null;
}

function loadAllSkills() {
  const seen = new Map();
  for (const d of SKILL_DIRS) {
    const full = path.join(ROOT, d);
    if (!fs.existsSync(full)) continue;
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sm = path.join(full, e.name, "SKILL.md");
      if (!fs.existsSync(sm)) continue;
      const text = fs.readFileSync(sm, "utf8");
      const m = text.match(/^---\n([\s\S]*?)\n---/);
      if (!m) continue;
      const fm = m[1];
      const name = ((fm.match(/^name:\s*(.+)$/m) || [])[1] || "").trim() || e.name;
      const area = ((fm.match(/^area:\s*(.+)$/m) || [])[1] || "").trim() || "uncategorized";
      const summary = ((fm.match(/^summary:\s*(.+)$/m) || [])[1] || "").trim();
      if (!seen.has(name)) seen.set(name, { name, area, summary });
    }
  }
  return [...seen.values()];
}

function projectTaskState(task) {
  return {
    task_id: task.task_id,
    title: task.title,
    status: task.status,
    stage: task.stage,
    priority: task.priority,
    owner: task.owner || null,
    subtasks_count: Array.isArray(task.subtasks) ? task.subtasks.length : 0,
    acceptance_criteria: task.acceptance_criteria || [],
    validation_commands: task.validation_commands || [],
  };
}

function areaDistribution(skills) {
  const out = {};
  for (const s of skills) out[s.area] = (out[s.area] || 0) + 1;
  return out;
}

function report(taskId) {
  const base = loadBaseInstructions();
  const taskFile = path.join(ROOT, ".agent", "tasks", taskId + ".json");
  if (!fs.existsSync(taskFile)) {
    process.stderr.write("task file not found: " + taskFile + "\n");
    return null;
  }
  const taskRaw = fs.readFileSync(taskFile, "utf8");
  const task = JSON.parse(taskRaw);
  const skills = loadAllSkills();
  const coreLayer = fs.readFileSync(
    path.join(ROOT, "templates/general/.agent/prompts/system-prompt-core.md"),
    "utf8"
  );

  // baseline
  const baseTok = base ? tokenize(base) : 0;
  const taskTok = tokenize(taskRaw);
  const allSkillCards = skills.map((s) => s.name + " " + s.area + " " + s.summary);
  const skillTok = allSkillCards.reduce((n, s) => n + tokenize(s), 0);
  const baselineTotal = baseTok + taskTok + skillTok;

  // optimized
  const coreTok = tokenize(coreLayer);
  const taskSummary = projectTaskState(task);
  const taskSummaryStr = JSON.stringify(taskSummary, null, 2);
  const taskSummaryTok = tokenize(taskSummaryStr);
  const topN = skills.filter((s) => s.area === "agent-tuning").slice(0, 3);
  const topNCards = topN.map((s) => s.name + " " + s.summary);
  const topNTok = topNCards.reduce((n, s) => n + tokenize(s), 0);
  const optimizedTotal = coreTok + taskSummaryTok + topNTok;

  const saved = baselineTotal - optimizedTotal;
  const pct = baselineTotal > 0 ? (saved / baselineTotal * 100) : 0;

  return {
    task_id: taskId,
    sources: {
      cc_switch: CCSWITCH,
      base_instructions_loaded: base !== null,
    },
    skills: {
      total: skills.length,
      by_area: areaDistribution(skills),
    },
    baseline: {
      base_instructions_chars: base ? base.length : 0,
      base_instructions_tokens: baseTok,
      task_json_chars: taskRaw.length,
      task_json_tokens: taskTok,
      skill_cards_tokens: skillTok,
      total_tokens: baselineTotal,
    },
    optimized: {
      p006_core_layer_chars: coreLayer.length,
      p006_core_layer_tokens: coreTok,
      m3_task_state_chars: taskSummaryStr.length,
      m3_task_state_tokens: taskSummaryTok,
      m2_top_n: topN.length,
      m2_top_n_chars: topNCards.reduce((n, s) => n + s.length, 0),
      m2_top_n_tokens: topNTok,
      total_tokens: optimizedTotal,
    },
    saved_tokens: saved,
    saved_percent: Number(pct.toFixed(1)),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const taskId = args[0] || "T-TCP-001";
  const taskFile = path.join(ROOT, ".agent", "tasks", taskId + ".json");
  if (!fs.existsSync(taskFile)) {
    process.stderr.write("task file not found: " + taskFile + "\n");
    process.exit(2);
  }
  const out = report(taskId);
  if (out) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.stdout.write(
      "\nPer-turn savings: ~" + out.saved_tokens + " tokens (" + out.saved_percent + "%) " +
      "vs full-context injection.\n"
    );
  }
}

module.exports = { report, tokenize, loadBaseInstructions, loadAllSkills, projectTaskState };
