"use strict";

// ─── Routing defaults template parity (T-C07) ──────────────────────────────
//
// `routing-defaults.yml` drives the coordinator: which sub-agent a workflow
// dispatches, and which model a handoff should prefer. The framework
// repository keeps the authoritative copy; the L1 templates ship it to every
// managed project.
//
// The split between the two is already drawn: the L1 copies carry what a user
// project needs (workflow pipelines, session continuity, orchestration rules)
// and the framework copy adds the model registry. When the model registry was
// missing from the L1 copies, the template's coordinator promised to order a
// handoff by `model_preference` / `required_capabilities` while having no
// table to consult — the promise had nothing behind it.
//
// This suite pins:
//   - the framework copy and the zh L1 copy are byte-identical
//   - the model registry DATA is identical in all three copies (comments and
//     the translated `selection_rules` prose are locale-specific)
//   - every copy declares the same number of selection rules

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const LIVE = path.join(ROOT, ".agent", "sub-agents", "routing-defaults.yml");
const ZH = path.join(ROOT, "templates", "zh", ".agent", "sub-agents", "routing-defaults.yml");
const EN = path.join(ROOT, "templates", "en", ".agent", "sub-agents", "routing-defaults.yml");
const LIVE_AVAILABLE = fs.existsSync(LIVE);

// The model registry block: from `model_registry:` up to the next top-level key.
function modelRegistryBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^model_registry:\s*$/.test(line));
  assert.notEqual(start, -1, "the file must declare a model_registry block");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// The data of the registry: comments and the translated `selection_rules`
// prose are locale-specific, everything else must match byte for byte.
function modelRegistryData(text) {
  const lines = modelRegistryBlock(text).split("\n");
  const data = [];
  let inRules = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^selection_rules:\s*$/.test(line.trim())) {
      inRules = true;
      data.push("selection_rules:");
      continue;
    }
    if (inRules) continue;
    data.push(line.trim());
  }
  return data.join("\n");
}

function countSelectionRules(text) {
  const block = modelRegistryBlock(text);
  const start = block.split(/\r?\n/).findIndex((line) => /^selection_rules:\s*$/.test(line.trim()));
  assert.notEqual(start, -1, "the registry must declare selection_rules");
  return block
    .split(/\r?\n/)
    .slice(start + 1)
    .filter((line) => /^\s*-\s/.test(line)).length;
}

test("the zh L1 copy is byte-identical to the framework copy", {
  skip: LIVE_AVAILABLE ? false : "the governance repository is not part of this checkout",
}, () => {
  assert.equal(fs.readFileSync(LIVE, "utf8"), fs.readFileSync(ZH, "utf8"));
});

test("every copy ships a model registry", () => {
  for (const file of [ZH, EN]) {
    assert.match(fs.readFileSync(file, "utf8"), /^model_registry:\s*$/m);
  }
});

test("the model registry data is identical in every copy", () => {
  const zhData = modelRegistryData(fs.readFileSync(ZH, "utf8"));
  const enData = modelRegistryData(fs.readFileSync(EN, "utf8"));
  assert.equal(enData, zhData);
  if (LIVE_AVAILABLE) {
    assert.equal(modelRegistryData(fs.readFileSync(LIVE, "utf8")), zhData);
  }
});

test("every copy declares the same number of selection rules", () => {
  const zhRules = countSelectionRules(fs.readFileSync(ZH, "utf8"));
  assert.equal(countSelectionRules(fs.readFileSync(EN, "utf8")), zhRules);
  if (LIVE_AVAILABLE) {
    assert.equal(countSelectionRules(fs.readFileSync(LIVE, "utf8")), zhRules);
  }
  assert.ok(zhRules > 0, "selection_rules must not be empty");
});

test("the registry covers the capabilities the coordinator routes on", () => {
  const data = modelRegistryData(fs.readFileSync(ZH, "utf8"));
  for (const capability of [
    "code_generation", "code_review", "planning", "architecture", "documentation",
    "research", "test_writing", "refactoring", "complex_reasoning", "simple_tasks",
  ]) {
    assert.match(data, new RegExp(`^${capability}:`, "m"), `missing capability: ${capability}`);
  }
  for (const model of ["claude-sonnet", "claude-haiku", "codex"]) {
    assert.match(data, new RegExp(`^${model}:`, "m"), `missing model: ${model}`);
  }
});
