"use strict";

// ─── M-003 CLI Dispatcher Tests (M-003 MS-001) ─────────────────────────────────
//
// Coverage: lib/agents/m003-cli.js + the bin/cli.js subcommand peek for
// `agent adapter <list|health>` and `agent dispatch-execute`.
//
// Per the validation contract AC #9, #10, #11 we end-to-end verify:
//   - `cortex-agent agent adapter list` (real CLI, --output json + human)
//   - `cortex-agent agent adapter health claude-code` (real CLI)
//   - `cortex-agent agent dispatch-execute <id> <task>` end-to-end with a
//     fake claude binary injected via CLAUDE_CODE_BIN (AC #11 — "real dispatch
//     端到端 demo")
//
// The dispatch-execute test seeds an .agent/agents/<id>.json entry with
// external.adapter_type = "claude-code", points CLAUDE_CODE_BIN at a tiny
// Node mock, and runs the full CLI command. We assert the journal is
// populated and the run output contains dispatcher / status / latency_ms.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const binCli = path.join(repoRoot, "bin", "cli.js");

// ─── helpers ────────────────────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms001-m003cli-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
function seedAgent(root, agent_id, overrides = {}) {
  fs.mkdirSync(path.join(root, ".agent", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent", "agents", `${agent_id}.json`),
    JSON.stringify({
      schema_version: 1,
      agent_id,
      role: overrides.role || "external",
      model: overrides.model || "claude-sonnet-4.5",
      started_at: overrides.startedAt || "2026-08-04T00:00:00.000Z",
      last_heartbeat: overrides.lastHeartbeat || "2026-08-04T00:00:00.000Z",
      status: overrides.status || "running",
      capabilities: overrides.capabilities || ["code_review"],
      external: overrides.external !== undefined
        ? overrides.external
        : {
          adapter_type: "claude-code",
          config_ref: "configs/claude.yaml",
          credential_ref: "secret://anthropic",
        },
    }),
  );
}

// Fake claude binary — prints a single-line JSON-RPC response. Matches the
// FAKE_CLAUDE_BODY shape used by the claude-code tests, but kept here as a
// separate file so this test is self-contained.
const FAKE_CLAUDE_BODY = `'use strict';
// Drain stdin so the parent doesn't block.
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello from fake claude (e2e)", ok: true } });
process.stdout.write(body);
process.stdout.write("\\n");
process.exit(0);
`;

function makeFakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms001-fake-"));
  const file = path.join(dir, "fake-claude.js");
  fs.writeFileSync(file, FAKE_CLAUDE_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  return { dir, file };
}

// ─── AC #10: agent adapter list (real CLI) ───────────────────────────────────

test("m003-cli: agent adapter list (real CLI) shows registered adapters", () => {
  const r = spawnSync("node", [binCli, "agent", "adapter", "list"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /agent adapter list/);
  assert.match(r.stdout, /claude-code/);
  assert.match(r.stdout, /external_v1/);
});

test("m003-cli: agent adapter list --json (real CLI) produces JSON shape", () => {
  const r = spawnSync("node", [binCli, "agent", "adapter", "list", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const json = JSON.parse(r.stdout);
  assert.ok(json.count >= 1);
  assert.ok(json.adapters.some((a) => a.adapter_type === "claude-code"));
  const cc = json.adapters.find((a) => a.adapter_type === "claude-code");
  assert.equal(cc.protocol, "external_v1");
  assert.ok(Array.isArray(cc.capabilities));
});

// ─── AC #9: agent adapter health (real CLI) ──────────────────────────────────

test("m003-cli: agent adapter health claude-code (real CLI) outputs status/ready/latency_ms", () => {
  const r = spawnSync("node", [binCli, "agent", "adapter", "health", "claude-code", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  const json = JSON.parse(r.stdout);
  assert.equal(json.adapter_id, "claude-code");
  assert.equal(typeof json.status, "string");
  assert.equal(typeof json.ready, "boolean");
  assert.equal(typeof json.latency_ms, "number");
  // We don't assert status==="ok" because the test env may or may not have
  // a real claude binary. We DO assert the field is one of the canonical
  // values (down → exit 4, anything else → exit 0; we got exit 0).
  assert.ok(["ok", "down", "degraded", "unknown"].includes(json.status));
});

test("m003-cli: agent adapter health <unknown> returns 4 with structured error", () => {
  const r = spawnSync("node", [binCli, "agent", "adapter", "health", "definitely-not-a-real-adapter", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 4);
  const json = JSON.parse(r.stdout);
  assert.equal(json.adapter_id, "definitely-not-a-real-adapter");
  assert.equal(json.status, "down");
  assert.equal(json.ready, false);
  assert.ok(/no adapter registered/.test(json.error));
});

test("m003-cli: agent adapter health without id exits 2", () => {
  const r = spawnSync("node", [binCli, "agent", "adapter", "health"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(/adapter id/i.test(r.stderr));
});

// ─── AC #11: real dispatch e2e (the headline demo) ───────────────────────────

test("m003-cli: agent dispatch-execute end-to-end (real CLI, fake claude binary)", () => {
  const root = mkProject();
  const fake = makeFakeClaude();
  try {
    seedAgent(root, "Worker-A-MS001", {
      capabilities: ["code_review"],
      external: { adapter_type: "claude-code", config_ref: "cfg", credential_ref: "sec" },
    });
    // Tell the adapter to use the fake binary by setting CLAUDE_CODE_BIN
    // (the adapter reads this env var in its constructor). shell:true means
    // the adapter runs `claude ...` via the shell, so we override the
    // binary name with a path.
    // We achieve this by exporting CLAUDE_CODE_BIN=node, then the adapter
    // would spawn `node --json ...` — that won't load our script. Instead
    // we set the binary to a tiny shell shim that runs our script.
    const shim = path.join(fake.dir, "shim.sh");
    fs.writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(fake.file)} "$@"\n`, "utf8");
    fs.chmodSync(shim, 0o755);
    const env = { ...process.env, CLAUDE_CODE_BIN: shim };
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Worker-A-MS001", "review the schema",
      "--project", root, "--output", "json", "--timeout", "30",
    ], { encoding: "utf8", env });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const json = JSON.parse(r.stdout);
    // AC #11 required fields
    assert.equal(json.status, "ok");
    assert.equal(json.agent_id, "Worker-A-MS001");
    assert.equal(json.adapter_type, "claude-code");
    assert.ok(json.dispatcher, "dispatcher field missing");
    assert.equal(typeof json.latency_ms, "number");
    assert.ok(json.result);
    assert.match(json.result.text, /fake claude/);
    // Journal artifacts (note: adapter uses run_id with underscore, per M-002
    // lib/agents/invoke.js convention; m003-cli spreads it unchanged).
    const runId = json.run_id;
    assert.ok(runId, "run_id field missing from dispatch result");
    const runDir = path.join(root, ".agent-runtime", "dispatch", runId);
    assert.ok(fs.existsSync(path.join(runDir, "request.json")), "request.json missing");
    assert.ok(fs.existsSync(path.join(runDir, "result.json")), "result.json missing");
    assert.ok(fs.existsSync(path.join(runDir, "rollback.json")), "rollback.json missing");
  } finally { rmProject(root); rmProject(fake.dir); }
});

test("m003-cli: agent dispatch-execute on missing agent exits 3 with ERR_AGENT_NOT_FOUND", () => {
  const root = mkProject();
  try {
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Ghost-Agent", "do something",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 3);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error.code, "ERR_AGENT_NOT_FOUND");
  } finally { rmProject(root); }
});

test("m003-cli: agent dispatch-execute on first-party agent (no external) returns ERR_NO_ADAPTER", () => {
  const root = mkProject();
  try {
    seedAgent(root, "First-Party-1", { role: "implementer", external: null });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "First-Party-1", "do thing",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 3);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error.code, "ERR_NO_ADAPTER");
  } finally { rmProject(root); }
});

test("m003-cli: agent dispatch-execute on missing adapter (unregistered adapter_type) returns ERR_ADAPTER_NOT_REGISTERED", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Codex-1", {
      external: { adapter_type: "codex", config_ref: "cfg", credential_ref: "sec" },
    });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Codex-1", "do thing",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 3);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error.code, "ERR_ADAPTER_NOT_REGISTERED");
    assert.match(json.error.message, /codex/);
  } finally { rmProject(root); }
});

test("m003-cli: agent dispatch-execute capability mismatch returns ERR_CAPABILITY_MISMATCH", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Cap-Test", { capabilities: ["code_review"] });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Cap-Test", "do thing",
      "--capability", "vision",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 3);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error.code, "ERR_CAPABILITY_MISMATCH");
    assert.deepEqual(json.error.missing, ["vision"]);
  } finally { rmProject(root); }
});

test("m003-cli: agent dispatch-execute without args exits 2", () => {
  const r = spawnSync("node", [binCli, "agent", "dispatch-execute"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.ok(/<agent_id> and <task_description> required/.test(r.stderr));
});

// ─── unknown M-003 subcommand returns clean error ────────────────────────────

test("m003-cli: agent <unknown> still routes to M-002 dispatcher (additive)", () => {
  // The subcommand peek in bin/cli.js routes `adapter` and `dispatch-execute`
  // to M-003; anything else falls through to M-002. This test confirms the
  // M-002 unknown-subcommand error is still surfaced (i.e. we didn't break
  // M-002 by adding the peek).
  const r = spawnSync("node", [binCli, "agent", "nonsense-subcommand"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  // M-002 says "valid: discover, invoke (M-002) | report, launch (M-008)"
  assert.ok(/M-002 Agent Registry/.test(r.stderr) || /M-008 coordination runtime/.test(r.stderr));
});

// ─── M-002 subcommands still work (regression check) ────────────────────────

test("m003-cli: agent discover still works (M-002 unchanged)", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Worker-A", { role: "implementer", capabilities: ["schema_design"] });
    const r = spawnSync("node", [
      binCli, "agent", "discover",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0);
    const json = JSON.parse(r.stdout);
    assert.equal(json.returned, 1);
    assert.equal(json.agents[0].agent_id, "Worker-A");
  } finally { rmProject(root); }
});

test("m003-cli: agent invoke (plan-only) still works (M-002 D-003-7 backward compat)", () => {
  const root = mkProject();
  try {
    seedAgent(root, "Worker-A", {
      role: "implementer", capabilities: ["schema_design"], external: null,
    });
    const r = spawnSync("node", [
      binCli, "agent", "invoke",
      "Worker-A", "review the schema",
      "--capability", "schema_design",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0);
    const json = JSON.parse(r.stdout);
    // M-002 plan-only path: status=planned + plan.kind=internal_call
    assert.equal(json.status, "planned");
    assert.equal(json.plan.kind, "internal_call");
  } finally { rmProject(root); }
});

// ─── parseArgs unit coverage ───────────────────────────────────────────────

test("m003-cli: parseArgs handles --json and --output=json aliases", () => {
  const { parseArgs } = require("../lib/agents/m003-cli");
  const r1 = parseArgs(["adapter", "list", "--json"]);
  assert.equal(r1.outputJson, true);
  assert.equal(r1.outputFormat, "json");
  const r2 = parseArgs(["adapter", "list", "--output", "json"]);
  assert.equal(r2.outputJson, true);
  const r3 = parseArgs(["adapter", "list", "--output=human"]);
  assert.equal(r3.outputJson, false);
  assert.equal(r3.outputFormat, "human");
});

test("m003-cli: parseArgs extracts adapter health id from positionals", () => {
  const { parseArgs } = require("../lib/agents/m003-cli");
  const r = parseArgs(["adapter", "health", "claude-code"]);
  assert.equal(r.subcommand, "adapter");
  assert.equal(r.action, "health");
  assert.equal(r.adapterId, "claude-code");
});

test("m003-cli: parseArgs extracts dispatch-execute agentId + task", () => {
  const { parseArgs } = require("../lib/agents/m003-cli");
  const r = parseArgs(["dispatch-execute", "Worker-A", "review the schema design"]);
  assert.equal(r.subcommand, "dispatch-execute");
  assert.equal(r.agentId, "Worker-A");
  assert.equal(r.taskDescription, "review the schema design");
});

test("m003-cli: parseArgs extracts --timeout, --run-id, --capability", () => {
  const { parseArgs } = require("../lib/agents/m003-cli");
  const r = parseArgs([
    "dispatch-execute", "X", "task",
    "--timeout", "60", "--run-id", "R-x", "--capability", "code_review",
  ]);
  assert.equal(r.timeout, 60);
  assert.equal(r.runId, "R-x");
  assert.equal(r._capabilityFlag, "code_review");
});
