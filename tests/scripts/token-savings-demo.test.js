"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { report, tokenize, loadBaseInstructions, loadAllSkills, projectTaskState } = require("../../scripts/token-savings-demo");

test("tokenize: counts CJK and latin separately", () => {
  assert.equal(tokenize("hello world"), 3);
  assert.equal(tokenize("你好世界你好"), 4);
  assert.equal(tokenize("ab 你好"), 3);
  assert.equal(tokenize(""), 0);
  assert.equal(tokenize(null), 0);
  assert.equal(tokenize(undefined), 0);
});

test("loadBaseInstructions: reads from cc-switch-model-catalog.json", () => {
  const bi = loadBaseInstructions();
  if (fs.existsSync(path.join(os.homedir(), ".codex", "cc-switch-model-catalog.json"))) {
    assert.ok(typeof bi === "string" && bi.length > 1000);
  } else {
    assert.equal(bi, null);
  }
});

test("loadAllSkills: dedupes by name and reports area distribution", () => {
  const skills = loadAllSkills();
  assert.ok(Array.isArray(skills));
  assert.ok(skills.length >= 40, "expected at least 40 unique skills");
  const names = new Set(skills.map((s) => s.name));
  assert.equal(names.size, skills.length);
  for (const s of skills) {
    assert.ok(typeof s.name === "string" && s.name.length > 0);
    assert.ok(["office", "swe", "aiapp", "agent-tuning", "uncategorized"].includes(s.area));
  }
});

test("projectTaskState: returns compact summary with required fields", () => {
  const task = {
    task_id: "T-1", title: "demo", description: "ignored",
    status: "active", stage: "implement", priority: "P0", owner: "root",
    acceptance_criteria: ["a", "b"], dependencies: [], subtasks: ["T-2", "T-3"],
    required_artifacts: [], artifacts: [], gates: [],
    validation_commands: ["node test"],
    created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
  };
  const s = projectTaskState(task);
  assert.equal(s.task_id, "T-1");
  assert.equal(s.title, "demo");
  assert.equal(s.status, "active");
  assert.equal(s.subtasks_count, 2);
  assert.equal("description" in s, false);
  assert.deepEqual(s.validation_commands, ["node test"]);
});

test("report: produces baseline + optimized with savings >= 50% on T-TCP-001", () => {
  if (!fs.existsSync(".agent/tasks/T-TCP-001.json")) return;
  const r = report("T-TCP-001");
  if (r === null) return;
  assert.equal(r.task_id, "T-TCP-001");
  assert.ok(r.skills.total >= 40);
  assert.equal(r.sources.base_instructions_loaded, true);
  assert.ok(r.baseline.base_instructions_tokens > 1000);
  assert.ok(r.baseline.task_json_tokens > 0);
  assert.ok(r.baseline.skill_cards_tokens > 0);
  assert.ok(r.optimized.p006_core_layer_tokens > 0);
  assert.ok(r.optimized.p006_core_layer_tokens < r.baseline.base_instructions_tokens);
  assert.ok(r.optimized.m3_task_state_tokens < r.baseline.task_json_tokens);
  assert.ok(r.optimized.m2_top_n > 0);
  assert.ok(r.optimized.m2_top_n_tokens < r.baseline.skill_cards_tokens);
  assert.ok(r.optimized.total_tokens < r.baseline.total_tokens);
  assert.ok(r.saved_percent >= 50, "expected at least 50% savings, got " + r.saved_percent + "%");
  assert.ok(r.saved_tokens > 0);
});

test("report: returns null for missing task id", () => {
  const r = report("T-DOES-NOT-EXIST");
  assert.equal(r, null);
});
