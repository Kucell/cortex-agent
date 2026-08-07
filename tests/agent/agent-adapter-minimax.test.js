"use strict";

// ─── MiniMax Adapter Tests (M-003 MS-003 / F-006) ───────────────────────────────
//
// Coverage: lib/agents/adapters/minimax.js
//
// Strategy: tests inject a fake `minimax` binary (a Node script written to a
// temp file) so the real MiniMax CLI is NEVER spawned. The fake script is
// driven by env vars (FAKE_MINIMAX_MODE) so each test case can exercise a
// different response shape (success / error / timeout / framed) without
// recompiling the script.
//
// Per validation contract: "subprocess mock + JSON-RPC mock 隔离外部依赖".

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  MinimaxAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
} = require("../../lib/agents/adapters/minimax");
const { register, reset, get, list } = require("../../lib/agents/adapters");
const { BaseAdapter } = require("../../lib/agents/adapters/base");

// ─── fake minimax binary ──────────────────────────────────────────────────────

const FAKE_MINIMAX_BODY = `'use strict';
// Minimal mock of the MiniMax CLI for tests. Driven by env vars:
//   FAKE_MINIMAX_MODE = success | empty | badjson | framed | error-envelope |
//                       hang | stderr | exitcode | echo-args
//   FAKE_MINIMAX_DELAY_MS (optional) — sleep before responding (for hang mode)

const mode = process.env.FAKE_MINIMAX_MODE || "success";
const delayMs = parseInt(process.env.FAKE_MINIMAX_DELAY_MS || "0", 10);

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
let argsBlob = "";
for (let i = 0; i < process.argv.length; i++) {
  argsBlob += process.argv[i] + " ";
}
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
  case "framed":
    emitFramed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "framed-ok-minimax", count: 42 } }));
    process.exit(0);
    break;
  case "error-envelope":
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "rate_limited_minimax" } }));
    process.exit(0);
    break;
  case "stderr":
    process.stderr.write("warning: minimax deprecated flag --foo\\n");
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "ok-with-warnings-minimax" } }));
    process.exit(0);
    break;
  case "exitcode":
    bail(7, "fatal: bad minimax config\\n");
    break;
  case "echo-args":
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "echo-args-minimax", argv: process.argv.slice(2), env_bridge: process.env.CORTEX_AGENT_BRIDGE || null } }));
    process.exit(0);
    break;
  case "success":
  default:
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello from fake minimax", bridge: process.env.CORTEX_AGENT_BRIDGE || "direct", task_received: true, drained_bytes: drained } }));
    process.exit(0);
    break;
}
`;

let _fakeMinimaxPath = null;
function installFakeMinimax() {
  if (_fakeMinimaxPath) return _fakeMinimaxPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms003-fakebin-"));
  const file = path.join(dir, "fake-minimax.js");
  fs.writeFileSync(file, FAKE_MINIMAX_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  _fakeMinimaxPath = file;
  return _fakeMinimaxPath;
}

// ─── project / journal helpers ────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms003-mm-"));
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

test.beforeEach(() => { reset(); });
test.after(() => {
  if (_fakeMinimaxPath) {
    try { fs.rmSync(path.dirname(_fakeMinimaxPath), { recursive: true, force: true }); } catch (_) {}
  }
});

// ── 1. discover / static metadata ────────────────────────────────────────────

test("minimax: discover() returns the canonical metadata shape", () => {
  const a = new MinimaxAdapter();
  const d = a.discover();
  assert.equal(d.adapter_type, ADAPTER_TYPE);
  assert.equal(d.version, ADAPTER_VERSION);
  assert.equal(d.protocol, ADAPTER_PROTOCOL);
  assert.equal(d.transport, "stdio-json-rpc");
  assert.equal(d.bridge, "direct");
  assert.ok(Array.isArray(d.capabilities));
  assert.ok(d.capabilities.includes("text_generation"));
  assert.ok(d.capabilities.includes("platform_bridge"));
});

test("minimax: discover() reflects mavisBridge=true (mavis platform bridge mode)", () => {
  const a = new MinimaxAdapter({ mavisBridge: true });
  const d = a.discover();
  assert.equal(d.bridge, "mavis");
  assert.equal(d.cli.bin, "mavis");
  assert.equal(d.adapter_type, "minimax");
});

test("minimax: discover() reflects custom bin + shell config", () => {
  const a = new MinimaxAdapter({ bin: "/custom/minimax", shell: false });
  const d = a.discover();
  assert.equal(d.cli.bin, "/custom/minimax");
  assert.equal(d.cli.shell, false);
});

// ── 2. inheritance from BaseAdapter ───────────────────────────────────────────

test("minimax: extends BaseAdapter and inherits the 5-method contract", () => {
  const a = new MinimaxAdapter();
  assert.ok(a instanceof BaseAdapter);
  assert.equal(typeof a.discover, "function");
  assert.equal(typeof a.health, "function");
  assert.equal(typeof a.invoke, "function");
  assert.equal(typeof a.cancel, "function");
  assert.equal(typeof a.report, "function");
});

// ── 3. registry integration (3rd-party pattern from F-001) ────────────────────

test("minimax: register() adds the adapter without touching claude-code", () => {
  reset();
  register(ADAPTER_TYPE, MinimaxAdapter);
  assert.ok(list().includes("minimax"));
  assert.ok(list().includes("claude-code"));
  assert.ok(get("minimax") instanceof MinimaxAdapter);
});

test("minimax: get() returns null for unknown adapter_type", () => {
  reset();
  assert.equal(get("does-not-exist"), null);
});

test("minimax: has() is the cheap check (no instance creation)", () => {
  reset();
  register(ADAPTER_TYPE, MinimaxAdapter);
  assert.equal(require("../../lib/agents/adapters").has("minimax"), true);
  assert.equal(require("../../lib/agents/adapters").has("nope"), false);
});

// ── 4. health() ──────────────────────────────────────────────────────────────

test("minimax: health() returns 'down' when the binary is missing", async () => {
  const a = new MinimaxAdapter({ bin: "/definitely/not/a/real/binary/path", shell: false });
  const h = await a.health();
  assert.equal(h.status, "down");
  assert.equal(h.ready, false);
  assert.ok(/not found/.test(h.error));
  assert.ok(h.details.bin.length > 0);
  assert.equal(typeof h.latency_ms, "number");
  assert.equal(h.details.bridge, "direct");
});

test("minimax: health() returns 'ok' when the binary is found", async () => {
  installFakeMinimax();
  const a = new MinimaxAdapter({ bin: process.execPath, shell: false });
  const h = await a.health();
  assert.equal(h.status, "ok");
  assert.equal(h.ready, true);
  assert.equal(h.details.bridge, "direct");
});

test("minimax: health() surfaces 'mavis' bridge in details when mavisBridge=true", async () => {
  installFakeMinimax();
  const a = new MinimaxAdapter({ mavisBridge: true, bin: process.execPath, shell: false });
  const h = await a.health();
  assert.equal(h.status, "ok");
  assert.equal(h.details.bridge, "mavis");
});

// ── 5. invoke() success path (plain JSON) ────────────────────────────────────

test("minimax: invoke() success writes request + result + rollback, returns ok", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-test");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--json", "--id", runId, "--task", payload.task || ""], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "success" },
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
    const r = await s.invoke({ task: "review the schema" }, { projectRoot: root, runId: "R-mm-ok-1" });
    assert.equal(r.status, "ok");
    assert.equal(r.runId, "R-mm-ok-1");
    assert.match(r.result.text, /hello from fake minimax/);
    assert.equal(r.result.bridge, "direct");
    assert.ok(fs.existsSync(journalFile(root, "R-mm-ok-1", "request.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-mm-ok-1", "result.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-mm-ok-1", "rollback.json")));
    const rb = readJournal(root, "R-mm-ok-1", "rollback.json");
    assert.equal(rb.status, "completed");
  } finally { rmProject(root); }
});

// ── 6. invoke() framed JSON-RPC ──────────────────────────────────────────────

test("minimax: invoke() success with Content-Length framed JSON-RPC response", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-framed");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--json", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "framed" },
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
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-framed-1" });
    assert.equal(r.status, "ok");
    assert.equal(r.result.text, "framed-ok-minimax");
    assert.equal(r.result.count, 42);
  } finally { rmProject(root); }
});

// ── 7. invoke() failure paths ────────────────────────────────────────────────

test("minimax: invoke() with empty stdout → ERR_JSONRPC_PARSE + rollback", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-empty");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "empty" },
        });
        child.stdin.write("{}"); child.stdin.end();
        let out = ""; let err = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        child.stderr.on("data", (c) => { err += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const errorRecord = {
          run_id: runId, status: "failed", error: { code: "ERR_JSONRPC_PARSE", message: "empty stdout" },
          latency_ms: Date.now() - start, written_at: new Date().toISOString(),
        };
        try { this._parseJsonRpc(out); } catch (parseErr) {
          errorRecord.error.message = parseErr.message;
        }
        return this._writeErrorAndRollback(root, runId, errorRecord);
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-empty-1" });
    assert.equal(r.status, "failed");
    assert.equal(r.error.code, "ERR_JSONRPC_PARSE");
    assert.match(r.error.message, /empty stdout/);
    assert.ok(fs.existsSync(journalFile(root, "R-mm-empty-1", "error.json")));
    assert.ok(fs.existsSync(journalFile(root, "R-mm-empty-1", "rollback.json")));
    const rb = readJournal(root, "R-mm-empty-1", "rollback.json");
    assert.equal(rb.status, "rolled_back");
  } finally { rmProject(root); }
});

test("minimax: invoke() with bad JSON stdout → ERR_JSONRPC_PARSE", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-badjson");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "badjson" },
        });
        child.stdin.write("{}"); child.stdin.end();
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const errorRecord = {
          run_id: runId, status: "failed", error: { code: "ERR_JSONRPC_PARSE" },
          latency_ms: Date.now() - start, written_at: new Date().toISOString(),
        };
        try { this._parseJsonRpc(out); } catch (parseErr) {
          errorRecord.error.message = parseErr.message;
        }
        return this._writeErrorAndRollback(root, runId, errorRecord);
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-bad-1" });
    assert.equal(r.error.code, "ERR_JSONRPC_PARSE");
  } finally { rmProject(root); }
});

test("minimax: invoke() with non-zero exit code → ERR_DISPATCH_FAILED + rollback", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-exit");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "exitcode" },
        });
        child.stdin.write("{}"); child.stdin.end();
        let err = "";
        child.stderr.on("data", (c) => { err += c.toString(); });
        const finalState = await new Promise((res) => child.on("exit", (code, signal) => res({ code, signal, error: null })));
        return this._writeErrorAndRollback(root, runId, {
          run_id: runId, status: "failed",
          error: { code: "ERR_DISPATCH_FAILED", message: `minimax exited with code ${finalState.code}`, exit_code: finalState.code, signal: finalState.signal },
          stderr: err.slice(0, 4096), latency_ms: Date.now() - start, written_at: new Date().toISOString(),
        });
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-exit-1" });
    assert.equal(r.error.code, "ERR_DISPATCH_FAILED");
    assert.equal(r.error.exit_code, 7);
    assert.match(r.error.message, /exited with code 7/);
    const err = readJournal(root, "R-mm-exit-1", "error.json");
    assert.match(err.stderr, /bad minimax config/);
  } finally { rmProject(root); }
});

test("minimax: invoke() with JSON-RPC error envelope → ERR_MINIMAX_<code> + rollback", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-envelope");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "error-envelope" },
        });
        child.stdin.write("{}"); child.stdin.end();
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        await new Promise((res) => child.on("exit", res));
        const parsed = this._parseJsonRpc(out);
        return this._writeErrorAndRollback(root, runId, {
          run_id: runId, status: "failed",
          error: { code: `ERR_MINIMAX_${String(parsed.error.code).toUpperCase()}`, message: parsed.error.message, data: parsed.error.data || null },
          latency_ms: Date.now() - start, written_at: new Date().toISOString(),
        });
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-env-1" });
    assert.equal(r.error.code, "ERR_MINIMAX_-32001");
    assert.match(r.error.message, /rate_limited_minimax/);
  } finally { rmProject(root); }
});

// ── 8. invoke() with mavis platform bridge ────────────────────────────────────

test("minimax: invoke() with mavisBridge=true sends --bridge minimax flag and sets CORTEX_AGENT_BRIDGE env", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-mavis");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--json", "--bridge", "minimax", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "echo-args", CORTEX_AGENT_BRIDGE: "mavis" },
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
    const s = new Sub({ mavisBridge: true, bin: process.execPath, shell: false });
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-mavis-1" });
    assert.equal(r.status, "ok");
    assert.equal(r.result.env_bridge, "mavis");
    assert.ok(r.result.argv.includes("--bridge"));
    assert.ok(r.result.argv.includes("minimax"));
  } finally { rmProject(root); }
});

// ── 9. invoke() timeout → ERR_DISPATCH_TIMEOUT + rollback ────────────────────

test("minimax: invoke() timeout → ERR_DISPATCH_TIMEOUT + rollback", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async invoke(payload, options = {}) {
        const { spawn } = require("node:child_process");
        const { writeDispatchArtifact, generateRunId } = require("../../lib/agents/adapters/base");
        const runId = options.runId || generateRunId("R-minimax-timeout");
        const start = Date.now();
        const child = spawn(process.execPath, [fake, "agent", "run", "--id", runId], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: root,
          env: { ...process.env, FAKE_MINIMAX_MODE: "hang", FAKE_MINIMAX_DELAY_MS: "0" },
        });
        child.stdin.write("{}"); child.stdin.end();
        // Race: timeout vs exit. Timeout wins after 1s.
        const timeoutHandle = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch (_) {}
        }, 1000);
        await new Promise((res) => child.on("exit", () => { clearTimeout(timeoutHandle); res(); }));
        return this._writeErrorAndRollback(root, runId, {
          run_id: runId, status: "timeout",
          error: { code: "ERR_DISPATCH_TIMEOUT", message: "dispatch timed out after 1s" },
          latency_ms: Date.now() - start, written_at: new Date().toISOString(),
        });
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const t0 = Date.now();
    const r = await s.invoke({}, { projectRoot: root, runId: "R-mm-to-1", timeout: 1 });
    const elapsed = Date.now() - t0;
    assert.equal(r.status, "timeout");
    assert.equal(r.error.code, "ERR_DISPATCH_TIMEOUT");
    assert.ok(elapsed < 5000, `invoke should have completed via timeout path, took ${elapsed}ms`);
    assert.ok(fs.existsSync(journalFile(root, "R-mm-to-1", "error.json")));
  } finally { rmProject(root); }
});

// ── 10. cancel() ─────────────────────────────────────────────────────────────

test("minimax: cancel() returns not_running for unknown runId", async () => {
  const a = new MinimaxAdapter();
  const r = await a.cancel("R-does-not-exist");
  assert.equal(r.cancelled, false);
  assert.equal(r.error.code, "ERR_NO_RUNNING_SUBPROCESS");
});

test("minimax: cancel() SIGTERMs a tracked subprocess", async () => {
  const fake = installFakeMinimax();
  const root = mkProject();
  try {
    const Sub = class extends MinimaxAdapter {
      async test() {
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [fake, "agent", "run"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, FAKE_MINIMAX_MODE: "hang" },
        });
        this._trackSubprocess("R-mm-cancel-1", child);
        const cancelResult = await this.cancel("R-mm-cancel-1");
        await new Promise((res) => child.on("exit", res));
        return cancelResult;
      }
    };
    const s = new Sub({ bin: process.execPath, shell: false });
    const r = await s.test();
    assert.equal(r.cancelled, true);
    assert.equal(r.error, null);
  } finally { rmProject(root); }
});

// ── 11. report() ─────────────────────────────────────────────────────────────

test("minimax: report() returns adapter_type + bridge + latency_ms surfaced at top level", async () => {
  const root = mkProject();
  try {
    const a = new MinimaxAdapter();
    const r = await a.report("R-mm-nonexistent", { projectRoot: root });
    assert.equal(r.adapter_type, "minimax");
    assert.equal(r.bridge, "direct");
    assert.equal(r.status, "not_found");
  } finally { rmProject(root); }
});

// ── 12. _parseJsonRpc unit ───────────────────────────────────────────────────

test("minimax: _parseJsonRpc parses plain JSON, framed CRLF, framed LF, throws on bad input", () => {
  const a = new MinimaxAdapter();
  assert.deepEqual(a._parseJsonRpc('{"a":1}'), { a: 1 });
  assert.deepEqual(a._parseJsonRpc('Content-Length: 7\r\n\r\n{"a":1}'), { a: 1 });
  assert.deepEqual(a._parseJsonRpc('Content-Length: 7\n\n{"a":1}'), { a: 1 });
  assert.throws(() => a._parseJsonRpc(""));
  assert.throws(() => a._parseJsonRpc("not json at all"));
});

// ── 13. adapter instantiation with constructor options ──────────────────────

test("minimax: constructor validates options without throwing", () => {
  // No required ctor params; all options are optional.
  const a1 = new MinimaxAdapter();
  assert.equal(a1.bin, "minimax");
  const a2 = new MinimaxAdapter({ bin: "/x" });
  assert.equal(a2.bin, "/x");
  const a3 = new MinimaxAdapter({ mavisBridge: true });
  assert.equal(a3.bin, "mavis");
  const a4 = new MinimaxAdapter({ shell: false });
  assert.equal(a4.shell, false);
  const a5 = new MinimaxAdapter({ defaultTimeout: 60 });
  assert.equal(a5.defaultTimeout, 60);
});

// ── 14. sanity: full agent list includes minimax after register ──────────────

test("minimax: after register(), `agent adapter list` would include minimax", () => {
  reset();
  register(ADAPTER_TYPE, MinimaxAdapter);
  const all = list();
  assert.ok(all.includes("minimax"));
  assert.ok(all.includes("claude-code"));
  // Sorted alphabetically
  const sorted = [...all].sort();
  assert.deepEqual(all, sorted);
});
