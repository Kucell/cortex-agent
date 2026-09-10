"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const contract = require("../../lib/runtime-adapters/orchestration-plan.js");

function blockedPlan() {
  return {
    taskId: "T-ORCH-001",
    entry: "mission",
    ownedFiles: ["lib/runtime-adapters/**"],
    resources: ["workflow:agent-orchestration"],
    dependencies: [],
    hostRequirement: { capabilities: ["task.accepted"], degradedAllowed: false },
    gates: { decision: "required", waitpoint: "blocked" },
    result: "blocked",
    blockers: [{ code: "TASK_READBACK_REQUIRED", owner: "/launch-governed-agent", nextAction: "Create and read Task from a new CLI process." }],
  };
}

test("VC-036-001 creates the versioned, read-only OrchestrationPlan contract", () => {
  const plan = contract.createOrchestrationPlan(blockedPlan());
  assert.equal(plan.schemaVersion, "1.0");
  assert.equal(plan.taskId, "T-ORCH-001");
  assert.equal(plan.result, "blocked");
  assert.equal(plan.blockers[0].owner, "/launch-governed-agent");
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.blockers));
});

test("VC-036-001 rejects an entry outside the existing workflow owners", () => {
  const invalid = blockedPlan();
  invalid.entry = "launch-governed-agent";
  assert.throws(() => contract.createOrchestrationPlan(invalid), { code: "ERR_ENTRY_INVALID" });
});

test("VC-036-002 contract module does not become a second runtime owner", () => {
  const source = fs.readFileSync(path.join(ROOT, "lib/runtime-adapters/orchestration-plan.js"), "utf8");
  assert.doesNotMatch(source, /require\(["']node:(fs|child_process|net)["']\)/);
  assert.doesNotMatch(source, /\b(task|lease|operation|run|decision|waitpoint)\s*(?:create|acquire|release|write|submit|transition)/i);
});

test("VC-036-003 and VC-036-004 preserve the L1 boundary in all workflow assets", () => {
  const workflows = [
    ".agent/workflows/agent-orchestration.md",
    "templates/_shared/.agent/workflows/agent-orchestration.md",
    "templates/zh/.agent/workflows/agent-orchestration.md",
    "templates/en/.agent/workflows/agent-orchestration.md",
  ];
  for (const relative of workflows) {
    const content = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(content, /OrchestrationPlan/);
    assert.match(content, /AttemptSettlement/);
    assert.match(content, /cross-process|跨进程/);
    assert.match(content, /must not|不得/);
    assert.doesNotMatch(content, /MINIMAX|pnpm|NuGet|origin\/main|C:\\\\|\/Users\//i);
  }
});

test("VC-036-001 schema stays aligned with the pure contract fields", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "templates/_shared/.agent/dispatch/orchestration-plan.schema.json"), "utf8"));
  for (const field of ["schemaVersion", "taskId", "entry", "ownedFiles", "resources", "dependencies", "hostRequirement", "gates", "result", "blockers"]) {
    assert.ok(schema.required.includes(field), field);
  }
});
