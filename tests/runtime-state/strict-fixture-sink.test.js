"use strict";

// Temporary synthetic store negatives only. No process or three-Task loop.
// Fixture approval-looking records are test data, not human authorization.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const { createAuthorization } = require("../../lib/runtime-state/operation-lifecycle");
const { createFilesystemRevision } = require("../../lib/governance/store");
const { openStrictFixtureSink, inspectStrictFixtureRecovery } = require("../../lib/runtime-state/strict-fixture-sink");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cortex-l3-fixture-"));
  const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cortex-l3-sentinel-"));
  const sentinel = path.join(outside, "untouched.txt");
  fs.writeFileSync(sentinel, "outside synthetic fixture\n");
  const originalSentinel = fs.readFileSync(sentinel);
  const handles = [];
  t.after(() => {
    assert.deepEqual(fs.readFileSync(sentinel), originalSentinel);
    // Test-harness teardown only, never runtime recovery or stale-lock stealing.
    for (const fd of handles) { try { fs.closeSync(fd); } catch (_) {} }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  for (const dir of ["decisions", "waitpoints", "authorizations", "artifacts"]) {
    fs.mkdirSync(path.join(root, ".agent", dir), { recursive: true, mode: 0o700 });
  }
  const date = (ms) => new Date(Date.now() + ms).toISOString();
  const expiry = date(240000);
  const scope = { schema_version: 1, kind: "synthetic_l3_fixture", project_ref: "project:fixture-" + crypto.randomUUID(),
    owner_ref: "fixture-owner", owner_workflow: "/mission", decision_id: "D-FIXTURE", waitpoint_id: "WP-FIXTURE",
    task_ids: ["T-FIXTURE-1", "T-FIXTURE-2", "T-FIXTURE-3"],
    authorization_ids: ["A-FIXTURE-1", "A-FIXTURE-2", "A-FIXTURE-3"],
    expires_at: expiry, max_task_ms: 10000, max_total_ms: 30000 };
  const scopeBytes = JSON.stringify(scope);
  const revision = createFilesystemRevision(scopeBytes).value;
  const resource = "artifact:strict-fixture-scope@" + revision;
  fs.writeFileSync(path.join(root, ".agent/artifacts/strict-fixture-scope.json"), scopeBytes);
  const relations = { task_ids: scope.task_ids, mission_ids: [], run_ids: [], queue_ids: [],
    session_ids: [], artifact_refs: [resource], worktree_paths: [] };
  const gate = { action: "external_side_effect", resource_ref: resource };
  const decision = { schema_version: 1, decision_id: "D-FIXTURE", type: "approval", status: "approved",
    requested_by: "fixture-owner", prompt: "Synthetic fixture. Not a human approval.",
    options: ["approve", "reject"], selected_option: "approve", resolved_by: "fixture-user",
    resolved_at: date(-2000), rationale: "Synthetic fixture", gate, relations,
    created_at: date(-3000), updated_at: date(-2000) };
  const waitpoint = { schema_version: 1, waitpoint_id: "WP-FIXTURE", status: "released",
    owner_workflow: "/mission", reason: "Synthetic fixture", gate, decision_id: "D-FIXTURE",
    evidence_refs: [".agent/decisions/D-FIXTURE.json"], relations, released_by: "fixture-owner",
    released_at: date(-1000), release_note: "Synthetic fixture", expires_at: expiry,
    created_at: date(-3000), updated_at: date(-1000) };
  function put(relative, value) { fs.writeFileSync(path.join(root, relative), JSON.stringify(value)); }
  put(".agent/decisions/D-FIXTURE.json", decision);
  put(".agent/waitpoints/WP-FIXTURE.json", waitpoint);
  for (let n = 1; n <= 3; n++) {
    put(".agent/authorizations/A-FIXTURE-" + n + ".json", createAuthorization({
      authorization_id: "A-FIXTURE-" + n, decision_id: "D-FIXTURE",
      decision_source: ".agent/decisions/D-FIXTURE.json", policy: "fixture-only", reason: "Synthetic test",
      scope: { repository: scope.project_ref, revision, task_id: "T-FIXTURE-" + n,
        relative_path: "fixture-artifacts/T-FIXTURE-" + n + ".txt" },
      validity: { mode: "single" }, created_at: date(-1000), expires_at: expiry,
    }));
  }
  function open() {
    const original = fs.openSync;
    fs.openSync = (file, ...args) => {
      const fd = original(file, ...args);
      if (String(file).endsWith("/strict-fixture/writer.lock")) handles.push(fd);
      return fd;
    };
    try { return openStrictFixtureSink({ enabled: true, fixtureOnly: true, projectRoot: root }); }
    finally { fs.openSync = original; }
  }
  return { root, outside, sentinel, decision, waitpoint, scope, put, open };
}
const run = { run_ref: "run:fixture-unit-one", task_id: "T-FIXTURE-1" };
function proposal(extra = {}) {
  return { ...run, proposal_id: "P-FIXTURE-1", proposal: { kind: "fixture.record", task_id: run.task_id },
    assertActive() {}, ...extra };
}
function inventory(root) {
  const dir = path.join(root, "fixture-artifacts");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]) : [];
}
function denyWithoutArtifact(f, fn, code) {
  const before = inventory(f.root);
  const sentinel = fs.readFileSync(f.sentinel);
  const originalOpen = fs.openSync, originalWrite = fs.writeFileSync, originalSpawn = childProcess.spawn;
  const sinkFds = new Set();
  let sinkOpens = 0, sinkWrites = 0, spawns = 0;
  fs.openSync = (file, flags, ...rest) => {
    const isSink = typeof file === "string" && file.startsWith(path.join(f.root, "fixture-artifacts") + path.sep);
    const writing = typeof flags === "number"
      ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : flags !== "r";
    if (isSink && writing) sinkOpens++;
    const fd = originalOpen(file, flags, ...rest);
    if (isSink && writing) sinkFds.add(fd);
    return fd;
  };
  fs.writeFileSync = (file, ...args) => {
    if (sinkFds.has(file) || typeof file === "string" && file.startsWith(path.join(f.root, "fixture-artifacts") + path.sep)) sinkWrites++;
    return originalWrite(file, ...args);
  };
  childProcess.spawn = () => { spawns++; throw new Error("No process in store negative tests"); };
  try { assert.throws(fn, (error) => error.code === code); }
  finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; childProcess.spawn = originalSpawn; }
  assert.equal(sinkOpens, 0); assert.equal(sinkWrites, 0); assert.equal(spawns, 0);
  assert.deepEqual(inventory(f.root), before);
  assert.deepEqual(fs.readFileSync(f.sentinel), sentinel);
}
function finishCanceled(sink) {
  sink.onStop({ ...run, status: "canceled", spawned: false, process_exited: false, process_outcome: "not_started" });
  sink.close();
}

test("default OFF does not read or create a store", () => {
  const original = fs.openSync;
  fs.openSync = () => { assert.fail("OFF cannot open"); };
  try {
    const sink = openStrictFixtureSink();
    assert.equal(sink.inspect().status, "DISABLED");
    assert.throws(() => sink.onStart(run), { code: "ERR_STRICT_FIXTURE_DISABLED" });
    sink.close();
  } finally { fs.openSync = original; }
});
test("a missing Waitpoint is rejected before runtime state exists", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, ".agent/waitpoints/WP-FIXTURE.json"));
  assert.throws(f.open);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime")), false);
  assert.deepEqual(inventory(f.root), []);
});
test("scope digest mismatch is rejected before runtime state exists", (t) => {
  const f = fixture(t); f.scope.max_task_ms = 9000;
  f.put(".agent/artifacts/strict-fixture-scope.json", f.scope);
  assert.throws(f.open, { code: "ERR_STRICT_SCOPE_MISMATCH" });
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime")), false);
});
test("runtime parent symlink cannot redirect fixture writes", (t) => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.root, ".agent-runtime"));
  assert.throws(f.open, { code: "ERR_FIXTURE_SOURCE" });
  assert.deepEqual(fs.readdirSync(f.outside), ["untouched.txt"]);
});
test("stale writer lock is preserved and never stolen", (t) => {
  const f = fixture(t), dir = path.join(f.root, ".agent-runtime/strict-fixture");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "writer.lock");
  const bytes = JSON.stringify({ pid: 99999999, ownerToken: "stale-fixture", fixture_only: true });
  fs.writeFileSync(file, bytes);
  assert.throws(f.open, { code: "ERR_FIXTURE_WRITER_OR_RECOVERY_REQUIRED" });
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.deepEqual(inventory(f.root), []);
});
test("T2 cannot begin before the T1 runtime outcome", (t) => {
  const f = fixture(t), sink = f.open();
  denyWithoutArtifact(f, () => sink.onStart({ run_ref: "run:fixture-two", task_id: "T-FIXTURE-2" }), "ERR_FIXTURE_DEPENDENCY");
  assert.equal(sink.inspect().runs.length, 0);
  sink.close();
});
test("revocation is durable before a late proposal and no artifact is written", (t) => {
  const f = fixture(t), sink = f.open();
  sink.onStart(run);
  sink.revoke();
  const auth = JSON.parse(fs.readFileSync(path.join(f.root, ".agent/authorizations/A-FIXTURE-1.json"), "utf8"));
  assert.ok(auth.revoked_at);
  denyWithoutArtifact(f, () => sink.onProposal(proposal()), "ERR_FIXTURE_STOPPED");
  finishCanceled(sink);
});
test("cancellation blocks a late proposal before output is opened", (t) => {
  const f = fixture(t), sink = f.open();
  sink.onStart(run); sink.cancel(run.run_ref);
  denyWithoutArtifact(f, () => sink.onProposal(proposal()), "ERR_FIXTURE_STOPPED");
  finishCanceled(sink);
});
test("external authorization replacement irreversibly quarantines the writer", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run);
  const file = path.join(f.root, ".agent/authorizations/A-FIXTURE-1.json");
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, original + "\n");
  denyWithoutArtifact(f, () => sink.onProposal(proposal()), "ERR_FIXTURE_EXTERNAL_WRITER");
  fs.writeFileSync(file, original);
  denyWithoutArtifact(f, () => sink.onProposal(proposal()), "ERR_FIXTURE_QUARANTINED");
  assert.throws(sink.close, { code: "ERR_FIXTURE_QUARANTINED" });
});
test("external lease bytes cannot be accepted as a new fence", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run);
  fs.appendFileSync(path.join(f.root, ".agent-runtime/strict-fixture/leases/state.json"), "\n");
  denyWithoutArtifact(f, () => sink.onProposal(proposal()), "ERR_FIXTURE_EXTERNAL_WRITER");
});
test("one attempt per task includes already-started attempts", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run);
  denyWithoutArtifact(f, () => sink.onStart({ ...run, run_ref: "run:fixture-unit-retry" }), "ERR_FIXTURE_ATTEMPT_BUDGET");
  finishCanceled(sink);
});
test("runtime guard rejection does not open the effect file", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run);
  denyWithoutArtifact(f, () => sink.onProposal(proposal({ assertActive() { const e = new Error("stopped"); e.code = "ERR_TEST_STOPPED"; throw e; } })), "ERR_TEST_STOPPED");
  finishCanceled(sink);
});
test("UNKNOWN preserves lock and recovery is read-only without replay", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run);
  sink.onStop({ ...run, status: "UNKNOWN", spawned: true, process_exited: false, process_outcome: "UNKNOWN" });
  const stateFile = path.join(f.root, ".agent-runtime/strict-fixture/state.json");
  const before = fs.readFileSync(stateFile, "utf8");
  const result = inspectStrictFixtureRecovery(f.root);
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(result.runs[0].status, "unknown");
  assert.equal(result.effect_permitted, false);
  assert.equal(fs.readFileSync(stateFile, "utf8"), before);
  assert.throws(sink.close, { code: "ERR_FIXTURE_RECOVERY_REQUIRED" });
  assert.throws(f.open, { code: "ERR_FIXTURE_WRITER_OR_RECOVERY_REQUIRED" });
  assert.deepEqual(inventory(f.root), []);
});

test("revocation between createRun and spawn is denied without output", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run); sink.revoke();
  denyWithoutArtifact(f, () => sink.beforeSpawn({ ...run, assertActive() {} }), "ERR_FIXTURE_STOPPED");
  finishCanceled(sink);
});

for (const name of ["state.json", "idempotency.json"]) test("preexisting lease " + name + " prevents fresh admission", (t) => {
  const f = fixture(t), dir = path.join(f.root, ".agent-runtime/strict-fixture/leases");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name), bytes = '{"synthetic_previous_state":true}\n';
  fs.writeFileSync(file, bytes);
  denyWithoutArtifact(f, f.open, "ERR_FIXTURE_NOT_FRESH");
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime/strict-fixture/state.json")), false);
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime/strict-fixture/writer.lock")), false);
});
test("malformed raw UTF-8 in authority is rejected before runtime initialization", (t) => {
  const f = fixture(t), file = path.join(f.root, ".agent/decisions/D-FIXTURE.json");
  const source = JSON.stringify(f.decision).replace("Synthetic fixture. Not a human approval.", "raw-MARKER");
  const parts = source.split("MARKER"); assert.equal(parts.length, 2);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(parts[0]), Buffer.from([0xff]), Buffer.from(parts[1])]));
  denyWithoutArtifact(f, f.open, "ERR_FIXTURE_SOURCE_UTF8");
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime")), false);
});
test("multiple authority hard links are rejected before runtime initialization", (t) => {
  const f = fixture(t), file = path.join(f.root, ".agent/decisions/D-FIXTURE.json");
  fs.linkSync(file, path.join(f.root, "duplicate-authority-link"));
  denyWithoutArtifact(f, f.open, "ERR_FIXTURE_SOURCE_UNSAFE");
  assert.equal(fs.existsSync(path.join(f.root, ".agent-runtime")), false);
});
test("sink authority reader bounds simulated growth without readFileSync", (t) => {
  const f = fixture(t), target = path.join(f.root, ".agent/artifacts/strict-fixture-scope.json");
  let supplied = 0;
  denyWithoutArtifact(f, () => {
    const originalOpen = fs.openSync, originalRead = fs.readSync;
    let targetFd = null;
    fs.openSync = (file, ...args) => { const fd = originalOpen(file, ...args); if (file === target) targetFd = fd; return fd; };
    fs.readSync = (fd, buffer, offset, length, position) => {
      if (fd !== targetFd) return originalRead(fd, buffer, offset, length, position);
      supplied += length; buffer.fill(32, offset, offset + length); return length;
    };
    try { f.open(); }
    finally { fs.openSync = originalOpen; fs.readSync = originalRead; }
  }, "ERR_FIXTURE_SOURCE_CHANGED");
  assert.equal(supplied, 1024 * 1024 + 1);
});
test("external lease idempotency replacement quarantines without an artifact", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run);
  f.put(".agent-runtime/strict-fixture/leases/idempotency.json", { replacement: true });
  denyWithoutArtifact(f, () => sink.beforeSpawn({ ...run, assertActive() {} }), "ERR_FIXTURE_EXTERNAL_WRITER");
  assert.throws(sink.close, { code: "ERR_FIXTURE_QUARANTINED" });
});
test("cancel before spawn records stopped evidence without inventing process exit", (t) => {
  const f = fixture(t), sink = f.open(); sink.onStart(run); sink.cancel(run.run_ref);
  finishCanceled(sink);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, ".agent-runtime/strict-fixture/state.json"), "utf8"));
  assert.equal(state.runs[run.run_ref].spawned, false);
  assert.equal(state.runs[run.run_ref].process_exited, false);
  assert.equal(state.runs[run.run_ref].process_stopped, true);
  const leases = JSON.parse(fs.readFileSync(path.join(f.root, ".agent-runtime/strict-fixture/leases/state.json"), "utf8"));
  const release = leases.audit.filter((entry) => entry.eventType === "ownership.released").at(-1);
  assert.ok(release);
  assert.deepEqual(release.evidence, ["fixture-process-stopped-not-spawned"]);
  assert.deepEqual(inventory(f.root), []);
});

function recoveryReceiptFixture(f) {
  const dir = path.join(f.root, ".agent-runtime/strict-fixture");
  const output = path.join(f.root, "fixture-artifacts/T-FIXTURE-1.txt");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(output), { mode: 0o700 });
  const bytes = Buffer.from("Synthetic preexisting recovery evidence\n");
  fs.writeFileSync(output, bytes);
  const state = { schema_version: 1, evidence_kind: "synthetic_process_fixture", runs: {
    [run.run_ref]: { ...run, status: "unknown", process_stopped: false,
      effect: { status: "receipt", sha256: crypto.createHash("sha256").update(bytes).digest("hex") } },
  } };
  const file = path.join(dir, "state.json"); fs.writeFileSync(file, JSON.stringify(state));
  return { output, file, stateBytes: fs.readFileSync(file) };
}
test("read-only recovery checks a preexisting receipt but still requires recovery", (t) => {
  const f = fixture(t), data = recoveryReceiptFixture(f), before = inventory(f.root);
  const originalWrite = fs.writeFileSync, originalSpawn = childProcess.spawn;
  fs.writeFileSync = () => assert.fail("readonly recovery cannot write");
  childProcess.spawn = () => assert.fail("readonly recovery cannot spawn");
  let result;
  try { result = inspectStrictFixtureRecovery(f.root); }
  finally { fs.writeFileSync = originalWrite; childProcess.spawn = originalSpawn; }
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(result.effect_permitted, false);
  assert.equal(result.runs[0].status, "unknown");
  assert.deepEqual(inventory(f.root), before);
  assert.deepEqual(fs.readFileSync(data.file), data.stateBytes);
});
test("recovery rejects changed preexisting output without writing anything", (t) => {
  const f = fixture(t), data = recoveryReceiptFixture(f);
  fs.appendFileSync(data.output, "changed");
  denyWithoutArtifact(f, () => inspectStrictFixtureRecovery(f.root), "ERR_FIXTURE_OUTPUT_CHANGED");
  assert.deepEqual(fs.readFileSync(data.file), data.stateBytes);
});
test("recovery rejects a symlink output instead of trusting its receipt", (t) => {
  const f = fixture(t), data = recoveryReceiptFixture(f);
  fs.unlinkSync(data.output); fs.symlinkSync(f.sentinel, data.output);
  denyWithoutArtifact(f, () => inspectStrictFixtureRecovery(f.root), "ERR_FIXTURE_SOURCE_UNSAFE");
  assert.deepEqual(fs.readFileSync(data.file), data.stateBytes);
});
test("recovery rejects a multiply linked output even when bytes match", (t) => {
  const f = fixture(t), data = recoveryReceiptFixture(f);
  fs.linkSync(data.output, path.join(f.root, "duplicate-output-link"));
  denyWithoutArtifact(f, () => inspectStrictFixtureRecovery(f.root), "ERR_FIXTURE_SOURCE_UNSAFE");
  assert.deepEqual(fs.readFileSync(data.file), data.stateBytes);
});

test("observed scope disappearing before open fails as changed (mock open)", (t) => {
  const f = fixture(t), target = path.join(f.root, ".agent/artifacts/strict-fixture-scope.json");
  denyWithoutArtifact(f, () => {
    const originalOpen = fs.openSync;
    fs.openSync = (file, ...args) => {
      if (file === target) throw Object.assign(new Error("simulated disappearance"), { code: "ENOENT" });
      return originalOpen(file, ...args);
    };
    try { f.open(); }
    finally { fs.openSync = originalOpen; }
  }, "ERR_FIXTURE_SOURCE_CHANGED");
});

test("a persisted success claim without receipt projects UNKNOWN and never replays", (t) => {
  const f = fixture(t), data = recoveryReceiptFixture(f), state = JSON.parse(data.stateBytes);
  state.runs[run.run_ref].status = "succeeded"; state.runs[run.run_ref].process_stopped = true;
  delete state.runs[run.run_ref].effect;
  fs.writeFileSync(data.file, JSON.stringify(state));
  const before = fs.readFileSync(data.file), beforeInventory = inventory(f.root), originalWrite = fs.writeFileSync, originalSpawn = childProcess.spawn;
  fs.writeFileSync = () => assert.fail("readonly recovery cannot write");
  childProcess.spawn = () => assert.fail("readonly recovery cannot spawn");
  let result;
  try { result = inspectStrictFixtureRecovery(f.root); }
  finally { fs.writeFileSync = originalWrite; childProcess.spawn = originalSpawn; }
  assert.equal(result.status, "RECOVERY_REQUIRED");
  assert.equal(result.runs[0].status, "unknown");
  assert.equal(result.effect_permitted, false);
  assert.deepEqual(fs.readFileSync(data.file), before);
  assert.deepEqual(inventory(f.root), beforeInventory);
});
