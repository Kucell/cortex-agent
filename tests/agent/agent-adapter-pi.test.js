"use strict";

// ─── Pi Adapter Tests (M-003 MS-002 / F-005) ────────────────────────────────────
//
// Coverage: lib/agents/adapters/pi.js
//
// Strategy: tests use a fake pi binary (a Node script with a shebang and
// chmod +x) so the real pi CLI is NEVER spawned. The fake script is
// parameterized by an env var (FAKE_PI_MODE) so each test case can drive a
// different response (success, error, timeout, plain text, etc.) without
// recompiling the script.
//
// This file mirrors tests/agent-adapter-codey.test.js 1:1 with two
// intentional differences for Pi:
//   1. Default env override is PI_BIN (not CODEY_BIN).
//   2. Pi has a --plain mode that wraps plain-text output into a JSON-RPC
//      envelope (`mode: "plain"`), which gets a dedicated test pair.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

// Importing pi.js triggers its self-register side effect.
const {
  PiAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
} = require("../../lib/agents/adapters/pi");
const { register, reset, get, list } = require("../../lib/agents/adapters");

// ─── fake pi binary ──────────────────────────────────────────────────────────

const FAKE_PI_BODY = `#!/usr/bin/env node
'use strict';
// Minimal mock of the Pi CLI for tests. Driven by env vars:
//   FAKE_PI_MODE = success | empty | badjson | error-envelope |
//                   hang | exitcode | plain | multiline | stderr
//   FAKE_PI_DELAY_MS (optional) — sleep before responding (for hang mode)
//   FAKE_PI_PLAIN (optional) — if "1", the fake CLI ignores --json and
//                              emits plain text on stdout (used to test
//                              pi's --plain mode)

const mode = process.env.FAKE_PI_MODE || "success";
const delayMs = parseInt(process.env.FAKE_PI_DELAY_MS || "0", 10);
const plain = process.env.FAKE_PI_PLAIN === "1";

function emit(plain) {
  process.stdout.write(plain + "\\n");
}
function bail(code, msg) {
  process.stderr.write(msg);
  process.exit(code);
}

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
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "context_too_long" } }));
    process.exit(0);
    break;
  case "stderr":
    process.stderr.write("warning: fallback to default model\\n");
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ok-with-warnings", drained_bytes: drained } }));
    process.exit(0);
    break;
  case "exitcode":
    bail(9, "fatal: no api key\\n");
    break;
  case "plain":
    // The "plain" fake mode intentionally bypasses JSON and emits free-
    // form text. Pi's --plain adapter path should wrap this in JSON-RPC.
    process.stdout.write("Hello from Pi (plain).\\nSecond line of plain text.\\n");
    process.exit(0);
    break;
  case "multiline":
    emit("[pi] connecting to model gpt-4o-mini …");
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "done", rounds: 2 } }));
    process.exit(0);
    break;
  case "success":
  default:
    if (plain) {
      process.stdout.write("Plain pi response — no JSON wrapping here.\\n");
    } else {
      emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello from fake pi", task_received: true, drained_bytes: drained } }));
    }
    process.exit(0);
    break;
}
`;

let _fakePiPath = null;
function installFakePi() {
  if (_fakePiPath) return _fakePiPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms002-pi-fakebin-"));
  const file = path.join(dir, "fake-pi.js");
  fs.writeFileSync(file, FAKE_PI_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  _fakePiPath = file;
  return _fakePiPath;
}

function withFreshAdapter(mode = "success", extra = {}) {
  const fake = installFakePi();
  return new PiAdapter({
    bin: fake,
    shell: false,
    ...extra,
    _test: { mode, fakeScript: fake },
  });
}

function withMode(mode, fn) {
  const prev = process.env.FAKE_PI_MODE;
  process.env.FAKE_PI_MODE = mode;
  return Promise.resolve(fn()).finally(() => {
    if (prev === undefined) delete process.env.FAKE_PI_MODE;
    else process.env.FAKE_PI_MODE = prev;
  });
}

// ─── project / journal helpers ────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms002-pi-proj-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
function journalFile(root, runId, name) {
  return path.join(root, ".agent", "runtime", "dispatch", runId, name);
}
function readJournal(root, runId, name) {
  const f = journalFile(root, runId, name);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// ─── discover / metadata ─────────────────────────────────────────────────────

test("pi: discover() returns correct metadata", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const meta = adapter.discover();
  assert.equal(meta.adapter_type, "pi");
  assert.equal(meta.version, ADAPTER_VERSION);
  assert.equal(meta.protocol, ADAPTER_PROTOCOL);
  assert.deepEqual(meta.capabilities, [
    "chat",
    "text_generation",
    "tool_use",
    "multi_turn",
  ]);
  assert.equal(meta.transport, "stdio-json");
  assert.equal(meta.cli.bin, "pi");
});

test("pi: self-registers as 'pi' in the adapter registry on load", () => {
  assert.ok(list().includes("pi"), "pi should be in the registry");
  const inst = get("pi");
  assert.ok(inst instanceof PiAdapter);
});

// ─── health ──────────────────────────────────────────────────────────────────

test("pi: health() returns ok when binary is on PATH (node + fake script)", async () => {
  const adapter = new PiAdapter({ bin: process.execPath, shell: false });
  const h = await adapter.health();
  assert.equal(h.status, "ok");
  assert.equal(h.ready, true);
  assert.equal(h.error, null);
  assert.equal(h.details.bin, process.execPath);
});

test("pi: health() returns down when binary is not in PATH", async () => {
  const adapter = new PiAdapter({
    bin: "this-binary-does-not-exist-xyz-98765",
    shell: false,
  });
  const h = await adapter.health();
  assert.equal(h.status, "down");
  assert.equal(h.ready, false);
  assert.match(h.error, /not found|exit/i);
});

test("pi: health() respects PI_BIN env override", async () => {
  const prev = process.env.PI_BIN;
  process.env.PI_BIN = process.execPath;
  try {
    const adapter = new PiAdapter(); // no options.bin → falls back to PI_BIN
    assert.equal(adapter.bin, process.execPath);
    const h = await adapter.health();
    assert.equal(h.status, "ok");
  } finally {
    if (prev === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = prev;
  }
});

// ─── invoke: success path ─────────────────────────────────────────────────────

test("pi: invoke() success — writes request/result/rollback to journal", async () => {
  await withMode("success", async () => {
    const adapter = withFreshAdapter("success");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "hello world", model: "gpt-4o-mini" },
        { projectRoot: root, runId: "R-pi-success-1", timeout: 10 },
      );
      assert.equal(r.status, "ok");
      assert.equal(r.run_id, "R-pi-success-1");
      assert.equal(r.adapter_type, "pi");
      assert.ok(r.result && r.result.text);
      // Journal artifacts
      assert.ok(fs.existsSync(journalFile(root, "R-pi-success-1", "request.json")));
      assert.ok(fs.existsSync(journalFile(root, "R-pi-success-1", "result.json")));
      assert.ok(fs.existsSync(journalFile(root, "R-pi-success-1", "rollback.json")));
      const result = readJournal(root, "R-pi-success-1", "result.json");
      assert.equal(result.status, "ok");
      assert.ok(result.latency_ms >= 0);
      const rollback = readJournal(root, "R-pi-success-1", "rollback.json");
      assert.equal(rollback.status, "completed");
    } finally { rmProject(root); }
  });
});

// ─── invoke: error paths ──────────────────────────────────────────────────────

test("pi: invoke() badjson — writes error.json with ERR_JSONRPC_PARSE", async () => {
  await withMode("badjson", async () => {
    const adapter = withFreshAdapter("badjson");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-badjson", timeout: 10 },
      );
      assert.equal(r.status, "failed");
      assert.equal(r.error.code, "ERR_JSONRPC_PARSE");
      assert.ok(fs.existsSync(journalFile(root, "R-pi-badjson", "error.json")));
      assert.ok(fs.existsSync(journalFile(root, "R-pi-badjson", "rollback.json")));
    } finally { rmProject(root); }
  });
});

test("pi: invoke() error-envelope — writes error.json with ERR_PI_<CODE>", async () => {
  await withMode("error-envelope", async () => {
    const adapter = withFreshAdapter("error-envelope");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-rpcerr", timeout: 10 },
      );
      assert.equal(r.status, "failed");
      assert.equal(r.error.code, "ERR_PI_-32002");
      assert.match(r.error.message, /context_too_long/);
    } finally { rmProject(root); }
  });
});

test("pi: invoke() exitcode — writes error.json with ERR_DISPATCH_FAILED", async () => {
  await withMode("exitcode", async () => {
    const adapter = withFreshAdapter("exitcode");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-exit", timeout: 10 },
      );
      assert.equal(r.status, "failed");
      assert.equal(r.error.code, "ERR_DISPATCH_FAILED");
      assert.equal(r.error.exit_code, 9);
      assert.ok(r.error.message.includes("pi exited with code 9"));
    } finally { rmProject(root); }
  });
});

test("pi: invoke() timeout — SIGTERM kills subprocess, writes ERR_DISPATCH_TIMEOUT", async () => {
  await withMode("hang", async () => {
    const adapter = withFreshAdapter("hang");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-hang", timeout: 1 },
      );
      assert.equal(r.status, "timeout");
      assert.equal(r.error.code, "ERR_DISPATCH_TIMEOUT");
    } finally { rmProject(root); }
  });
});

test("pi: invoke() spawn ENOENT — returns ERR_ADAPTER_SPAWN", async () => {
  const adapter = new PiAdapter({
    bin: "/this/path/does/not/exist/pi-xyz-9999",
    shell: false,
  });
  const root = mkProject();
  try {
    const r = await adapter.invoke(
      { task: "x" },
      { projectRoot: root, runId: "R-pi-enoent", timeout: 5 },
    );
    assert.equal(r.status, "failed");
    assert.equal(r.error.code, "ERR_ADAPTER_SPAWN");
  } finally { rmProject(root); }
});

test("pi: invoke() --plain mode — wraps plain text into JSON-RPC envelope", async () => {
  await withMode("success", async () => {
    const prevPlain = process.env.FAKE_PI_PLAIN;
    process.env.FAKE_PI_PLAIN = "1";
    try {
      const adapter = withFreshAdapter("success");
      const root = mkProject();
      try {
        const r = await adapter.invoke(
          { task: "x", plain: true },
          { projectRoot: root, runId: "R-pi-plain", timeout: 10 },
        );
        assert.equal(r.status, "ok");
        assert.equal(r.result.mode, "plain");
        assert.match(r.result.text, /Plain pi response/);
      } finally { rmProject(root); }
    } finally {
      if (prevPlain === undefined) delete process.env.FAKE_PI_PLAIN;
      else process.env.FAKE_PI_PLAIN = prevPlain;
    }
  });
});

test("pi: invoke() multiline (progress + final JSON) — parses last JSON line", async () => {
  await withMode("multiline", async () => {
    const adapter = withFreshAdapter("multiline");
    const root = mkProject();
    try {
      const r = await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-multi", timeout: 10 },
      );
      assert.equal(r.status, "ok");
      assert.equal(r.result.text, "done");
      assert.equal(r.result.rounds, 2);
    } finally { rmProject(root); }
  });
});

// ─── cancel ──────────────────────────────────────────────────────────────────

test("pi: cancel() returns cancelled:true when subprocess is tracked", async () => {
  await withMode("hang", async () => {
    const adapter = withFreshAdapter("hang");
    const root = mkProject();
    try {
      const invokePromise = adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-cancel", timeout: 30 },
      );
      await new Promise((r) => setTimeout(r, 50));
      const cancelResult = await adapter.cancel("R-pi-cancel");
      assert.equal(cancelResult.cancelled, true);
      const final = await invokePromise;
      assert.ok(["timeout", "failed"].includes(final.status));
    } finally { rmProject(root); }
  });
});

test("pi: cancel() returns ERR_NO_RUNNING_SUBPROCESS when unknown", async () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const r = await adapter.cancel("R-does-not-exist");
  assert.equal(r.cancelled, false);
  assert.equal(r.error.code, "ERR_NO_RUNNING_SUBPROCESS");
});

// ─── report ──────────────────────────────────────────────────────────────────

test("pi: report() reads ok result from journal and surfaces latency_ms", async () => {
  await withMode("success", async () => {
    const adapter = withFreshAdapter("success");
    const root = mkProject();
    try {
      await adapter.invoke(
        { task: "x" },
        { projectRoot: root, runId: "R-pi-report", timeout: 10 },
      );
      const r = await adapter.report("R-pi-report", { projectRoot: root });
      assert.equal(r.runId, "R-pi-report");
      assert.equal(r.status, "ok");
      assert.equal(r.adapter_type, "pi");
      assert.ok(r.latency_ms >= 0);
      assert.ok(r.result);
    } finally { rmProject(root); }
  });
});

test("pi: report() returns not_found when no journal exists", async () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const root = mkProject();
  try {
    const r = await adapter.report("R-pi-ghost", { projectRoot: root });
    assert.equal(r.status, "not_found");
  } finally { rmProject(root); }
});

// ─── _parseJsonResponse / _parsePlainResponse (unit) ──────────────────────────

test("pi: _parseJsonResponse parses the last JSON line", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const parsed = adapter._parseJsonResponse([
    "thinking…",
    "loading model",
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "final" } }),
  ]);
  assert.deepEqual(parsed, { jsonrpc: "2.0", id: 1, result: { text: "final" } });
});

test("pi: _parseJsonResponse parses OUT: prefix as text", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const parsed = adapter._parseJsonResponse(["OUT: hi from pi"]);
  assert.deepEqual(parsed, { jsonrpc: "2.0", id: 1, result: { text: "hi from pi" } });
});

test("pi: _parseJsonResponse throws on empty input", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  assert.throws(() => adapter._parseJsonResponse([]), /no stdout lines/);
});

test("pi: _parseJsonResponse throws when no line is parseable", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  assert.throws(
    () => adapter._parseJsonResponse(["not json at all", "also not json"]),
    /no parseable JSON line/,
  );
});

test("pi: _parsePlainResponse joins non-empty lines and wraps in JSON-RPC envelope", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const parsed = adapter._parsePlainResponse([
    "Hello from Pi (plain).",
    "Second line of plain text.",
  ]);
  assert.equal(parsed.result.mode, "plain");
  assert.match(parsed.result.text, /Hello from Pi/);
  assert.match(parsed.result.text, /Second line/);
  assert.ok(parsed.result.text.includes("\n"));
});

test("pi: _parsePlainResponse throws on empty input", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  assert.throws(() => adapter._parsePlainResponse([]), /no stdout lines/);
});

test("pi: _parsePlainResponse throws on all-empty lines", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  assert.throws(() => adapter._parsePlainResponse(["", "  ", ""]), /plain mode stdout was all-empty/);
});

// ─── _writeErrorAndRollback (unit) ────────────────────────────────────────────

test("pi: _writeErrorAndRollback success path writes error + rollback", () => {
  const adapter = new PiAdapter({ bin: "pi" });
  const root = mkProject();
  try {
    const rec = adapter._writeErrorAndRollback(root, "R-pi-wer-ok", {
      run_id: "R-pi-wer-ok",
      agent_id: "A1",
      adapter_type: "pi",
      status: "failed",
      error: { code: "ERR_X", message: "boom" },
      latency_ms: 12,
      written_at: new Date().toISOString(),
    });
    assert.equal(rec.error.code, "ERR_X");
    assert.ok(fs.existsSync(journalFile(root, "R-pi-wer-ok", "error.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-pi-wer-ok", "rollback.json")));
  } finally { rmProject(root); }
});

// ─── e2e: real CLI dispatch (AC #12) ─────────────────────────────────────────

test("pi: e2e via m003-cli — 'cortex-agent agent dispatch-execute pi:<id>' produces a journal", () => {
  const fakeScript = installFakePi();
  const root = mkProject();
  const agentsDir = path.join(root, ".agent", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentEntry = {
    schema_version: 1,
    agent_id: "Pi-WorkerB-MS002",
    role: "external",
    model: "gpt-4o-mini",
    started_at: "2026-08-04T00:00:00.000Z",
    last_heartbeat: "2026-08-04T00:00:00.000Z",
    status: "running",
    capabilities: ["chat"],
    external: { adapter_type: "pi", config_ref: null, credential_ref: null },
  };
  fs.writeFileSync(
    path.join(agentsDir, "Pi-WorkerB-MS002.json"),
    JSON.stringify(agentEntry, null, 2),
    "utf8",
  );

  try {
    const binCli = path.join(__dirname, "..", "..", "bin", "cli.js");
    // Build a "pi" shim in a temp dir and prepend it to PATH so the
    // adapter (which spawns `pi` with shell:true by default) finds it.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms002-pi-e2e-"));
    const shim = path.join(shimDir, "pi");
    fs.writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(fakeScript)} "$@"\n`, "utf8");
    fs.chmodSync(shim, 0o755);

    const r = spawnSync("node", [
      "-r", path.join(__dirname, "..", "..", "lib", "agents", "adapters", "codey-pi-bootstrap.js"),
      binCli, "agent", "dispatch-execute",
      "Pi-WorkerB-MS002", "say hi to pi",
      "--project", root, "--output", "json", "--timeout", "10",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH || ""}`,
        FAKE_PI_MODE: "success",
      },
    });
    assert.equal(r.status, 0, `e2e dispatch failed: stderr=${r.stderr}\nstdout=${r.stdout}`);
    const json = JSON.parse(r.stdout);
    assert.equal(json.agent_id, "Pi-WorkerB-MS002");
    assert.equal(json.adapter_type, "pi");
    assert.equal(json.status, "ok");
    assert.ok(json.dispatcher && /m003-cli/.test(json.dispatcher));
    const runId = json.run_id || json.runId;
    assert.ok(runId, "runId should be present in the response");
    assert.ok(fs.existsSync(journalFile(root, runId, "request.json")));
    assert.ok(fs.existsSync(journalFile(root, runId, "result.json")));
  } finally {
    rmProject(root);
  }
});
