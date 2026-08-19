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

const repoRoot = path.resolve(__dirname, "..", "..");
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

// M-003 MS-004: generic fake CLI binary (body is supplied by the caller).
function makeFakeCli(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms004-fake-"));
  const file = path.join(dir, "fake-cli.js");
  fs.writeFileSync(file, body, "utf8");
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
    const runDir = path.join(root, ".agent", "runtime", "dispatch", runId);
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
    // MS-001 originally used "codex" as a forward-looking placeholder (since
    // MS-002 was scheduled to ship codex). MS-002 now ships codex, so this
    // test uses "cortex" — a valid VALID_ADAPTER_TYPES entry that is never
    // registered as a concrete adapter — to keep the "unregistered adapter"
    // path covered. Test intent (ERR_ADAPTER_NOT_REGISTERED for an unknown
    // adapter_type) is fully preserved — see handoff §deviations.
    seedAgent(root, "Codex-1", {
      external: { adapter_type: "cortex", config_ref: "cfg", credential_ref: "sec" },
    });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Codex-1", "do thing",
      "--project", root, "--output", "json",
    ], { encoding: "utf8" });
    assert.equal(r.status, 3);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error.code, "ERR_ADAPTER_NOT_REGISTERED");
    assert.match(json.error.message, /cortex/);
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
  const { parseArgs } = require("../../lib/agents/m003-cli");
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
  const { parseArgs } = require("../../lib/agents/m003-cli");
  const r = parseArgs(["adapter", "health", "claude-code"]);
  assert.equal(r.subcommand, "adapter");
  assert.equal(r.action, "health");
  assert.equal(r.adapterId, "claude-code");
});

test("m003-cli: parseArgs extracts dispatch-execute agentId + task", () => {
  const { parseArgs } = require("../../lib/agents/m003-cli");
  const r = parseArgs(["dispatch-execute", "Worker-A", "review the schema design"]);
  assert.equal(r.subcommand, "dispatch-execute");
  assert.equal(r.agentId, "Worker-A");
  assert.equal(r.taskDescription, "review the schema design");
});

test("m003-cli: parseArgs extracts --timeout, --run-id, --capability", () => {
  const { parseArgs } = require("../../lib/agents/m003-cli");
  const r = parseArgs([
    "dispatch-execute", "X", "task",
    "--timeout", "60", "--run-id", "R-x", "--capability", "code_review",
  ]);
  assert.equal(r.timeout, 60);
  assert.equal(r.runId, "R-x");
  assert.equal(r._capabilityFlag, "code_review");
});

// ─── M-003 MS-004: parseArgs for 3-protocol flags ─────────────────────────

test("m003-cli: parseArgs extracts --protocol http|cli|file + protocol-specific flags", () => {
  const { parseArgs } = require("../../lib/agents/m003-cli");
  // http
  const r1 = parseArgs([
    "dispatch-execute", "X", "task",
    "--protocol", "http", "--url", "http://localhost:8080/invoke",
  ]);
  assert.equal(r1.protocol, "http");
  assert.equal(r1.url, "http://localhost:8080/invoke");
  // cli
  const r2 = parseArgs([
    "dispatch-execute", "X", "task",
    "--protocol=cli", "--bin", "/path/to/bin", "--arg", "--json", "--arg", "run",
  ]);
  assert.equal(r2.protocol, "cli");
  assert.equal(r2.bin, "/path/to/bin");
  assert.deepEqual(r2.args, ["--json", "run"]);
  // file
  const r3 = parseArgs([
    "dispatch-execute", "X", "task",
    "--protocol", "file", "--config-path", "cfg.json", "--output-path", "out.json",
  ]);
  assert.equal(r3.protocol, "file");
  assert.equal(r3.configPath, "cfg.json");
  assert.equal(r3.outputPath, "out.json");
});

test("m003-cli: parseArgs rejects invalid --protocol values (silently ignored)", () => {
  const { parseArgs } = require("../../lib/agents/m003-cli");
  // Per FAE-001 permissive parsing, unknown values are silently dropped;
  // the protocol is validated in runDispatchExecuteProtocol instead.
  const r = parseArgs(["dispatch-execute", "X", "task", "--protocol", "websocket"]);
  assert.equal(r.protocol, null);
});

// ─── M-003 MS-004: 3-protocol e2e (real CLI) ──────────────────────────────
//
// AC #11: real dispatch 端到端 demo: `cortex-agent agent dispatch-execute
// <agent_id> --protocol {http|cli|file} --payload {...}` 真实可调

test("m003-cli: agent dispatch-execute --protocol cli end-to-end (real CLI, fake binary)", () => {
  const root = mkProject();
  const fake = makeFakeCli(
    `'use strict';
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "from CLI protocol" } }));
  process.exit(0);
});`,
  );
  try {
    seedAgent(root, "Worker-A-MS004-cli", {
      external: { adapter_type: "claude-code", config_ref: "cfg", credential_ref: "sec" },
    });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Worker-A-MS004-cli", "review via cli",
      "--project", root, "--output", "json", "--timeout", "30",
      "--protocol", "cli", "--bin", process.execPath, "--arg", fake.file,
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.status, "ok");
    assert.equal(json.protocol, "cli");
    assert.equal(json.adapter_type, "claude-code");
    assert.equal(json.agent_id, "Worker-A-MS004-cli");
    assert.equal(json.dispatcher, "m003-cli (protocol.cli)");
    assert.match(JSON.stringify(json.result), /from CLI protocol/);
    // Journal artifacts
    const runDir = path.join(root, ".agent", "runtime", "dispatch", json.runId);
    assert.ok(fs.existsSync(path.join(runDir, "request.json")));
    assert.ok(fs.existsSync(path.join(runDir, "result.json")));
    assert.ok(fs.existsSync(path.join(runDir, "rollback.json")));
    const req = JSON.parse(fs.readFileSync(path.join(runDir, "request.json"), "utf8"));
    assert.equal(req.protocol, "cli");
    assert.equal(req.cli.bin, process.execPath);
  } finally { rmProject(root); rmProject(fake.dir); }
});

test("m003-cli: agent dispatch-execute --protocol file end-to-end (real CLI, real config)", () => {
  const root = mkProject();
  const cfgPath = path.join(root, "task-cfg.json");
  const outPath = path.join(root, "task-out.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ task: "x", notes: "from file protocol" }), "utf8");
  try {
    seedAgent(root, "Worker-A-MS004-file", {
      external: { adapter_type: "claude-code", config_ref: "cfg", credential_ref: "sec" },
    });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Worker-A-MS004-file", "review via file",
      "--project", root, "--output", "json", "--timeout", "30",
      "--protocol", "file", "--config-path", cfgPath, "--output-path", outPath,
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.status, "ok");
    assert.equal(json.protocol, "file");
    assert.equal(json.agent_id, "Worker-A-MS004-file");
    assert.equal(json.dispatcher, "m003-cli (protocol.file)");
    // The output file should have been written
    assert.ok(fs.existsSync(outPath), "file protocol output should be written");
    const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
    assert.equal(written.ok, true);
    assert.equal(written.protocol, "file");
  } finally { rmProject(root); }
});

test("m003-cli: agent dispatch-execute --protocol http end-to-end (real CLI, in-process HTTP server)", () => {
  const root = mkProject();
  // In-process HTTP server mimicking an MCP-style endpoint.
  const httpServer = require("node:http");
  const server = httpServer.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c.toString(); });
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, received: body, adapter: "claude-code" }));
    });
  });
  let port = 0;
  // Listen synchronously using a one-shot callback to capture the port.
  const started = new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
  return started.then(() => new Promise((resolve) => {
    try {
      seedAgent(root, "Worker-A-MS004-http", {
        external: { adapter_type: "claude-code", config_ref: "cfg", credential_ref: "sec" },
      });
      const r = spawnSync("node", [
        binCli, "agent", "dispatch-execute",
        "Worker-A-MS004-http", "review via http",
        "--project", root, "--output", "json", "--timeout", "10",
        "--protocol", "http", "--url", `http://127.0.0.1:${port}/claude-code/invoke`,
      ], { encoding: "utf8" });
      assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
      const json = JSON.parse(r.stdout);
      assert.equal(json.status, "ok");
      assert.equal(json.protocol, "http");
      assert.equal(json.agent_id, "Worker-A-MS004-http");
      assert.equal(json.dispatcher, "m003-cli (protocol.http)");
    } finally {
      server.close();
      rmProject(root);
      resolve();
    }
  }));
});

test("m003-cli: agent dispatch-execute --protocol file missing --output-path returns exit 2", () => {
  const root = mkProject();
  const cfgPath = path.join(root, "task-cfg.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");
  try {
    seedAgent(root, "Worker-A-MS004-bad", {
      external: { adapter_type: "claude-code", config_ref: "cfg", credential_ref: "sec" },
    });
    const r = spawnSync("node", [
      binCli, "agent", "dispatch-execute",
      "Worker-A-MS004-bad", "x",
      "--project", root, "--output", "json",
      "--protocol", "file", "--config-path", cfgPath,
    ], { encoding: "utf8" });
    assert.equal(r.status, 2);
    const json = JSON.parse(r.stdout);
    assert.equal(json.error.code, "ERR_FILE_PROTOCOL");
  } finally { rmProject(root); }
});

// ─── M-003 MS-004: §6.2 fix — accept minimax adapter_type ─────────────────

test("m003-cli: §6.2 fix — agent entry with adapter_type 'minimax' is accepted (additive)", () => {
  // M-002's strict VALID_ADAPTER_TYPES doesn't include "minimax"; the §6.2
  // fix adds it via registry-adapter-types.js (additive). This test verifies
  // the additive validator accepts minimax without throwing.
  const { validateAdapterTypeExt } = require("../../lib/agents/registry-adapter-types");
  // Should NOT throw for known types
  assert.doesNotThrow(() => validateAdapterTypeExt("minimax"));
  assert.doesNotThrow(() => validateAdapterTypeExt("claude-code"));
  assert.doesNotThrow(() => validateAdapterTypeExt("custom"));
  // Should throw for unknown types
  assert.throws(
    () => validateAdapterTypeExt("totally-made-up"),
    (err) => err.code === "ERR_INVALID_ADAPTER_TYPE",
  );
});
