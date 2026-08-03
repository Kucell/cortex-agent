"use strict";

// ─── Agent Invoke Tests (M-002 MS-003) ───────────────────────────────────────

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writeAgent } = require("../lib/agents/registry");
const { invoke, buildInvocationPlan, generateRunId, INVOCABLE_STATUSES, writeRunArtifact } = require("../lib/agents/invoke");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m002-ms003-inv-"));
  for (const sub of ["runs"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seed(root, agent_id, overrides = {}) {
  writeAgent(root, {
    schema_version: 1,
    agent_id,
    role: overrides.role || "implementer",
    model: overrides.model || "MiniMax-M3",
    started_at: overrides.startedAt || "2026-08-03T10:00:00.000Z",
    last_heartbeat: overrides.lastHeartbeat || "2026-08-03T11:00:00.000Z",
    status: overrides.status || "running",
    capabilities: overrides.capabilities || ["schema_design"],
    external: overrides.external || null,
  });
}

test("agent-invoke: INVOCABLE_STATUSES contains 4 statuses", () => {
  assert.deepEqual(
    [...INVOCABLE_STATUSES].sort(),
    ["completed", "handed_off", "paused", "running"],
  );
});

test("agent-invoke: generateRunId has R-agent-invoke- prefix", () => {
  const id = generateRunId();
  assert.match(id, /^R-agent-invoke-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{6}$/);
});

test("agent-invoke: writeRunArtifact writes JSON to .agent/runs/<run_id>/", () => {
  const root = mkProject();
  try {
    const file = writeRunArtifact(root, "R-x", "result.json", { ok: true });
    assert.ok(fs.existsSync(file));
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(back, { ok: true });
  } finally { rmProject(root); }
});

test("agent-invoke: buildInvocationPlan internal_call for first-party agent", () => {
  const entry = {
    agent_id: "Local-1",
    role: "implementer",
    model: "MiniMax-M3",
    capabilities: ["schema_design"],
    external: null,
  };
  const plan = buildInvocationPlan({
    entry,
    taskDescription: "do X",
    input: null,
    timeout: 300,
    requiredCapabilities: ["schema_design"],
  });
  assert.equal(plan.kind, "internal_call");
  assert.equal(plan.target_agent_id, "Local-1");
  assert.equal(plan.entry_point.type, "first_party");
  assert.equal(plan.protocol, "internal_v1");
  assert.equal(plan.timeout, 300);
  assert.deepEqual(plan.required_capabilities, ["schema_design"]);
  assert.deepEqual(plan.declared_capabilities, ["schema_design"]);
  assert.match(plan.notes, /M-003 mission/);
});

test("agent-invoke: buildInvocationPlan external_dispatch for external agent", () => {
  const entry = {
    agent_id: "Claude-1",
    role: "external",
    model: "claude-sonnet-4.5",
    capabilities: ["code_review"],
    external: {
      adapter_type: "claude-code",
      config_ref: "configs/claude.yaml",
      credential_ref: "secret://anthropic",
    },
  };
  const plan = buildInvocationPlan({
    entry,
    taskDescription: "review my PR",
    input: null,
    timeout: 600,
    requiredCapabilities: ["code_review"],
  });
  assert.equal(plan.kind, "external_dispatch");
  assert.equal(plan.target_agent_id, "Claude-1");
  assert.equal(plan.entry_point.type, "external");
  assert.equal(plan.entry_point.adapter_type, "claude-code");
  assert.equal(plan.entry_point.config_ref, "configs/claude.yaml");
  assert.equal(plan.entry_point.credential_ref, "secret://anthropic");
  assert.equal(plan.protocol, "external_v1");
});

test("agent-invoke: missing projectRoot throws", () => {
  assert.throws(
    () => invoke({ agentId: "x", taskDescription: "y" }),
    (err) => err.code === "ERR_PROJECT_ROOT_REQUIRED",
  );
});

test("agent-invoke: missing agentId throws", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => invoke({ projectRoot: root, taskDescription: "y" }),
      (err) => err.code === "ERR_AGENT_ID_REQUIRED",
    );
  } finally { rmProject(root); }
});

test("agent-invoke: missing taskDescription throws", () => {
  const root = mkProject();
  try {
    assert.throws(
      () => invoke({ projectRoot: root, agentId: "x" }),
      (err) => err.code === "ERR_TASK_DESCRIPTION_REQUIRED",
    );
  } finally { rmProject(root); }
});

test("agent-invoke: ERR_AGENT_NOT_FOUND when agent missing", () => {
  const root = mkProject();
  try {
    const result = invoke({
      projectRoot: root,
      agentId: "Ghost",
      taskDescription: "do X",
    });
    assert.ok(result.error);
    assert.equal(result.error.code, "ERR_AGENT_NOT_FOUND");
    assert.ok(fs.existsSync(path.join(root, ".agent/runs", result.run_id, "error.json")));
  } finally { rmProject(root); }
});

test("agent-invoke: ERR_AGENT_NOT_INVOCABLE when status is failed/stale/expired", () => {
  const root = mkProject();
  try {
    seed(root, "Bad-1", { status: "failed" });
    const result = invoke({
      projectRoot: root,
      agentId: "Bad-1",
      taskDescription: "do X",
    });
    assert.equal(result.error.code, "ERR_AGENT_NOT_INVOCABLE");
    assert.match(result.error.message, /failed/);
  } finally { rmProject(root); }
});

test("agent-invoke: ERR_CAPABILITY_MISMATCH when required not in declared", () => {
  const root = mkProject();
  try {
    seed(root, "Local-1", { capabilities: ["schema_design"] });
    const result = invoke({
      projectRoot: root,
      agentId: "Local-1",
      taskDescription: "do X",
      requiredCapabilities: ["schema_design", "vision"],
    });
    assert.equal(result.error.code, "ERR_CAPABILITY_MISMATCH");
    assert.deepEqual(result.error.missing, ["vision"]);
  } finally { rmProject(root); }
});

test("agent-invoke: success path writes result.json + rollback.json + returns plan", () => {
  const root = mkProject();
  try {
    seed(root, "Local-1", { capabilities: ["schema_design", "code_review"] });
    const result = invoke({
      projectRoot: root,
      agentId: "Local-1",
      taskDescription: "review the schema design",
      requiredCapabilities: ["code_review"],
      timeout: 600,
    });
    assert.equal(result.status, "planned");
    assert.equal(result.error, undefined);
    assert.equal(result.plan.kind, "internal_call");
    assert.equal(result.plan.timeout, 600);
    const runDir = path.join(root, ".agent/runs", result.run_id);
    assert.ok(fs.existsSync(path.join(runDir, "result.json")));
    assert.ok(fs.existsSync(path.join(runDir, "rollback.json")));
    const rollback = JSON.parse(fs.readFileSync(path.join(runDir, "rollback.json"), "utf8"));
    assert.equal(rollback.status, "not_applicable");
    assert.match(rollback.reason, /plan-only/);
  } finally { rmProject(root); }
});

test("agent-invoke: explicit runId is honored", () => {
  const root = mkProject();
  try {
    seed(root, "Local-1");
    const result = invoke({
      projectRoot: root,
      runId: "R-custom-1",
      agentId: "Local-1",
      taskDescription: "do X",
    });
    assert.equal(result.run_id, "R-custom-1");
    assert.ok(fs.existsSync(path.join(root, ".agent/runs/R-custom-1/result.json")));
  } finally { rmProject(root); }
});

test("agent-invoke: external agent plan includes adapter metadata", () => {
  const root = mkProject();
  try {
    seed(root, "Claude-1", {
      role: "external",
      capabilities: ["code_review"],
      external: {
        adapter_type: "claude-code",
        config_ref: "configs/claude.yaml",
        credential_ref: "secret://anthropic",
      },
    });
    const result = invoke({
      projectRoot: root,
      agentId: "Claude-1",
      taskDescription: "review",
    });
    assert.equal(result.plan.kind, "external_dispatch");
    assert.equal(result.plan.entry_point.adapter_type, "claude-code");
  } finally { rmProject(root); }
});

test("agent-invoke: input file is read into plan payload", () => {
  const root = mkProject();
  try {
    seed(root, "Local-1");
    const inputFile = path.join(root, "task.json");
    fs.writeFileSync(inputFile, JSON.stringify({ foo: "bar" }));
    const result = invoke({
      projectRoot: root,
      agentId: "Local-1",
      taskDescription: "do X",
      input: JSON.stringify({ foo: "bar" }),
    });
    assert.equal(result.plan.payload.input, JSON.stringify({ foo: "bar" }));
  } finally { rmProject(root); }
});
