"use strict";

// ─── Codey Adapter Tests (M-003 MS-002 / F-004) ────────────────────────────────
//
// Coverage: lib/agents/adapters/codey.js
//
// Strategy: tests use `bin: process.execPath` (the Node binary) with
// `shell: false`, and pass the fake codey script as the first positional
// arg. The fake script then ignores any codey-specific flags and runs its
// mode-driven response. This matches the claude-code test pattern (see
// tests/agent-adapter-claude-code.test.js) and avoids depending on
// `codey` being resolvable on PATH.
//
// The fake script is parameterized by an env var (FAKE_CODEY_MODE) so each
// test case can drive a different response (success, error, timeout, plain
// text, etc.) without recompiling the script.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

// Importing codey.js triggers its self-register side effect (so the
// registry contains "codey" once the test file loads).
const {
  CodeyAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
} = require("../../lib/agents/adapters/codey");
const { register, reset, get, list, unregister } = require("../../lib/agents/adapters");

// ─── fake codey binary ───────────────────────────────────────────────────────

const FAKE_CODEY_BODY = `#!/usr/bin/env node
'use strict';
// Minimal mock of the Codey CLI for tests. Driven by env vars:
//   FAKE_CODEY_MODE = success | empty | badjson | error-envelope |
//                       hang | exitcode | plain | multiline | stderr
//   FAKE_CODEY_DELAY_MS (optional) — sleep before responding (for hang mode)
//   FAKE_CODEY_NO_NEWLINE (optional) — don't emit trailing \\n on stdout
//                                      (tests the line-accumulator remainder)

const mode = process.env.FAKE_CODEY_MODE || "success";
const delayMs = parseInt(process.env.FAKE_CODEY_DELAY_MS || "0", 10);
const noNewline = process.env.FAKE_CODEY_NO_NEWLINE === "1";

function emit(plain) {
  if (noNewline) {
    process.stdout.write(plain);
  } else {
    process.stdout.write(plain + "\\n");
  }
}
function bail(code, msg) {
  process.stderr.write(msg);
  process.exit(code);
}

// Drain stdin so the parent doesn't block on us.
let drained = 0;
process.stdin.on("data", (c) => { drained += c.length; });
process.stdin.on("end", () => { drained += 0; });

if (mode === "hang") {
  setTimeout(() => emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { too_late: true } })), Math.max(delayMs, 30000));
  return;
}

if (delayMs > 0) setTimeout(() => {}, delayMs);

switch (mode) {
  case "empty":
    process.exit(0);
    break;
  case "badjson":
    emit("this is { not valid json at all");
    process.exit(0);
    break;
  case "error-envelope":
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "rate_limited" } }));
    process.exit(0);
    break;
  case "stderr":
    process.stderr.write("warning: deprecated flag --foo\\n");
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ok-with-warnings", drained_bytes: drained } }));
    process.exit(0);
    break;
  case "exitcode":
    bail(7, "fatal: bad config\\n");
    break;
  case "plain":
    emit("OUT: hello from plain codey");
    process.exit(0);
    break;
  case "multiline":
    // Emit a progress line (not JSON) + a final JSON-RPC response.
    emit("[progress] loading model code-bison …");
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "done", iterations: 3 } }));
    process.exit(0);
    break;
  case "success":
  default:
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello from fake codey", task_received: true, drained_bytes: drained } }));
    process.exit(0);
    break;
}
`;

let _fakeCodeyPath = null;
function installFakeCodey() {
  if (_fakeCodeyPath) return _fakeCodeyPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms002-codey-fakebin-"));
  const file = path.join(dir, "fake-codey.js");
  fs.writeFileSync(file, FAKE_CODEY_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  _fakeCodeyPath = file;
  return _fakeCodeyPath;
}

// Build a CodeyAdapter that spawns the fake script directly (it has a
// shebang + chmod +x so spawn() invokes it as a real binary). The adapter's
// own args (--model / --run-id / --task / …) are passed to the fake
// script, which ignores them and drives its response from FAKE_CODEY_MODE.
function withFreshAdapter(mode = "success", extra = {}) {
  const fake = installFakeCodey();
  return new CodeyAdapter({
    bin: fake,
    shell: false,
    ...extra,
    _test: { mode, fakeScript: fake },
  });
}

// Helper to set the FAKE_CODEY_MODE env for a single test, restoring after.
function withMode(mode, fn) {
  const prev = process.env.FAKE_CODEY_MODE;
  process.env.FAKE_CODEY_MODE = mode;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.FAKE_CODEY_MODE;
    else process.env.FAKE_CODEY_MODE = prev;
  });
}

// ─── project / journal helpers ────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms002-codey-proj-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
function journalFile(root, runId, name) {
  return path.join(root, ".agent-runtime", "dispatch", runId, name);
}
function readJournal(root, runId, name) {
  const f = journalFile(root, runId, name);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// ─── discover / metadata ─────────────────────────────────────────────────────

test("codey: discover() returns correct metadata", () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  const meta = adapter.discover();
  assert.equal(meta.adapter_type, "codey");
  assert.equal(meta.version, ADAPTER_VERSION);
  assert.equal(meta.protocol, ADAPTER_PROTOCOL);
  assert.deepEqual(meta.capabilities, [
    "code_completion",
    "code_chat",
    "text_generation",
    "code_review",
  ]);
  assert.equal(meta.transport, "stdio-line-protocol");
  assert.equal(meta.cli.bin, "codey");
});

test("codey: self-registers as 'codey' in the adapter registry on load", () => {
  assert.ok(list().includes("codey"), "codey should be in the registry");
  const inst = get("codey");
  assert.ok(inst instanceof CodeyAdapter);
});

// ─── health ──────────────────────────────────────────────────────────────────

test("codey: health() returns ok when binary is on PATH (node + fake script)", async () => {
  // bin: process.execPath + shell:false lets health() do `which node`
  // which succeeds on any system.
  const adapter = new CodeyAdapter({ bin: process.execPath, shell: false });
  const h = await adapter.health();
  assert.equal(h.status, "ok");
  assert.equal(h.ready, true);
  assert.equal(h.error, null);
  assert.equal(h.details.bin, process.execPath);
});

test("codey: health() returns down when binary is not in PATH", async () => {
  const adapter = new CodeyAdapter({
    bin: "this-binary-does-not-exist-xyz-12345",
    shell: false,
  });
  const h = await adapter.health();
  assert.equal(h.status, "down");
  assert.equal(h.ready, false);
  assert.match(h.error, /not found|exit/i);
});

// ─── invoke: success path ─────────────────────────────────────────────────────

test("codey: invoke() success — writes request/result/rollback to journal", async () => {
  await withMode("success", async () => {
    const adapter = withFreshAdapter("success");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "hello world", model: "code-bison" },
        { projectRoot: root, runId: "R-codey-success-1", timeout: 10 },
      );
      assert.equal(r.status, "ok");
      assert.equal(r.run_id, "R-codey-success-1");
      assert.equal(r.adapter_type, "codey");
      assert.ok(r.result && r.result.text);
      // Journal artifacts
      assert.ok(fs.existsSync(journalFile(root, "R-codey-success-1", "request.json")));
      assert.ok(fs.existsSync(journalFile(root, "R-codey-success-1", "result.json")));
      assert.ok(fs.existsSync(journalFile(root, "R-codey-success-1", "rollback.json")));
      const result = readJournal(root, "R-codey-success-1", "result.json");
      assert.equal(result.status, "ok");
      assert.ok(result.latency_ms >= 0);
      const rollback = readJournal(root, "R-codey-success-1", "rollback.json");
      assert.equal(rollback.status, "completed");
    } finally { rmProject(root); }
  });
});

// ─── invoke: error paths ──────────────────────────────────────────────────────

test("codey: invoke() badjson — writes error.json with ERR_JSONRPC_PARSE", async () => {
  await withMode("badjson", async () => {
    const adapter = withFreshAdapter("badjson");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-badjson", timeout: 10 },
      );
      assert.equal(r.status, "failed");
      assert.equal(r.error.code, "ERR_JSONRPC_PARSE");
      assert.ok(fs.existsSync(journalFile(root, "R-codey-badjson", "error.json")));
      assert.ok(fs.existsSync(journalFile(root, "R-codey-badjson", "rollback.json")));
    } finally { rmProject(root); }
  });
});

test("codey: invoke() error-envelope — writes error.json with ERR_CODEY_<CODE>", async () => {
  await withMode("error-envelope", async () => {
    const adapter = withFreshAdapter("error-envelope");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-rpcerr", timeout: 10 },
      );
      assert.equal(r.status, "failed");
      assert.equal(r.error.code, "ERR_CODEY_-32001");
      assert.match(r.error.message, /rate_limited/);
    } finally { rmProject(root); }
  });
});

test("codey: invoke() exitcode — writes error.json with ERR_DISPATCH_FAILED", async () => {
  await withMode("exitcode", async () => {
    const adapter = withFreshAdapter("exitcode");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-exit", timeout: 10 },
      );
      assert.equal(r.status, "failed");
      assert.equal(r.error.code, "ERR_DISPATCH_FAILED");
      assert.equal(r.error.exit_code, 7);
      assert.ok(r.error.message.includes("codey exited with code 7"));
    } finally { rmProject(root); }
  });
});

test("codey: invoke() timeout — SIGTERM kills subprocess, writes ERR_DISPATCH_TIMEOUT", async () => {
  await withMode("hang", async () => {
    const adapter = withFreshAdapter("hang");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-hang", timeout: 1 },
      );
      assert.equal(r.status, "timeout");
      assert.equal(r.error.code, "ERR_DISPATCH_TIMEOUT");
    } finally { rmProject(root); }
  });
});

test("codey: invoke() spawn ENOENT — returns ERR_ADAPTER_SPAWN", async () => {
  const adapter = new CodeyAdapter({
    bin: "/this/path/does/not/exist/codey-xyz-9999",
    shell: false,
  });
  const root = mkProject();
  try {
    const r = await adapter.invoke(
      { task: "x" },
      { projectRoot: root, runId: "R-codey-enoent", timeout: 5 },
    );
    assert.equal(r.status, "failed");
    // ENOENT from spawn's error event should be normalized to ERR_ADAPTER_SPAWN
    assert.equal(r.error.code, "ERR_ADAPTER_SPAWN");
  } finally { rmProject(root); }
});

test("codey: invoke() plain mode (OUT: prefix) — wrapped into JSON-RPC envelope", async () => {
  await withMode("plain", async () => {
    const adapter = withFreshAdapter("plain");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "say hi" },
        { projectRoot: root, runId: "R-codey-plain", timeout: 10 },
      );
      assert.equal(r.status, "ok");
      assert.match(r.result.text, /hello from plain codey/);
    } finally { rmProject(root); }
  });
});

test("codey: invoke() multiline (progress + final JSON) — parses last JSON line", async () => {
  await withMode("multiline", async () => {
    const adapter = withFreshAdapter("multiline");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-multi", timeout: 10 },
      );
      assert.equal(r.status, "ok");
      assert.equal(r.result.text, "done");
      assert.equal(r.result.iterations, 3);
    } finally { rmProject(root); }
  });
});

// ─── cancel ──────────────────────────────────────────────────────────────────

test("codey: cancel() returns cancelled:true when subprocess is tracked", async () => {
  await withMode("hang", async () => {
    const adapter = withFreshAdapter("hang");
    const root = mkProject();
    try {
      const invokePromise = adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-cancel", timeout: 30 },
      );
      // Wait briefly for the subprocess to register.
      await new Promise((r) => setTimeout(r, 50));
      const cancelResult = await adapter.cancel("R-codey-cancel");
      assert.equal(cancelResult.cancelled, true);
      // The invoke will eventually resolve with a timeout / failure.
      const final = await invokePromise;
      assert.ok(["timeout", "failed"].includes(final.status));
    } finally { rmProject(root); }
  });
});

test("codey: cancel() returns ERR_NO_RUNNING_SUBPROCESS when unknown", async () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  const r = await adapter.cancel("R-does-not-exist");
  assert.equal(r.cancelled, false);
  assert.equal(r.error.code, "ERR_NO_RUNNING_SUBPROCESS");
});

// ─── report ──────────────────────────────────────────────────────────────────

test("codey: report() reads ok result from journal and surfaces latency_ms", async () => {
  await withMode("success", async () => {
    const adapter = withFreshAdapter("success");
    const root = mkProject();
    try {
      await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-codey-report", timeout: 10 },
      );
      const r = await adapter.report("R-codey-report", { projectRoot: root });
      assert.equal(r.runId, "R-codey-report");
      assert.equal(r.status, "ok");
      assert.equal(r.adapter_type, "codey");
      assert.ok(r.latency_ms >= 0);
      assert.ok(r.result);
    } finally { rmProject(root); }
  });
});

test("codey: report() returns not_found when no journal exists", async () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  const root = mkProject();
  try {
    const r = await adapter.report("R-codey-ghost", { projectRoot: root });
    assert.equal(r.status, "not_found");
  } finally { rmProject(root); }
});

// ─── _parseLineProtocol (unit) ───────────────────────────────────────────────

test("codey: _parseLineProtocol parses the last JSON line", () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  const parsed = adapter._parseLineProtocol([
    "thinking…",
    "loading model",
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "final" } }),
  ]);
  assert.deepEqual(parsed, { jsonrpc: "2.0", id: 1, result: { text: "final" } });
});

test("codey: _parseLineProtocol parses OUT: prefix as text", () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  const parsed = adapter._parseLineProtocol(["OUT: hi from codey"]);
  assert.deepEqual(parsed, { jsonrpc: "2.0", id: 1, result: { text: "hi from codey" } });
});

test("codey: _parseLineProtocol throws on empty input", () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  assert.throws(() => adapter._parseLineProtocol([]), /no stdout lines/);
});

test("codey: _parseLineProtocol throws when no line is parseable", () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  assert.throws(
    () => adapter._parseLineProtocol(["not json at all", "also not json"]),
    /no parseable JSON line/,
  );
});

// ─── _writeErrorAndRollback (unit) ────────────────────────────────────────────

test("codey: _writeErrorAndRollback success path writes error + rollback", () => {
  const adapter = new CodeyAdapter({ bin: "codey" });
  const root = mkProject();
  try {
    const rec = adapter._writeErrorAndRollback(root, "R-codey-wer-ok", {
      run_id: "R-codey-wer-ok",
      agent_id: "A1",
      adapter_type: "codey",
      status: "failed",
      error: { code: "ERR_X", message: "boom" },
      latency_ms: 12,
      written_at: new Date().toISOString(),
    });
    assert.equal(rec.error.code, "ERR_X");
    assert.ok(fs.existsSync(journalFile(root, "R-codey-wer-ok", "error.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-codey-wer-ok", "rollback.json")));
  } finally { rmProject(root); }
});

// ─── e2e: real CLI dispatch (AC #12) ─────────────────────────────────────────

test("codey: e2e via m003-cli — 'cortex-agent agent dispatch-execute codey:<id>' produces a journal", () => {
  const fakeScript = installFakeCodey();
  const root = mkProject();
  const agentsDir = path.join(root, ".agent", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  // Use schema_version: 1 to satisfy the registry's validateEntry check.
  const agentEntry = {
    schema_version: 1,
    agent_id: "Codey-WorkerB-MS002",
    role: "external",
    model: "code-bison",
    started_at: "2026-08-04T00:00:00.000Z",
    last_heartbeat: "2026-08-04T00:00:00.000Z",
    status: "running",
    capabilities: ["code_review"],
    external: { adapter_type: "codey", config_ref: null, credential_ref: null },
  };
  fs.writeFileSync(
    path.join(agentsDir, "Codey-WorkerB-MS002.json"),
    JSON.stringify(agentEntry, null, 2),
    "utf8",
  );

  try {
    const binCli = path.join(__dirname, "..", "..", "bin", "cli.js");
    // We need the m003-cli to know about codey. We pre-load via the
    // bootstrap, AND we also need the dispatch child to use the fake
    // script. The dispatch child uses `bin: "codey"` with shell:true, so
    // we wrap the dispatch with PATH=shim_dir and a `codey` shim.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms002-codey-e2e-"));
    const shim = path.join(shimDir, "codey");
    fs.writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(fakeScript)} "$@"\n`, "utf8");
    fs.chmodSync(shim, 0o755);

    const r = spawnSync("node", [
      "-r", path.join(__dirname, "..", "..", "lib", "agents", "adapters", "codey-pi-bootstrap.js"),
      binCli, "agent", "dispatch-execute",
      "Codey-WorkerB-MS002", "review the schema",
      "--project", root, "--output", "json", "--timeout", "10",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH || ""}`,
        FAKE_CODEY_MODE: "success",
      },
    });
    assert.equal(r.status, 0, `e2e dispatch failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.agent_id, "Codey-WorkerB-MS002");
    assert.equal(json.adapter_type, "codey");
    assert.equal(json.status, "ok");
    assert.ok(json.dispatcher && /m003-cli/.test(json.dispatcher));
    // Journal present
    const runId = json.run_id || json.runId;
    assert.ok(runId, "runId should be present in the response");
    assert.ok(fs.existsSync(journalFile(root, runId, "request.json")));
    assert.ok(fs.existsSync(journalFile(root, runId, "result.json")));
  } finally {
    rmProject(root);
  }
});
