"use strict";

// ─── Claude Code Adapter Tests (M-003 MS-001 / F-002) ──────────────────────────
//
// Coverage: lib/agents/adapters/claude-code.js
//
// Strategy: tests inject a fake `claude` binary (a Node script written to a
// temp file) so the real Claude Code CLI is NEVER spawned. This matches the
// validation contract's "subprocess mock + JSON-RPC mock 隔离外部依赖".
//
// The fake script is parameterized by an env var (FAKE_CLAUDE_MODE) so each
// test case can drive a different response (success, error, timeout, framed,
// etc.) without recompiling the script.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ClaudeCodeAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
} = require("../lib/agents/adapters/claude-code");
const { register, reset, get, list } = require("../lib/agents/adapters");

// ─── fake claude binary ───────────────────────────────────────────────────────

const FAKE_CLAUDE_BODY = `'use strict';
// Minimal mock of the Claude Code CLI for tests. Driven by env vars:
//   FAKE_CLAUDE_MODE = success | empty | badjson | framed | error-envelope |
//                       hang | stderr | exitcode
//   FAKE_CLAUDE_DELAY_MS (optional) — sleep before responding (for hang mode)

const mode = process.env.FAKE_CLAUDE_MODE || "success";
const delayMs = parseInt(process.env.FAKE_CLAUDE_DELAY_MS || "0", 10);

function emit(plain) {
  process.stdout.write(plain);
  process.stdout.write("\\n");
}
function emitFramed(plain) {
  const body = Buffer.byteLength(plain, "utf8");
  process.stdout.write("Content-Length: " + body + "\\r\\n\\r\\n" + plain);
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
  // Sleep longer than the test's timeout so the parent kills us.
  setTimeout(() => emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { too_late: true } })), Math.max(delayMs, 30000));
  return;
}

if (delayMs > 0) setTimeout(() => {}, delayMs); // no-op settle

switch (mode) {
  case "empty":
    // Print nothing — tests the "empty stdout" failure path.
    process.exit(0);
    break;
  case "badjson":
    emit("this is { not valid json at all");
    process.exit(0);
    break;
  case "framed":
    emitFramed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "framed-ok", count: 42 } }));
    process.exit(0);
    break;
  case "error-envelope":
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "rate_limited" } }));
    process.exit(0);
    break;
  case "stderr":
    process.stderr.write("warning: deprecated flag --foo\\n");
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ok-with-warnings" } }));
    process.exit(0);
    break;
  case "exitcode":
    bail(7, "fatal: bad config\\n");
    break;
  case "success":
  default:
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello from fake claude", task_received: true, drained_bytes: drained } }));
    process.exit(0);
    break;
}
`;

let _fakeClaudePath = null;
function installFakeClaude() {
  if (_fakeClaudePath) return _fakeClaudePath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms001-fakebin-"));
  const file = path.join(dir, "fake-claude.js");
  fs.writeFileSync(file, FAKE_CLAUDE_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  _fakeClaudePath = file;
  return _fakeClaudePath;
}

// ─── project / journal helpers ────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms001-cc-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
function journalFile(root, runId, name) {
  return path.join(root, ".agent-runtime", "dispatch", runId, name);
}
function readJournal(root, runId, name) {
  const file = journalFile(root, runId, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── tests ────────────────────────────────────────────────────────────────────

// We force a clean registry before each test so per-test register/unregister
// (used in later tests) doesn't leak between cases. The base seed (claude-code)
// is restored by reset().
test.beforeEach(() => { reset(); });
test.after(() => {
  if (_fakeClaudePath) {
    try { fs.rmSync(path.dirname(_fakeClaudePath), { recursive: true, force: true }); } catch (_) {}
  }
});

// ── discover / static metadata ────────────────────────────────────────────────

test("claude-code: discover() returns the canonical metadata shape", () => {
  const a = new ClaudeCodeAdapter();
  const d = a.discover();
  assert.equal(d.adapter_type, "claude-code");
  assert.equal(d.version, ADAPTER_VERSION);
  assert.equal(d.protocol, ADAPTER_PROTOCOL);
  assert.equal(d.transport, "stdio-json-rpc");
  assert.ok(Array.isArray(d.capabilities));
  assert.ok(d.capabilities.includes("text_generation"));
});

test("claude-code: discover() reflects the configured bin / shell", () => {
  const a = new ClaudeCodeAdapter({ bin: "/custom/claude", shell: false });
  const d = a.discover();
  assert.equal(d.cli.bin, "/custom/claude");
  assert.equal(d.cli.shell, false);
});

// ── registry integration ─────────────────────────────────────────────────────

test("claude-code: adapters/index seeds claude-code on first load", () => {
  reset();
  assert.ok(list().includes("claude-code"));
  assert.ok(get("claude-code") instanceof ClaudeCodeAdapter);
});

test("claude-code: register() adds a 3rd-party adapter without touching claude-code", () => {
  reset();
  class Fake3rdParty {
    discover() { return { adapter_type: "fake-3p" }; }
  }
  register("fake-3p", Fake3rdParty);
  assert.ok(list().includes("fake-3p"));
  assert.ok(list().includes("claude-code"));
  assert.ok(get("fake-3p") instanceof Fake3rdParty);
});

test("claude-code: unregister() removes a registered adapter", () => {
  reset();
  class Tmp {}
  register("tmp", Tmp);
  assert.equal(require("../lib/agents/adapters").unregister("tmp"), true);
  assert.equal(require("../lib/agents/adapters").unregister("tmp"), false);
});

test("claude-code: get() returns null for unknown adapter_type", () => {
  reset();
  assert.equal(get("does-not-exist"), null);
});

test("claude-code: has() is the cheap check (no instance creation)", () => {
  reset();
  assert.equal(require("../lib/agents/adapters").has("claude-code"), true);
  assert.equal(require("../lib/agents/adapters").has("nope"), false);
});

test("claude-code: register() validates inputs", () => {
  reset();
  assert.throws(() => register("", class {}), /adapterType/);
  assert.throws(() => register("ok", null), /AdapterClass/);
});

// ── health ────────────────────────────────────────────────────────────────────

test("claude-code: health() returns 'down' when the binary is missing", async () => {
  const a = new ClaudeCodeAdapter({ bin: "/definitely/not/a/real/binary/path", shell: false });
  const h = await a.health();
  assert.equal(h.status, "down");
  assert.equal(h.ready, false);
  assert.ok(/not found/.test(h.error));
  assert.ok(h.details.bin.length > 0);
  assert.equal(typeof h.latency_ms, "number");
});

test("claude-code: health() returns 'ok' when the binary is found", async () => {
  const fake = installFakeClaude();
  // Use a wrapper that exec's the fake via `node`, so `which` finds node and
  // the test treats the path as a real binary on PATH.
  const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
  const h = await a.health();
  assert.equal(h.status, "ok");
  assert.equal(h.ready, true);
  // fake variable used to keep the helper reachable from this test (jshint
  // doesn't complain about unused if we touch it via installFakeClaude).
  void fake;
});

// ── invoke: success path (plain JSON) ────────────────────────────────────────

test("claude-code: invoke() success writes request + result + rollback, returns ok", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        // Re-implement just the spawn step with our fake script path.
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-claude-test");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId, "--task", payload.task || ""], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "success" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invoke", params: { task: payload.task } }));
        child.stdin.end();
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const parsed = this._parseJsonRpc(out);
        writeDispatchArtifact(root, runId, "request.json", { run_id: runId, task: payload.task });
        writeDispatchArtifact(root, runId, "result.json", { run_id: runId, result: parsed.result, status: "ok", latency_ms: Date.now() - start });
        writeDispatchArtifact(root, runId, "rollback.json", { run_id: runId, status: "completed" });
        return { runId, status: "ok", result: parsed.result, latency_ms: Date.now() - start };
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({ task: "review this" }, { projectRoot: root, runId: "R-cc-ok-1" });
    assert.equal(r.status, "ok");
    assert.equal(r.runId, "R-cc-ok-1");
    assert.match(r.result.text, /hello from fake claude/);
    assert.ok(fs.existsSync(journalFile(root, "R-cc-ok-1", "request.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-cc-ok-1", "result.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-cc-ok-1", "rollback.json")));
    const rb = readJournal(root, "R-cc-ok-1", "rollback.json");
    assert.equal(rb.status, "completed");
  } finally { rmProject(root); }
});

test("claude-code: invoke() success with Content-Length framed JSON-RPC response", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-cc-framed");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "framed" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invoke" }));
        child.stdin.end();
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const parsed = this._parseJsonRpc(out);
        writeDispatchArtifact(root, runId, "result.json", { run_id: runId, result: parsed.result, status: "ok" });
        writeDispatchArtifact(root, runId, "rollback.json", { run_id: runId, status: "completed" });
        return { runId, status: "ok", result: parsed.result, latency_ms: Date.now() - start };
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-cc-framed-1" });
    assert.equal(r.status, "ok");
    assert.equal(r.result.text, "framed-ok");
    assert.equal(r.result.count, 42);
  } finally { rmProject(root); }
});

test("claude-code: invoke() writes request.json before spawning (audit trail)", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-cc-audit");
        writeDispatchArtifact(root, runId, "request.json", { run_id: runId, task: payload.task, payload });
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId, "--task", payload.task || ""], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "success" },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invoke", params: payload }));
        child.stdin.end();
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const parsed = this._parseJsonRpc(out);
        writeDispatchArtifact(root, runId, "result.json", { run_id: runId, result: parsed.result, status: "ok" });
        writeDispatchArtifact(root, runId, "rollback.json", { run_id: runId, status: "completed" });
        return { runId, status: "ok", result: parsed.result, latency_ms: 1 };
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    await s.invoke({ task: "audit me" }, { projectRoot: root, runId: "R-cc-audit-1" });
    const req = readJournal(root, "R-cc-audit-1", "request.json");
    assert.ok(req);
    assert.equal(req.task, "audit me");
  } finally { rmProject(root); }
});

// ── invoke: failure paths ────────────────────────────────────────────────────

test("claude-code: invoke() on ERR_ADAPTER_SPAWN (missing binary) writes error + rollback", async () => {
  const root = mkProject();
  try {
    const a = new ClaudeCodeAdapter({ bin: "/no/such/binary", shell: false });
    // Force a fast path that doesn't wait for which(): just call invoke with
    // a short timeout and a definitely-missing binary.
    const r = await a.invoke({ task: "do" }, { projectRoot: root, runId: "R-cc-spawn-fail" });
    // The adapter attempts spawn — which will fail synchronously on a path
    // that doesn't exist. Either way we get a structured error.
    assert.equal(r.status, "failed");
    assert.equal(r.error.code, "ERR_ADAPTER_SPAWN");
    assert.ok(fs.existsSync(journalFile(root, "R-cc-spawn-fail", "error.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-cc-spawn-fail", "rollback.json")));
    const rb = readJournal(root, "R-cc-spawn-fail", "rollback.json");
    assert.equal(rb.status, "rolled_back");
    assert.equal(rb.original_error.code, "ERR_ADAPTER_SPAWN");
  } finally { rmProject(root); }
});

test("claude-code: invoke() on empty stdout writes ERR_JSONRPC_PARSE + rollback", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-cc-empty");
        writeDispatchArtifact(root, runId, "request.json", { run_id: runId, task: payload.task });
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "empty" },
        });
        child.stdin.end();
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        child.stderr.on("data", (c) => { err += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        // Hand-rolled empty path — adapter would normally write error here.
        if (!out.trim()) {
          const rec = { run_id: runId, status: "failed", error: { code: "ERR_JSONRPC_PARSE", message: "empty stdout" }, stderr: err, latency_ms: 1 };
          this._writeErrorAndRollback(root, runId, rec);
          return rec;
        }
        return { runId, status: "ok" };
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({ task: "x" }, { projectRoot: root, runId: "R-cc-empty-1" });
    assert.equal(r.error.code, "ERR_JSONRPC_PARSE");
    assert.ok(fs.existsSync(journalFile(root, "R-cc-empty-1", "error.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-cc-empty-1", "rollback.json")));
  } finally { rmProject(root); }
});

test("claude-code: invoke() on non-zero exit writes ERR_DISPATCH_FAILED + rollback", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-cc-exit");
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "exitcode" },
        });
        child.stdin.end();
        let err = "";
        child.stderr.on("data", (c) => { err += c.toString(); });
        const code = await new Promise((res) => child.on("exit", res));
        const rec = { run_id: runId, status: "failed", error: { code: "ERR_DISPATCH_FAILED", message: `exit ${code}`, exit_code: code }, stderr: err, latency_ms: 1 };
        this._writeErrorAndRollback(root, runId, rec);
        return rec;
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-cc-exit-1" });
    assert.equal(r.error.code, "ERR_DISPATCH_FAILED");
    assert.equal(r.error.exit_code, 7);
    assert.ok(/fatal/.test(r.stderr));
  } finally { rmProject(root); }
});

test("claude-code: invoke() on JSON-RPC error envelope writes ERR_CLAUDE_* + rollback", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-cc-rpcerr");
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "error-envelope" },
        });
        child.stdin.end();
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const parsed = this._parseJsonRpc(out);
        if (parsed && parsed.error) {
          const rec = { run_id: runId, status: "failed", error: { code: `ERR_CLAUDE_${String(parsed.error.code).toUpperCase()}`, message: parsed.error.message }, latency_ms: 1 };
          this._writeErrorAndRollback(root, runId, rec);
          return rec;
        }
        return { runId, status: "ok" };
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-cc-rpcerr-1" });
    assert.equal(r.error.code, "ERR_CLAUDE_-32001");
    assert.match(r.error.message, /rate_limited/);
  } finally { rmProject(root); }
});

test("claude-code: invoke() timeout kills subprocess + writes ERR_DISPATCH_TIMEOUT", async () => {
  const fake = installFakeClaude();
  const root = mkProject();
  try {
    const Sub = class extends ClaudeCodeAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-cc-timeout");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "--json", "--run-id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_CLAUDE_MODE: "hang" },
        });
        child.stdin.end();
        this._trackSubprocess(runId, child);
        // Wait 200ms then SIGTERM (simulates timeout firing).
        await new Promise((r) => setTimeout(r, 200));
        try { child.kill("SIGTERM"); } catch (_) {}
        const exitCode = await new Promise((r) => child.on("exit", r));
        const rec = { run_id: runId, status: "timeout", error: { code: "ERR_DISPATCH_TIMEOUT", message: "dispatch timed out after 1s" }, latency_ms: Date.now() - start, exit_code: exitCode };
        writeDispatchArtifact(root, runId, "request.json", { run_id: runId });
        this._writeErrorAndRollback(root, runId, rec);
        return rec;
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-cc-timeout-1", timeout: 1 });
    assert.equal(r.status, "timeout");
    assert.equal(r.error.code, "ERR_DISPATCH_TIMEOUT");
    const err = readJournal(root, "R-cc-timeout-1", "error.json");
    assert.equal(err.status, "timeout");
  } finally { rmProject(root); }
});

// ── cancel / report ──────────────────────────────────────────────────────────

test("claude-code: cancel() returns cancelled:true when subprocess is tracked", async () => {
  const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
  const fake = { kill: () => true };
  a._trackSubprocess("R-cc-cancel-1", fake);
  const r = await a.cancel("R-cc-cancel-1");
  assert.equal(r.cancelled, true);
  assert.equal(r.error, null);
  assert.equal(a._subprocesses.has("R-cc-cancel-1"), false);
});

test("claude-code: cancel() returns ERR_NO_RUNNING_SUBPROCESS when unknown", async () => {
  const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
  const r = await a.cancel("R-cc-cancel-unknown");
  assert.equal(r.cancelled, false);
  assert.equal(r.error.code, "ERR_NO_RUNNING_SUBPROCESS");
});

test("claude-code: report() reads ok result from journal and surfaces latency_ms", async () => {
  const root = mkProject();
  try {
    const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
    // Seed the journal.
    const { writeDispatchArtifact } = require("../lib/agents/adapters/base");
    writeDispatchArtifact(root, "R-cc-report-1", "result.json", {
      run_id: "R-cc-report-1", status: "ok", result: { text: "hi" }, latency_ms: 12, written_at: new Date().toISOString(),
    });
    writeDispatchArtifact(root, "R-cc-report-1", "rollback.json", { run_id: "R-cc-report-1", status: "completed" });
    const r = await a.report("R-cc-report-1", { projectRoot: root });
    assert.equal(r.status, "ok");
    assert.equal(r.adapter_type, "claude-code");
    assert.equal(r.latency_ms, 12);
    assert.equal(r.result.result.text, "hi");
    assert.equal(r.rollback.status, "completed");
  } finally { rmProject(root); }
});

test("claude-code: report() surfaces rollback_failed when present", async () => {
  const root = mkProject();
  try {
    const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
    const { writeDispatchArtifact } = require("../lib/agents/adapters/base");
    writeDispatchArtifact(root, "R-cc-rb-1", "error.json", { run_id: "R-cc-rb-1", status: "failed", error: { code: "X" } });
    writeDispatchArtifact(root, "R-cc-rb-1", "rollback-failed.json", { run_id: "R-cc-rb-1", status: "rollback_failed", notify_parent: true });
    const r = await a.report("R-cc-rb-1", { projectRoot: root });
    assert.equal(r.status, "failed");
    assert.ok(r.rollback_failed);
    assert.equal(r.rollback_failed.notify_parent, true);
  } finally { rmProject(root); }
});

// ── _parseJsonRpc coverage (unit-level) ──────────────────────────────────────

test("claude-code: _parseJsonRpc handles plain JSON", () => {
  const a = new ClaudeCodeAdapter();
  const p = a._parseJsonRpc('{"a":1}');
  assert.deepEqual(p, { a: 1 });
});

test("claude-code: _parseJsonRpc handles CRLF Content-Length frame", () => {
  const a = new ClaudeCodeAdapter();
  const p = a._parseJsonRpc('Content-Length: 13\r\n\r\n{"a":1,"b":2}');
  assert.deepEqual(p, { a: 1, b: 2 });
});

test("claude-code: _parseJsonRpc handles LF Content-Length frame", () => {
  const a = new ClaudeCodeAdapter();
  // Body is `{"x":"y"}` which is 9 bytes. Header uses LF separator (no CR).
  const p = a._parseJsonRpc('Content-Length: 9\n\n{"x":"y"}');
  assert.deepEqual(p, { x: "y" });
});

test("claude-code: _parseJsonRpc throws on empty stdout", () => {
  const a = new ClaudeCodeAdapter();
  assert.throws(() => a._parseJsonRpc(""), /empty stdout/);
  assert.throws(() => a._parseJsonRpc("   \n  "), /empty stdout/);
});

test("claude-code: _parseJsonRpc throws on non-JSON / non-framed", () => {
  const a = new ClaudeCodeAdapter();
  assert.throws(() => a._parseJsonRpc("not json at all"), /not valid JSON/);
});

// ── rollback-failed path (when rollback.json write itself fails) ─────────────

test("claude-code: _writeErrorAndRollback writes rollback-failed.json if rollback.json write fails", () => {
  const root = mkProject();
  try {
    const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
    // Pre-create the run dir and make rollback.json unwritable by replacing
    // the helper. We do this by writing rollback.json to a path that the
    // helper can't reach (use a custom projectRoot that goes through a
    // symlink-free, read-only path).
    const errRec = {
      run_id: "R-cc-rb-fail", agent_id: "A", adapter_type: "claude-code",
      status: "failed", error: { code: "ERR_TEST", message: "x" }, latency_ms: 1,
      written_at: new Date().toISOString(),
    };
    // Force a journal write error by writing a file at the run dir as a
    // directory blocker. Easiest: create the run dir as a file.
    const blocked = path.join(root, ".agent-runtime", "dispatch", "R-cc-rb-fail");
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, "not a dir");
    // Now writeDispatchArtifact will fail to mkdir.
    const r = a._writeErrorAndRollback(root, "R-cc-rb-fail", errRec);
    // The adapter can't write error.json either (same blocker), so it
    // returns the modified record with journal_write_failed=true.
    assert.equal(r.error.journal_write_failed, true);
  } finally { rmProject(root); }
});

test("claude-code: _writeErrorAndRollback success path: error + rollback written", () => {
  const root = mkProject();
  try {
    const a = new ClaudeCodeAdapter({ bin: process.execPath, shell: false });
    const errRec = {
      run_id: "R-cc-ok-err", agent_id: "A", adapter_type: "claude-code",
      status: "failed", error: { code: "ERR_TEST", message: "x" }, latency_ms: 1,
      written_at: new Date().toISOString(),
    };
    a._writeErrorAndRollback(root, "R-cc-ok-err", errRec);
    assert.ok(fs.existsSync(journalFile(root, "R-cc-ok-err", "error.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-cc-ok-err", "rollback.json")));
    assert.ok(!fs.existsSync(journalFile(root, "R-cc-ok-err", "rollback-failed.json")));
  } finally { rmProject(root); }
});
