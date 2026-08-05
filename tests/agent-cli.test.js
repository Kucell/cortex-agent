"use strict";

// ─── Agent Registry CLI Tests (M-002 MS-003) ──────────────────────────────────
//
// Coverage: lib/agents/cli.js + bin/cli.js subcommand dispatcher.
// End-to-end: spawn `bin/cli.js agent <discover|invoke>` and assert exit /
// stdout / stderr.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m002-ms003-cli-"));
  for (const sub of ["runs", "agents"]) {
    fs.mkdirSync(path.join(root, ".agent", sub), { recursive: true });
  }
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function seedAgent(root, agent_id, overrides = {}) {
  fs.mkdirSync(path.join(root, ".agent/agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, `.agent/agents/${agent_id}.json`),
    JSON.stringify({
      schema_version: 1,
      agent_id,
      role: overrides.role || "implementer",
      model: overrides.model || "MiniMax-M3",
      started_at: overrides.startedAt || "2026-08-03T10:00:00.000Z",
      last_heartbeat: overrides.lastHeartbeat || "2026-08-03T11:00:00.000Z",
      status: overrides.status || "running",
      capabilities: overrides.capabilities || ["schema_design"],
      external: overrides.external || null,
    }),
  );
}

test("agent-cli: agent (no subcommand) exits 2", () => {
  const result = spawnSync("node", [path.join(repoRoot, "bin/cli.js"), "agent"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/subcommand required/.test(result.stderr));
});

test("agent-cli: agent --help exits 0 with usage", () => {
  const result = spawnSync("node", [path.join(repoRoot, "bin/cli.js"), "agent", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.ok(/Usage:/.test(result.stdout));
  assert.ok(/agent discover/.test(result.stdout));
  assert.ok(/agent invoke/.test(result.stdout));
});

test("agent-cli: agent report routes to M-008 (lib/commands.js) — fails on missing service", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "report",
  ], { encoding: "utf8" });
  // M-008 path: tries to spin up coordination service; will fail in tmp dir
  // but exits via the M-008 error path (not our M-002 subcommand dispatcher).
  assert.ok(result.status !== 0);
  // Crucially: stderr should NOT be from M-002 (no "subcommand required" or "M-008")
  assert.ok(!/M-008 coordination runtime/.test(result.stderr));
});

test("agent-cli: agent launch routes to M-008 (lib/commands.js) — does NOT hit M-002 dispatcher", () => {
  // M-008 launch needs --task-id and matching lease; without them it'll fail,
  // but importantly the failure should come from M-008 path, not M-002's "unknown subcommand".
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "launch",
  ], { encoding: "utf8" });
  assert.ok(result.status !== 0);
  // M-002 dispatcher would say "agent launch is owned by M-008 coordination runtime";
  // M-008 path would say something different (e.g., task-id missing).
  // Just assert it's not the M-002 hint message.
  assert.ok(!/agent launch is owned by M-008/.test(result.stderr));
});

test("agent-cli: agent discover with empty store returns 0 hits", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "discover",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 0);
    assert.equal(json.scanned, 0);
  } finally { rmProject(root); }
});

test("agent-cli: agent discover --output json shape", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Worker-A-M001", { capabilities: ["schema_design", "json_schema"] });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "discover",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 1);
    assert.equal(json.agents[0].agent_id, "Worker-A-M001");
    assert.equal(json.agents[0].role, "implementer");
  } finally { rmProject(root); }
});

test("agent-cli: agent discover --json shortcut produces identical shape", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Worker-A");
    const r1 = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "discover",
      "--project", root, "--json",
    ], { encoding: "utf8" });
    const r2 = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "discover",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);
    assert.deepEqual(JSON.parse(r1.stdout), JSON.parse(r2.stdout));
  } finally { rmProject(root); }
});

test("agent-cli: agent discover human output is human-readable", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Worker-A", { capabilities: ["schema_design"] });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "discover",
      "--project", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.ok(/agent discover query=""/.test(result.stdout));
    assert.ok(/Worker-A \(implementer/.test(result.stdout));
    assert.ok(/scanned=\d+ matched=\d+ returned=\d+/.test(result.stdout));
  } finally { rmProject(root); }
});

test("agent-cli: agent discover --capability filters", () => {
  const root = mkProject();
  try {
    seedAgent(root, "schema-agent", { capabilities: ["schema_design"] });
    seedAgent(root, "test-agent", { capabilities: ["testing"] });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "discover",
      "--project", root, "--capability", "schema_design", "--output", "json",
    ], { encoding: "utf8" });
    const json = JSON.parse(result.stdout);
    assert.equal(json.returned, 1);
    assert.equal(json.agents[0].agent_id, "schema-agent");
  } finally { rmProject(root); }
});

test("agent-cli: agent discover --role validates", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "discover",
    "--role", "wizard",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/--role must be one of/.test(result.stderr));
});

test("agent-cli: agent discover --status validates", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "discover",
    "--status", "dancing",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/--status must be one of/.test(result.stderr));
});

test("agent-cli: agent discover --adapter-type validates", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "discover",
    "--adapter-type", "bogus",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/--adapter-type must be one of/.test(result.stderr));
});

test("agent-cli: agent invoke missing agent_id exits 2", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "invoke",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/<agent_id> and <task_description> required/.test(result.stderr));
});

test("agent-cli: agent invoke missing task_description exits 2", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "invoke", "Worker-A",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
});

test("agent-cli: agent invoke non-existent agent exits 3 with error.json", () => {
  const root = mkProject();
  try {
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "invoke", "Ghost", "do X",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.equal(json.error.code, "ERR_AGENT_NOT_FOUND");
    // Verify error.json was written
    const errFile = path.join(root, ".agent/runs", json.run_id, "error.json");
    assert.ok(fs.existsSync(errFile));
  } finally { rmProject(root); }
});

test("agent-cli: agent invoke success path writes result.json + rollback.json", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Local-1", { capabilities: ["schema_design", "code_review"] });
    const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "invoke",
    "Local-1", "review the schema",
    "--capability", "code_review",
    "--project", root, "--output", "json",
  ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.status, "planned");
    assert.equal(json.plan.kind, "internal_call");
    const runDir = path.join(root, ".agent/runs", json.run_id);
    assert.ok(fs.existsSync(path.join(runDir, "result.json")));
    assert.ok(fs.existsSync(path.join(runDir, "rollback.json")));
  } finally { rmProject(root); }
});

test("agent-cli: agent invoke capability mismatch exits 3", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Local-1", { capabilities: ["schema_design"] });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "invoke",
      "Local-1", "do X",
      "--capability", "vision",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.equal(json.error.code, "ERR_CAPABILITY_MISMATCH");
    assert.deepEqual(json.error.missing, ["vision"]);
  } finally { rmProject(root); }
});

test("agent-cli: agent invoke non-invocable status exits 3", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Bad-1", { status: "failed" });
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "invoke",
      "Bad-1", "do X",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 3);
    const json = JSON.parse(result.stdout);
    assert.equal(json.error.code, "ERR_AGENT_NOT_INVOCABLE");
  } finally { rmProject(root); }
});

test("agent-cli: agent invoke with --run-id uses provided id", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Local-1");
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "invoke",
      "Local-1", "do X",
      "--run-id", "R-custom-test",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.run_id, "R-custom-test");
    assert.ok(fs.existsSync(path.join(root, ".agent/runs/R-custom-test/result.json")));
  } finally { rmProject(root); }
});

test("agent-cli: agent invoke --input reads file into plan payload", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Local-1");
    const inputFile = path.join(root, "task.json");
    fs.writeFileSync(inputFile, JSON.stringify({ payload: "hello" }));
    const result = spawnSync("node", [
      path.join(repoRoot, "bin/cli.js"), "agent", "invoke",
      "Local-1", "do X",
      "--input", inputFile,
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.plan.payload.input, JSON.stringify({ payload: "hello" }));
  } finally { rmProject(root); }
});

test("agent-cli: unknown agent subcommand exits 2 with M-002 / M-008 hint", () => {
  const result = spawnSync("node", [
    path.join(repoRoot, "bin/cli.js"), "agent", "forget",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(/unknown agent subcommand/.test(result.stderr));
  assert.ok(/discover, invoke \(M-002/.test(result.stderr));
  assert.ok(/report, launch \(M-008/.test(result.stderr));
});

test("agent-cli: cli-contract advertises agent as split_registry mode", () => {
  const contract = require(path.join(repoRoot, "lib/cli-contract.js"));
  const agent = contract.commands.find((c) => c.name === "agent");
  assert.ok(agent, "agent command must be registered in lib/cli-contract.js");
  assert.equal(agent.mode, "split_registry");
  assert.equal(agent.implemented, true);
  assert.ok(/discover\|invoke\|report\|launch/.test(agent.usage));
});
