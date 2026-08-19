"use strict";

// ─── DSH Adapter Tests (M-029 / P-006 / MS-001) ────────────────────────────────
//
// Coverage: lib/agents/adapters/dsh.js — MS-001 slice.
//
// MS-001 scope (this file):
//   - discover() shape and contents (adapter_type, capabilities, transport,
//     maturity, host, capability_descriptor).
//   - _buildCapabilityDescriptor() passes P-001 capability-contract
//     validation against the frozen vocabulary.
//   - health() returns ready:true when bin resolves via which/where.
//   - health() returns ready:false (status down, ERR_ADAPTER_SPAWN-style
//     envelope) when bin cannot be resolved.
//   - health() honours shell:false + absolute path (deterministic spawn).
//   - health() honours DSH_BIN env override (mirrors CLAUDE_CODE_BIN /
//     PI_BIN / CODEX_BIN / MINIMAX_BIN for vendor parity).
//   - BaseAdapter.report() default returns not_found structure when journal
//     directory is empty (report() full happy-path coverage moves to MS-003).
//
// MS-003 will extend this file with invoke() + 6 failure mode cases; the file
// intentionally stays open and append-only across milestones.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DshAdapter,
  ADAPTER_TYPE,
  ADAPTER_VERSION,
  ADAPTER_PROTOCOL,
  DEFAULT_BIN,
  DEFAULT_TIMEOUT,
} = require("../../lib/agents/adapters/dsh");
const {
  validateCapabilityDescriptor,
  CAPABILITY_NAMES,
} = require("../../lib/runtime-adapters/capability-contract");

// ─── discover() ──────────────────────────────────────────────────────────────

test("dsh adapter: discover() returns the frozen M-029 MS-001 envelope", () => {
  const adapter = new DshAdapter({ bin: "/bin/true", shell: false });
  const meta = adapter.discover();
  assert.equal(meta.adapter_type, ADAPTER_TYPE);
  assert.equal(meta.adapter_type, "dsh");
  assert.equal(meta.version, ADAPTER_VERSION);
  assert.equal(meta.protocol, ADAPTER_PROTOCOL);
  assert.ok(Array.isArray(meta.capabilities) && meta.capabilities.length > 0);
  for (const cap of meta.capabilities) {
    assert.equal(typeof cap, "string");
    assert.ok(cap.length > 0, `capability entry ${cap} must be non-empty`);
  }
  assert.ok(meta.capabilities.includes("text_generation"));
  assert.ok(meta.capabilities.includes("tool_use"));
  assert.equal(meta.transport, "stdio-json-rpc");
  assert.equal(meta.schema.request, 1);
  assert.equal(meta.schema.response, 1);
  assert.equal(meta.schema.journal, 1);
  assert.equal(meta.cli.bin, "/bin/true");
  assert.equal(meta.cli.shell, false);
  assert.equal(meta.maturity, "stable");
  assert.equal(meta.host, "deepseek-harness");
  assert.equal(meta.receipt_contract, "ms-001");
});

test("dsh adapter: discover() defaults CLI to DSH_BIN env override or 'dsh'", () => {
  const prevBin = process.env.DSH_BIN;
  try {
    delete process.env.DSH_BIN;
    const a = new DshAdapter();
    assert.equal(a.bin, DEFAULT_BIN);
    assert.equal(a.bin, "dsh");
    assert.equal(a.defaultTimeout, DEFAULT_TIMEOUT);
    assert.equal(a.defaultTimeout, 300);

    process.env.DSH_BIN = "/custom/path/to/dsh";
    const b = new DshAdapter();
    assert.equal(b.bin, "/custom/path/to/dsh");
  } finally {
    if (prevBin === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = prevBin;
  }
});

// ─── _buildCapabilityDescriptor() — P-001 frozen vocabulary ───────────────────

test("dsh adapter: capability_descriptor validates against P-001 frozen contract", () => {
  const adapter = new DshAdapter({ bin: "/bin/true", shell: false });
  const meta = adapter.discover();
  assert.ok(meta.capability_descriptor, "discover() must include capability_descriptor");
  const validated = validateCapabilityDescriptor(meta.capability_descriptor);
  assert.equal(validated.schema_version, "1.0");
  assert.equal(validated.host.adapter_id, "dsh");
  assert.equal(validated.host.vendor, "deepseek");
  assert.ok(typeof validated.host.version === "string");
  assert.ok(validated.host.version.length > 0);
  assert.ok(typeof validated.detected_at === "string");
  // All 7 P-001 capability names must be present and frozen.
  assert.equal(Object.keys(validated.capabilities).length, CAPABILITY_NAMES.length);
  for (const name of CAPABILITY_NAMES) {
    const c = validated.capabilities[name];
    assert.ok(c, `capability ${name} missing`);
    assert.ok(["native", "adapter", "explicit", "unobservable", "unsupported"].includes(c.level));
    assert.ok(typeof c.source === "string");
  }
  // Promoted from shadow host — tool.before.block must remain explicit 'unsupported'
  // until M-018 verifies a real DSH hook.
  assert.equal(validated.capabilities["tool.before.block"].level, "unsupported");
  assert.equal(validated.capabilities["tool.before.observe"].level, "unsupported");
  assert.equal(validated.capabilities["context.render.observe"].level, "unsupported");
  // session.boundary must remain 'explicit' (DSH session.jsonl.zstd envelope
  // is self-reported and verified by dsh-usage-sync backfill).
  assert.equal(validated.capabilities["session.boundary"].level, "explicit");
});

test("dsh adapter: capability_descriptor entries are frozen", () => {
  const adapter = new DshAdapter({ bin: "/bin/true", shell: false });
  const desc = adapter.discover().capability_descriptor;
  assert.ok(Object.isFrozen(desc));
  assert.ok(Object.isFrozen(desc.host));
  assert.ok(Object.isFrozen(desc.capabilities));
  for (const name of Object.keys(desc.capabilities)) {
    assert.ok(Object.isFrozen(desc.capabilities[name]), `${name} entry must be frozen`);
  }
});

// ─── health() — bin present (POSIX which-style resolution) ────────────────────

test("dsh adapter: health() returns ready=true when bin resolves via which", async () => {
  if (process.platform === "win32") {
    // Skip on Windows — rely on /bin/sh being absent in CI Windows hosts.
    return;
  }
  // `which` itself is always present on POSIX hosts.
  const adapter = new DshAdapter({ bin: "which", shell: false });
  const result = await adapter.health();
  assert.equal(result.status, "ok");
  assert.equal(result.ready, true);
  assert.ok(result.latency_ms >= 0);
  assert.equal(result.error, null);
  assert.equal(result.details.bin, "which");
  assert.equal(result.details.platform, process.platform);
});

test("dsh adapter: health() honours shell:false + PATH-resolvable binary", async () => {
  // Use a binary that is reliably in PATH on dev hosts. We can't use an
  // absolute path with shell:false here because `which <absolute>` resolves
  // only against PATH; this is the same constraint as claude-code / pi
  // health checks and is intentional (M-003 MS-001 risk mitigation).
  if (process.platform === "win32") return;
  const adapter = new DshAdapter({ bin: "ls", shell: false });
  const result = await adapter.health();
  assert.equal(result.status, "ok");
  assert.equal(result.ready, true);
  assert.equal(result.details.bin, "ls");
  assert.equal(result.details.platform, process.platform);
});

// ─── health() — bin absent ────────────────────────────────────────────────────

test("dsh adapter: health() returns ready=false when bin cannot be resolved", async () => {
  const adapter = new DshAdapter({
    bin: "dsh-definitely-not-a-real-binary-xyz-12345",
    shell: false,
  });
  const result = await adapter.health();
  assert.equal(result.status, "down");
  assert.equal(result.ready, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
  assert.ok(result.details.bin.includes("dsh-definitely-not-a-real-binary"));
  assert.ok(result.latency_ms >= 0);
});

// ─── report() — BaseAdapter default not-found contract ────────────────────────

test("dsh adapter: report() returns not_found when journal is missing", async () => {
  // Use a tmp directory that has no journal at all.
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-report-"));
  try {
    const adapter = new DshAdapter({ bin: "/bin/true", shell: false });
    const result = await adapter.report("R-not-found-2026-08-19", { projectRoot });
    assert.equal(result.runId, "R-not-found-2026-08-19");
    assert.equal(result.status, "not_found");
    assert.equal(result.result, null);
    assert.equal(result.error, null);
    assert.equal(result.rollback, null);
    assert.equal(result.rollback_failed, null);
    assert.equal(result.request, null);
    assert.equal(result.written_at, null);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ─── Hard constraint: zero npm deps ───────────────────────────────────────────

test("dsh adapter: implementation uses only Node.js built-ins (no npm deps)", () => {
  // Read the source file and confirm only `node:` prefixed requires exist.
  // (Lightweight syntactic check — full dep audit lives in architecture-guard.)
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "agents", "adapters", "dsh.js"),
    "utf8",
  );
  const requireMatches = src.match(/require\(([^)]+)\)/g) || [];
  for (const m of requireMatches) {
    assert.ok(
      m.includes("\"node:") || m.includes("'node:") || m.includes("\"./") || m.includes("'./"),
      `unexpected require form: ${m} (must be node:* or ./relative)`,
    );
  }
});

// ─── Security boundary: DSH adapter does not read ~/.dsh/sessions/ ───────────

test("dsh adapter: source code paths never read ~/.dsh/sessions/ storage", () => {
  // VC-029-001-04: shadow usage lives in scripts/dsh-usage-sync.js (read-only
  // by design); the dispatch adapter must not open that path in any code
  // branch (discover/health/invoke/cancel/report). Strip block + line
  // comments before scanning so legitimate documentation references are
  // allowed (the doc comment header explicitly enumerates the boundary).
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "..", "lib", "agents", "adapters", "dsh.js"),
    "utf8",
  );
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    !stripped.includes(".dsh/sessions"),
    "dsh adapter code must not read ~/.dsh/sessions/ (shadow usage lives in scripts/dsh-usage-sync.js)",
  );
  assert.ok(
    !stripped.includes("session.jsonl"),
    "dsh adapter code must not parse session.jsonl[.zstd] (shadow usage lives in scripts/dsh-usage-sync.js)",
  );
});

// ─── MS-002: Registry / VALID_ADAPTER_TYPES_EXT / _seed() / bootstrap / ─────
//      coordination REGISTERED_ADAPTER_IDS — required by VC-029-002-01..04. ───

const adaptersRegistry = require("../../lib/agents/adapters");
const {
  VALID_ADAPTER_TYPES,
  VALID_ADAPTER_TYPES_EXT,
  VALID_ADAPTER_TYPES_ALL,
  isKnownAdapterType,
  validateAdapterTypeExt,
} = require("../../lib/agents/registry-adapter-types");
const dshBootstrap = require("../../lib/agents/adapters/dsh-bootstrap");
const coordinationCore = require("../../lib/coordination/adapter-core");

test("dsh adapter: VALID_ADAPTER_TYPES_EXT now contains 'dsh' (M-029 MS-002)", () => {
  assert.ok(VALID_ADAPTER_TYPES_EXT.includes("dsh"));
  assert.ok(VALID_ADAPTER_TYPES_ALL.includes("dsh"));
  assert.ok(isKnownAdapterType("dsh"));
  assert.doesNotThrow(() => validateAdapterTypeExt("dsh"));
  // Ensure minimax stays in the union (regression guard for the additive path).
  assert.ok(VALID_ADAPTER_TYPES_EXT.includes("minimax"));
});

test("dsh adapter: adapters.list() includes 'dsh' after dsh-bootstrap is required", () => {
  // dsh-bootstrap side-effect imports dsh.js which registers via the
  // bootstrap file's require chain. The base index.js seed also registers
  // dsh via try/catch, so the registry already has 'dsh' before this test.
  const list = adaptersRegistry.list();
  assert.ok(list.includes("dsh"), `adapters.list()=${JSON.stringify(list)} must include 'dsh'`);
  // Confirm the actual class behind the registration is the DshAdapter.
  const Klass = adaptersRegistry.getClass("dsh");
  assert.equal(typeof Klass, "function");
  assert.equal(Klass.name, "DshAdapter");
  const instance = adaptersRegistry.get("dsh");
  assert.ok(instance instanceof Klass);
  assert.equal(instance.bin, "dsh"); // DEFAULT_BIN
});

test("dsh adapter: dsh-bootstrap module exports the loaded marker", () => {
  assert.equal(dshBootstrap.loaded, true);
  assert.equal(typeof dshBootstrap.loadedAt, "string");
  assert.deepEqual(dshBootstrap.adapters, ["dsh"]);
});

test("dsh adapter: coordination REGISTERED_ADAPTER_IDS includes dsh.local + dsh.dev", () => {
  const ids = coordinationCore.REGISTERED_ADAPTER_IDS;
  assert.ok(ids.includes("dsh.local"), `REGISTERED_ADAPTER_IDS=${JSON.stringify(ids)} must include 'dsh.local'`);
  assert.ok(ids.includes("dsh.dev"), `REGISTERED_ADAPTER_IDS=${JSON.stringify(ids)} must include 'dsh.dev'`);
  // All ids keep the canonical namespace suffix shape.
  for (const id of ids) {
    assert.match(id, /\.(local|dev|prod)$/, `adapter id ${id} should keep namespace suffix`);
  }
});

test("dsh adapter: coordination createHostAdapter accepts dsh.local descriptor", () => {
  // dsh.local descriptor mirrors the descriptor surface used by Codex /
  // Claude Code / Cursor / etc. — capability list is empty because
  // capability negotiation is governed by the dispatch discover() path,
  // not the coordination adapter surface (per agent-runtime-interoperability
  // P-001 §2).
  const adapter = coordinationCore.createHostAdapter({
    adapterId: "dsh.local",
    capabilities: [],
  });
  assert.equal(adapter.adapterId, "dsh.local");
  assert.equal(adapter.schemaVersion, "1.0");
  assert.deepEqual(adapter.capabilities, []);
  assert.equal(adapter.handshakeOk, false);
  assert.equal(adapter.autoApprove, false);
  assert.equal(adapter.sideEffects, false);
});

test("dsh adapter: coordination createHostAdapter accepts dsh.dev descriptor", () => {
  const adapter = coordinationCore.createHostAdapter({
    adapterId: "dsh.dev",
    capabilities: [],
  });
  assert.equal(adapter.adapterId, "dsh.dev");
  assert.equal(adapter.schemaVersion, "1.0");
});

test("dsh adapter: lib/agents/registry.js was not modified (M-002 frozen body)", () => {
  // VC-029-002-04: the M-002 frozen file stays zero-modify; only
  // VALID_ADAPTER_TYPES_EXT (additive extension file) carries the new
  // 'dsh' entry. Sanity check: VALID_ADAPTER_TYPES must NOT include 'dsh'
  // — the extension file owns the additive addition.
  assert.ok(!VALID_ADAPTER_TYPES.includes("dsh"));
  assert.ok(!VALID_ADAPTER_TYPES.includes("minimax"));
});

test("dsh adapter: index.js _seed() remains try/catch additive and survives reset()", () => {
  // reset() must re-run _seed() and re-establish claude-code + codex + dsh.
  adaptersRegistry.reset();
  const list = adaptersRegistry.list();
  assert.ok(list.includes("claude-code"));
  assert.ok(list.includes("codex"));
  assert.ok(list.includes("dsh"));
});

// ─── MS-003: invoke() + cancel() + report() happy path + 6 failure modes ──────

// Fake DSH binary. Mirrors codex / pi fake-binary pattern: a Node script
// driven by FAKE_DSH_MODE env var, installed once per test process with
// chmod +x so spawn(this.bin, ...) executes it via shebang.
const FAKE_DSH_BODY = `#!/usr/bin/env node
'use strict';
// Minimal mock of the DSH CLI for tests. Driven by env vars:
//   FAKE_DSH_MODE = success | empty | badjson | framed | error-envelope |
//                   hang | exitcode | stderr
//   FAKE_DSH_DELAY_MS (optional) — sleep before responding (for hang mode)

const mode = process.env.FAKE_DSH_MODE || "success";
const delayMs = parseInt(process.env.FAKE_DSH_DELAY_MS || "0", 10);

function emit(plain) {
  process.stdout.write(plain + "\\n");
}
function emitFramed(plain) {
  const body = Buffer.byteLength(plain, "utf8");
  process.stdout.write("Content-Length: " + body + "\\r\\n\\r\\n" + plain);
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
    emit(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "hello from fake dsh", task_received: true, drained_bytes: drained } }));
    process.exit(0);
    break;
}
`;

let _fakeDshPath = null;
function installFakeDsh() {
  if (_fakeDshPath) return _fakeDshPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m029-dsh-fakebin-"));
  const file = path.join(dir, "fake-dsh.js");
  fs.writeFileSync(file, FAKE_DSH_BODY, "utf8");
  fs.chmodSync(file, 0o755);
  _fakeDshPath = file;
  return _fakeDshPath;
}

function journalFile(root, runId, name) {
  return path.join(root, ".agent", "runtime", "dispatch", runId, name);
}
function readJournal(root, runId, name) {
  const file = journalFile(root, runId, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runWithMode(mode) {
  const fake = installFakeDsh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m029-dsh-"));
  const prevMode = process.env.FAKE_DSH_MODE;
  process.env.FAKE_DSH_MODE = mode;
  try {
    return { fake, dir, restore: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
      else process.env.FAKE_DSH_MODE = prevMode;
    }};
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// VC-029-003-01: invoke() happy path
test("dsh adapter: invoke() success writes request + result + rollback + returns ok", async () => {
  const ctx = runWithMode("success");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke(
      { task: "review this" },
      { projectRoot: ctx.dir, runId: "R-dsh-ok-1" },
    );
    assert.equal(result.status, "ok");
    // invoke() returns the resultRecord shape (snake_case) — same as codex / pi.
    assert.equal(result.run_id, "R-dsh-ok-1");
    assert.match(result.result.text, /hello from fake dsh/);
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-ok-1", "request.json")));
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-ok-1", "result.json")));
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-ok-1", "rollback.json")));
    const rb = readJournal(ctx.dir, "R-dsh-ok-1", "rollback.json");
    assert.equal(rb.status, "completed");
    const req = readJournal(ctx.dir, "R-dsh-ok-1", "request.json");
    assert.equal(req.adapter_type, "dsh");
    assert.equal(req.payload.task, "review this");
  } finally { ctx.restore(); }
});

// VC-029-003-01: invoke() with Content-Length framed JSON-RPC response
test("dsh adapter: invoke() accepts Content-Length framed JSON-RPC response", async () => {
  const ctx = runWithMode("framed");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke({}, { projectRoot: ctx.dir, runId: "R-dsh-framed-1" });
    assert.equal(result.status, "ok");
    assert.equal(result.run_id, "R-dsh-framed-1");
    assert.equal(result.result.text, "framed-ok");
    assert.equal(result.result.count, 42);
  } finally { ctx.restore(); }
});

// VC-029-003-02: failure mode 1 — ERR_ADAPTER_SPAWN (missing binary)
test("dsh adapter: invoke() on missing binary writes ERR_ADAPTER_SPAWN + error + rollback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m029-dsh-spawn-"));
  try {
    const adapter = new DshAdapter({ bin: "/no/such/dsh/binary/xyz", shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: dir, runId: "R-dsh-spawn-fail" });
    assert.equal(result.status, "failed");
    assert.equal(result.run_id, "R-dsh-spawn-fail");
    assert.equal(result.error.code, "ERR_ADAPTER_SPAWN");
    assert.ok(fs.existsSync(journalFile(dir, "R-dsh-spawn-fail", "error.json")));
    assert.ok(fs.existsSync(journalFile(dir, "R-dsh-spawn-fail", "rollback.json")));
    const rb = readJournal(dir, "R-dsh-spawn-fail", "rollback.json");
    assert.equal(rb.status, "rolled_back");
    assert.equal(rb.original_error.code, "ERR_ADAPTER_SPAWN");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// VC-029-003-02: failure mode 2 — ERR_DISPATCH_FAILED (non-zero exit)
test("dsh adapter: invoke() on non-zero exit writes ERR_DISPATCH_FAILED + rollback with stderr excerpt", async () => {
  const ctx = runWithMode("exitcode");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: ctx.dir, runId: "R-dsh-exit-fail" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ERR_DISPATCH_FAILED");
    assert.equal(result.error.exit_code, 7);
    assert.equal(result.error.signal, null);
    assert.ok(typeof result.stderr === "string");
    assert.ok(result.stderr.includes("fatal: bad config"));
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-exit-fail", "error.json")));
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-exit-fail", "rollback.json")));
  } finally { ctx.restore(); }
});

// VC-029-003-02: failure mode 3 — ERR_DISPATCH_TIMEOUT
test("dsh adapter: invoke() on timeout writes ERR_DISPATCH_TIMEOUT + rollback", async () => {
  const fake = installFakeDsh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m029-dsh-timeout-"));
  const prevMode = process.env.FAKE_DSH_MODE;
  process.env.FAKE_DSH_MODE = "hang";
  try {
    const adapter = new DshAdapter({ bin: fake, shell: false, defaultTimeout: 1 });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: dir, runId: "R-dsh-timeout-1", timeout: 1 });
    assert.equal(result.status, "timeout");
    assert.equal(result.error.code, "ERR_DISPATCH_TIMEOUT");
    assert.match(result.error.message, /timed out after 1s/);
    assert.ok(fs.existsSync(journalFile(dir, "R-dsh-timeout-1", "error.json")));
    assert.ok(fs.existsSync(journalFile(dir, "R-dsh-timeout-1", "rollback.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
    else process.env.FAKE_DSH_MODE = prevMode;
  }
});

// VC-029-003-02: failure mode 4 — ERR_JSONRPC_PARSE (bad stdout)
test("dsh adapter: invoke() on bad JSON writes ERR_JSONRPC_PARSE + stdout excerpt", async () => {
  const ctx = runWithMode("badjson");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: ctx.dir, runId: "R-dsh-badjson-1" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ERR_JSONRPC_PARSE");
    assert.ok(typeof result.stdout_excerpt === "string");
    assert.ok(result.stdout_excerpt.includes("not valid json"));
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-badjson-1", "error.json")));
  } finally { ctx.restore(); }
});

// VC-029-003-02: failure mode 5 — ERR_JSONRPC_PARSE (empty stdout)
test("dsh adapter: invoke() on empty stdout writes ERR_JSONRPC_PARSE + rollback", async () => {
  const ctx = runWithMode("empty");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: ctx.dir, runId: "R-dsh-empty-1" });
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ERR_JSONRPC_PARSE");
    assert.match(result.error.message, /empty stdout from dsh CLI/);
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-empty-1", "error.json")));
  } finally { ctx.restore(); }
});

// VC-029-003-02: failure mode 6 — JSON-RPC error envelope (rate_limited)
test("dsh adapter: invoke() on JSON-RPC error envelope maps to ERR_DSH_RATE_LIMITED + rollback", async () => {
  const ctx = runWithMode("error-envelope");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: ctx.dir, runId: "R-dsh-rpc-err-1" });
    assert.equal(result.status, "failed");
    // Note: code = -32001; codex adapter prefixes with ERR_CODEX_, dsh with ERR_DSH_.
    assert.equal(result.error.code, "ERR_DSH_-32001");
    assert.equal(result.error.message, "rate_limited");
    assert.ok(fs.existsSync(journalFile(ctx.dir, "R-dsh-rpc-err-1", "error.json")));
  } finally { ctx.restore(); }
});

// VC-029-003-02: rollback-failed.json — synthesize via EISDIR on rollback path
test("dsh adapter: invoke() rollback write failure produces rollback-failed.json + notify_parent=true", async () => {
  // Strategy: pre-create rollback.json as a DIRECTORY (not a file). The
  // adapter's atomic write does `.tmp → rename`; renaming a file onto a
  // directory fails with EISDIR. The adapter's _writeErrorAndRollback then
  // falls through to the rollback-failed.json branch with notify_parent=true.
  const fake = installFakeDsh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m029-dsh-rbfail-"));
  const prevMode = process.env.FAKE_DSH_MODE;
  process.env.FAKE_DSH_MODE = "exitcode";
  try {
    const runId = "R-dsh-rbfail-1";
    const rbPath = journalFile(dir, runId, "rollback.json");
    fs.mkdirSync(path.dirname(rbPath), { recursive: true });
    // Create rollback.json as a directory to trigger EISDIR on rename.
    fs.mkdirSync(rbPath);

    const adapter = new DshAdapter({ bin: fake, shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: dir, runId });

    assert.equal(result.status, "failed");
    // error.json should have been written successfully.
    assert.ok(fs.existsSync(journalFile(dir, runId, "error.json")));
    // rollback.json is the directory blocker; rollback-failed.json is the
    // fallback artifact.
    assert.ok(fs.existsSync(journalFile(dir, runId, "rollback-failed.json")));
    const rbf = readJournal(dir, runId, "rollback-failed.json");
    assert.equal(rbf.status, "rollback_failed");
    assert.equal(rbf.notify_parent, true);
    assert.equal(rbf.primary_error.code, "ERR_DISPATCH_FAILED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
    else process.env.FAKE_DSH_MODE = prevMode;
  }
});

// VC-029-003-03: cancel() in-flight — start a hanging fake then cancel
test("dsh adapter: cancel() mid-flight sends SIGTERM to the running subprocess", async () => {
  const fake = installFakeDsh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m029-dsh-cancel-"));
  const prevMode = process.env.FAKE_DSH_MODE;
  process.env.FAKE_DSH_MODE = "hang";
  try {
    const adapter = new DshAdapter({ bin: fake, shell: false, defaultTimeout: 30 });
    const invokePromise = adapter.invoke(
      { task: "long" },
      { projectRoot: dir, runId: "R-dsh-cancel-1", timeout: 30 },
    );
    // Give the child a moment to actually start.
    await new Promise((r) => setTimeout(r, 50));
    const cancelResult = await adapter.cancel("R-dsh-cancel-1");
    assert.equal(cancelResult.runId, "R-dsh-cancel-1");
    assert.equal(cancelResult.cancelled, true);
    assert.equal(cancelResult.error, null);
    // Drain the invoke promise — it should resolve as a structured failure.
    const finalResult = await invokePromise;
    assert.equal(finalResult.status, "failed");
    assert.ok(
      finalResult.error.code === "ERR_DISPATCH_ERROR" || finalResult.error.code === "ERR_DISPATCH_FAILED",
      `expected ERR_DISPATCH_ERROR or ERR_DISPATCH_FAILED, got ${finalResult.error.code}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevMode === undefined) delete process.env.FAKE_DSH_MODE;
    else process.env.FAKE_DSH_MODE = prevMode;
  }
});

// VC-029-003-03: cancel() for unknown runId returns structured no-op
test("dsh adapter: cancel() of unknown runId returns ERR_NO_RUNNING_SUBPROCESS", async () => {
  const adapter = new DshAdapter({ bin: "/bin/true", shell: false });
  const result = await adapter.cancel("R-not-tracked-2026-08-19");
  assert.equal(result.cancelled, false);
  assert.equal(result.error.code, "ERR_NO_RUNNING_SUBPROCESS");
});

// VC-029-003-03: report() happy path — reads back request + result + rollback
test("dsh adapter: report() reads back a successful journal and surfaces latency_ms", async () => {
  const ctx = runWithMode("success");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    await adapter.invoke({ task: "audit me" }, { projectRoot: ctx.dir, runId: "R-dsh-report-1" });
    const report = await adapter.report("R-dsh-report-1", { projectRoot: ctx.dir });
    assert.equal(report.runId, "R-dsh-report-1");
    assert.equal(report.status, "ok");
    assert.equal(report.adapter_type, "dsh");
    assert.ok(report.result);
    // report.result is the full result.json envelope; the JSON-RPC result
    // sits under report.result.result.
    assert.ok(report.result.result);
    assert.match(report.result.result.text, /hello from fake dsh/);
    assert.ok(typeof report.latency_ms === "number");
    assert.ok(report.latency_ms >= 0);
  } finally { ctx.restore(); }
});

// VC-029-003-04: security — adapter never reads ~/.dsh/sessions/ during dispatch
test("dsh adapter: invoke() does not touch ~/.dsh/sessions/ at runtime", async () => {
  // Use FAKE_DSH_MODE=success; the fake script never reads ~/.dsh/sessions/
  // and the adapter code path doesn't either (verified by source scan in MS-001).
  const ctx = runWithMode("success");
  try {
    const adapter = new DshAdapter({ bin: ctx.fake, shell: false });
    const result = await adapter.invoke({ task: "x" }, { projectRoot: ctx.dir, runId: "R-dsh-secure-1" });
    assert.equal(result.status, "ok");
    // The journal must NOT contain session.jsonl or .dsh/sessions references.
    const req = readJournal(ctx.dir, "R-dsh-secure-1", "request.json");
    const res = readJournal(ctx.dir, "R-dsh-secure-1", "result.json");
    const serialized = JSON.stringify({ req, res });
    assert.ok(!serialized.includes(".dsh/sessions"));
    assert.ok(!serialized.includes("session.jsonl"));
  } finally { ctx.restore(); }
});
