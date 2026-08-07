"use strict";

// ─── Adapter Framework Base Tests (M-003 MS-001 / F-001) ───────────────────────
//
// Coverage: lib/agents/adapters/base.js
//   - BaseAdapter cannot be instantiated directly (abstract class guard)
//   - 5 method contract: each method is overridable + abstract on base
//   - Journal helpers: dispatchDir / writeDispatchArtifact /
//     readDispatchArtifact / generateRunId
//   - 2 example adapter implementations round-trip the contract (proves
//     the framework is usable by 3rd parties)
//
// Per docs/architecture/adapter-authoring.md §2 the contract is:
//   discover() / health() / invoke(payload, options) /
//   cancel(runId, options) / report(runId, options)

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BaseAdapter,
  abstractMethod,
  dispatchDir,
  ensureDispatchDir,
  writeDispatchArtifact,
  readDispatchArtifact,
  generateRunId,
} = require("../../lib/agents/adapters/base");

// ─── helpers ──────────────────────────────────────────────────────────────────

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "m003-ms001-base-"));
}
function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// ─── abstract class guard ─────────────────────────────────────────────────────

test("adapter-base: BaseAdapter cannot be instantiated directly", () => {
  assert.throws(
    () => new BaseAdapter(),
    /BaseAdapter is abstract/,
  );
});

test("adapter-base: BaseAdapter can be subclassed; subclass instantiates fine", () => {
  class Stub extends BaseAdapter {}
  const s = new Stub();
  assert.ok(s instanceof BaseAdapter);
  assert.deepEqual(s.options, {});
});

test("adapter-base: subclass can pass options through super()", () => {
  class Configurable extends BaseAdapter {
    constructor() { super({ bin: "x", timeout: 30 }); }
  }
  const c = new Configurable();
  assert.equal(c.options.bin, "x");
  assert.equal(c.options.timeout, 30);
});

// ─── 5-method contract: default behavior ──────────────────────────────────────

test("adapter-base: empty subclass throws ERR_ADAPTER_ABSTRACT on discover()", () => {
  class Empty extends BaseAdapter {}
  const e = new Empty();
  assert.throws(() => e.discover(), (err) => {
    return err.code === "ERR_ADAPTER_ABSTRACT" && err.method === "discover";
  });
});

test("adapter-base: empty subclass throws ERR_ADAPTER_ABSTRACT on invoke()", async () => {
  class Empty extends BaseAdapter {}
  const e = new Empty();
  await assert.rejects(
    () => e.invoke({ task: "x" }),
    (err) => err.code === "ERR_ADAPTER_ABSTRACT" && err.method === "invoke",
  );
});

test("adapter-base: empty subclass health() returns structured 'unknown' (not throw)", async () => {
  class Empty extends BaseAdapter {}
  const e = new Empty();
  const h = await e.health();
  assert.equal(h.status, "unknown");
  assert.equal(h.ready, false);
  assert.ok(/not implemented/.test(h.error));
});

test("adapter-base: empty subclass cancel() returns structured 'not_supported' (not throw)", async () => {
  class Empty extends BaseAdapter {}
  const e = new Empty();
  const r = await e.cancel("R-xyz");
  assert.equal(r.cancelled, false);
  assert.equal(r.error.code, "ERR_CANCEL_NOT_SUPPORTED");
  assert.equal(r.runId, "R-xyz");
});

test("adapter-base: report() with unknown runId returns status=not_found", async () => {
  const root = mkProject();
  try {
    class Empty extends BaseAdapter {}
    const e = new Empty();
    const r = await e.report("R-nope", { projectRoot: root });
    assert.equal(r.status, "not_found");
    assert.equal(r.result, null);
    assert.equal(r.error, null);
  } finally { rmProject(root); }
});

// ─── journal helpers ──────────────────────────────────────────────────────────

test("adapter-base: dispatchDir returns .agent-runtime/dispatch/<runId>", () => {
  const p = dispatchDir("/tmp/proj", "R-abc");
  assert.equal(p, path.join("/tmp/proj", ".agent-runtime", "dispatch", "R-abc"));
});

test("adapter-base: dispatchDir throws without projectRoot or runId", () => {
  assert.throws(() => dispatchDir(null, "R-abc"), /projectRoot required/);
  assert.throws(() => dispatchDir("/tmp", null), /runId required/);
});

test("adapter-base: writeDispatchArtifact writes JSON to .agent-runtime/dispatch/<runId>/", () => {
  const root = mkProject();
  try {
    const file = writeDispatchArtifact(root, "R-1", "result.json", { ok: true, n: 1 });
    assert.ok(fs.existsSync(file));
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(back, { ok: true, n: 1 });
  } finally { rmProject(root); }
});

test("adapter-base: writeDispatchArtifact is atomic (.tmp + rename)", () => {
  const root = mkProject();
  try {
    writeDispatchArtifact(root, "R-2", "result.json", { v: 1 });
    // No leftover .tmp files
    const dir = path.join(root, ".agent-runtime", "dispatch", "R-2");
    const files = fs.readdirSync(dir);
    const tmps = files.filter((f) => f.includes(".tmp-"));
    assert.equal(tmps.length, 0);
  } finally { rmProject(root); }
});

test("adapter-base: readDispatchArtifact returns null when file missing", () => {
  const root = mkProject();
  try {
    const r = readDispatchArtifact(root, "R-3", "result.json");
    assert.equal(r, null);
  } finally { rmProject(root); }
});

test("adapter-base: readDispatchArtifact round-trips through write", () => {
  const root = mkProject();
  try {
    const payload = { run_id: "R-4", result: { text: "hi" } };
    writeDispatchArtifact(root, "R-4", "result.json", payload);
    const back = readDispatchArtifact(root, "R-4", "result.json");
    assert.deepEqual(back, payload);
  } finally { rmProject(root); }
});

test("adapter-base: readDispatchArtifact throws ERR_DISPATCH_ARTIFACT_PARSE on bad JSON", () => {
  const root = mkProject();
  try {
    const dir = path.join(root, ".agent-runtime", "dispatch", "R-bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "result.json"), "{not json");
    assert.throws(
      () => readDispatchArtifact(root, "R-bad", "result.json"),
      (err) => err.code === "ERR_DISPATCH_ARTIFACT_PARSE",
    );
  } finally { rmProject(root); }
});

test("adapter-base: ensureDispatchDir creates .agent-runtime/dispatch/<runId>/", () => {
  const root = mkProject();
  try {
    const dir = ensureDispatchDir(root, "R-5");
    assert.ok(fs.existsSync(dir));
    assert.equal(dir, path.join(root, ".agent-runtime", "dispatch", "R-5"));
  } finally { rmProject(root); }
});

test("adapter-base: generateRunId format is R-adapter-invoke-<ts>-<rand>", () => {
  const id = generateRunId();
  assert.match(
    id,
    /^R-adapter-invoke-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z0-9]{6}$/,
  );
});

test("adapter-base: generateRunId accepts a custom prefix", () => {
  const id = generateRunId("R-test");
  assert.match(id, /^R-test-/);
});

test("adapter-base: abstractMethod() returns an Error with code + method", () => {
  const err = abstractMethod("discover");
  assert.ok(err instanceof Error);
  assert.equal(err.code, "ERR_ADAPTER_ABSTRACT");
  assert.equal(err.method, "discover");
  assert.ok(/abstract/.test(err.message));
});

// ─── 2 example adapters (proves the framework is usable by 3rd parties) ──────

// Example 1: trivial sync adapter — overrides only discover + health. Useful
// for tests / demo purposes. Real vendors would override invoke().
class TrivialAdapter extends BaseAdapter {
  discover() {
    return {
      adapter_type: "trivial",
      version: "0.0.1",
      protocol: "external_v1",
      capabilities: ["echo"],
    };
  }
  async health() {
    return { status: "ok", ready: true, latency_ms: 1, error: null, details: { kind: "trivial" } };
  }
  async invoke(payload) {
    return { runId: "R-trivial", status: "ok", result: { echo: payload }, error: null, latency_ms: 1 };
  }
}

// Example 2: stateful adapter — tracks subprocesses for cancel(). Mirrors
// the real claude-code adapter shape (the F-002 concrete adapter) so the
// contract is shown in full, but with a fake "binary" that always succeeds.
class StatefulAdapter extends BaseAdapter {
  constructor() {
    super({});
    this._procs = new Map();
  }
  discover() {
    return { adapter_type: "stateful", version: "0.0.1", protocol: "external_v1" };
  }
  async health() { return { status: "ok", ready: true, latency_ms: 0, error: null, details: {} }; }
  async invoke(payload, options = {}) {
    const runId = options.runId || generateRunId("R-stateful");
    this._procs.set(runId, { alive: true, payload });
    return { runId, status: "ok", result: { echoed: payload }, error: null, latency_ms: 1 };
  }
  async cancel(runId) {
    const proc = this._procs.get(runId);
    if (!proc) return { runId, cancelled: false, error: { code: "ERR_NO_RUNNING", message: "no such run" } };
    proc.alive = false;
    this._procs.delete(runId);
    return { runId, cancelled: true, error: null };
  }
  async report(runId) {
    const proc = this._procs.get(runId);
    if (!proc) return { runId, status: "not_found", result: null, error: null };
    return { runId, status: proc.alive ? "running" : "ok", result: { echoed: proc.payload }, error: null };
  }
}

test("adapter-base: example 'trivial' adapter satisfies the 5-method contract", async () => {
  const t = new TrivialAdapter();
  // discover (sync)
  const d = t.discover();
  assert.equal(d.adapter_type, "trivial");
  // health (async)
  const h = await t.health();
  assert.equal(h.ready, true);
  // invoke (async)
  const inv = await t.invoke({ task: "hi" });
  assert.equal(inv.status, "ok");
  assert.deepEqual(inv.result.echo, { task: "hi" });
});

test("adapter-base: example 'stateful' adapter supports the full lifecycle (invoke → cancel → report)", async () => {
  const s = new StatefulAdapter();
  const d = s.discover();
  assert.equal(d.adapter_type, "stateful");
  const h = await s.health();
  assert.equal(h.ready, true);

  const inv = await s.invoke({ task: "do thing" }, { runId: "R-st-1" });
  assert.equal(inv.runId, "R-st-1");
  assert.equal(inv.status, "ok");

  // Report while still alive
  const r1 = await s.report("R-st-1");
  assert.equal(r1.status, "running");

  // Cancel
  const c = await s.cancel("R-st-1");
  assert.equal(c.cancelled, true);
  assert.equal(c.error, null);

  // After cancel: report shows gone
  const r2 = await s.report("R-st-1");
  assert.equal(r2.status, "not_found");
});

test("adapter-base: stateful adapter cancel() returns ERR_NO_RUNNING for unknown runId", async () => {
  const s = new StatefulAdapter();
  const c = await s.cancel("R-unknown");
  assert.equal(c.cancelled, false);
  assert.equal(c.error.code, "ERR_NO_RUNNING");
});
