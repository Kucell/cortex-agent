"use strict";

// Experimental Tier-I sink for a fresh, synthetic, single-writer fixture ONLY.
// It does not authorize real projects or an AI Host. Fixed trusted worker code
// shares the OS user: this is not hostile-process isolation. All fixture writes,
// cancellation, revocation and sink entry must use this instance; legacy writers
// are unsupported. The lifetime exclusive lock is never automatically stolen.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { FilesystemGovernanceStore, createFilesystemRevision } = require("../governance/store");
const { validateStrictPairRecords } = require("../dispatch/strict-approval");
const lifecycle = require("./operation-lifecycle");
const { readLeaseState, writeLeaseState } = require("../coordination/lease-store");

function fail(code) { const e = new Error(code); e.code = code; throw e; }
function iso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
const now = () => new Date().toISOString();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
function readBoundedBytes(file) {
  const limit = 1024 * 1024;
  if (![fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK].every((flag) => Number.isInteger(flag) && flag > 0)) fail("ERR_FIXTURE_PLATFORM");
  const stable = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
  let fd, observed = false;
  try {
    const leaf = fs.lstatSync(file);
    observed = true;
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 || leaf.size > limit) fail("ERR_FIXTURE_SOURCE_UNSAFE");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || !stable(leaf, before)) fail("ERR_FIXTURE_SOURCE_CHANGED");
    // Bound allocation and total reads even if a cooperative writer grows the file.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (length > limit || length !== before.size || !after.isFile() || !current.isFile()
      || current.isSymbolicLink() || !stable(before, after) || !stable(after, current)) fail("ERR_FIXTURE_SOURCE_CHANGED");
    const bytes = buffer.subarray(0, length);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) fail("ERR_FIXTURE_SOURCE_UTF8");
    return bytes;
  } catch (error) {
    if (observed && error.code === "ENOENT") fail("ERR_FIXTURE_SOURCE_CHANGED");
    if (error.code === "ELOOP") fail("ERR_FIXTURE_SOURCE_UNSAFE");
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readBytes(file, optional = false) {
  try { return readBoundedBytes(file); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}
class BoundFixtureStore extends FilesystemGovernanceStore {
  constructor(root, assertWrite) { super(root); this.assertWrite = assertWrite; }
  readText(key, options = {}) {
    const file = this.resolve(key);
    const bytes = readBytes(file, options.required === false);
    return bytes === null
      ? { ok: true, exists: false, content: null, revision: null, path: file }
      : { ok: true, exists: true, content: bytes.toString("utf8"), revision: createFilesystemRevision(bytes), path: file };
  }
  writeJson(key, value) {
    this.assertWrite();
    const file = this.resolve(key);
    atomicJson(file, value);
    return { ok: true, path: file, revision: this.getRevision(key) };
  }
}
function fixtureRoot(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) fail("ERR_FIXTURE_ROOT");
  const root = fs.realpathSync(input);
  if (root !== path.resolve(input) || path.dirname(root) !== fs.realpathSync(os.tmpdir())
    || !/^cortex-l3-fixture-[A-Za-z0-9_-]+$/.test(path.basename(root))) fail("ERR_FIXTURE_ROOT");
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("ERR_FIXTURE_ROOT");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("ERR_FIXTURE_OWNER");
  for (const segment of [".agent", ".agent/decisions", ".agent/waitpoints", ".agent/authorizations", ".agent/artifacts"]) {
    const full = path.join(root, segment);
    const info = fs.lstatSync(full);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(full) !== full) fail("ERR_FIXTURE_SOURCE");
  }
  for (const segment of [".agent-runtime", ".agent-runtime/strict-fixture", ".agent-runtime/strict-fixture/leases", ".agent/operations", ".agent/readiness", "fixture-artifacts"]) {
    const full = path.join(root, segment);
    let info;
    try { info = fs.lstatSync(full); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(full) !== full) fail("ERR_FIXTURE_SOURCE");
  }
  if (fs.existsSync(path.join(root, ".git"))) fail("ERR_FIXTURE_NOT_FRESH");
  return root;
}
function scopeFrom(store) {
  const record = store.readJson("artifacts/strict-fixture-scope.json");
  const scope = record.value;
  const keys = ["schema_version", "kind", "project_ref", "owner_ref", "owner_workflow", "decision_id",
    "waitpoint_id", "task_ids", "authorization_ids", "expires_at", "max_task_ms", "max_total_ms"];
  if (!scope || typeof scope !== "object" || Object.keys(scope).some((key) => !keys.includes(key))
    || scope.schema_version !== 1 || scope.kind !== "synthetic_l3_fixture"
    || !/^project:fixture-[A-Za-z0-9_-]+$/.test(scope.project_ref || "")
    || scope.owner_ref !== "fixture-owner" || scope.owner_workflow !== "/mission"
    || scope.decision_id !== "D-FIXTURE" || scope.waitpoint_id !== "WP-FIXTURE"
    || JSON.stringify(scope.task_ids) !== JSON.stringify(["T-FIXTURE-1", "T-FIXTURE-2", "T-FIXTURE-3"])
    || JSON.stringify(scope.authorization_ids) !== JSON.stringify(["A-FIXTURE-1", "A-FIXTURE-2", "A-FIXTURE-3"])
    || !Number.isInteger(scope.max_task_ms) || scope.max_task_ms < 1 || scope.max_task_ms > 10000
    || !Number.isInteger(scope.max_total_ms) || scope.max_total_ms < 1 || scope.max_total_ms > 60000
    || iso(scope.expires_at) === null || iso(scope.expires_at) <= Date.now()
    || iso(scope.expires_at) > Date.now() + 300000) fail("ERR_FIXTURE_SCOPE");
  return { scope, revision: record.revision.value };
}

// Subordinate read-only integrity check. Receipt bytes never grant authority
// and never establish Task acceptance, tests, review or process-tree exit.
function receiptFiles(root, runs) {
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) fail("ERR_FIXTURE_STATE");
  const result = [];
  for (const run of Object.values(runs)) {
    if (!run || typeof run !== "object") fail("ERR_FIXTURE_STATE");
    if (!run.effect || run.effect.status !== "receipt") continue;
    if (!/^T-FIXTURE-[123]$/.test(run.task_id || "") || !/^[a-f0-9]{64}$/.test(run.effect.sha256 || "")) fail("ERR_FIXTURE_RECEIPT");
    const file = path.join(root, "fixture-artifacts", run.task_id + ".txt");
    const bytes = readBytes(file), actual = digest(bytes);
    if (actual !== run.effect.sha256) fail("ERR_FIXTURE_OUTPUT_CHANGED");
    result.push([file, actual]);
  }
  return result;
}

function openStrictFixtureSink(options = {}) {
  if (options.enabled !== true) {
    const disabled = () => fail("ERR_STRICT_FIXTURE_DISABLED");
    return Object.freeze({ onStart: disabled, beforeSpawn: disabled, onProposal: disabled, onStop: disabled,
      cancel: disabled, revoke: disabled, close() {}, inspect: () => ({ status: "DISABLED", effect_permitted: false }) });
  }
  if (options.fixtureOnly !== true) fail("ERR_FIXTURE_ONLY");
  if (Object.keys(options).some((key) => !["enabled", "fixtureOnly", "projectRoot"].includes(key))) fail("ERR_FIXTURE_OPTIONS");
  const root = fixtureRoot(options.projectRoot);
  let busy = false, closed = false, compromised = false, lockFd;
  const assertWrite = () => { if (!busy || closed) fail("ERR_FIXTURE_TRANSACTION_REQUIRED"); };
  const store = new BoundFixtureStore(path.join(root, ".agent"), assertWrite);
  const pinned = scopeFrom(store);
  const scope = pinned.scope;
  const resource = "artifact:strict-fixture-scope@" + pinned.revision;
  const runtimeDir = path.join(root, ".agent-runtime", "strict-fixture");
  const leasesDir = path.join(runtimeDir, "leases");
  const stateFile = path.join(runtimeDir, "state.json");
  const lockFile = path.join(runtimeDir, "writer.lock");
  const outputDir = path.join(root, "fixture-artifacts");
  const session = "fixture-session-" + crypto.randomUUID();
  const ownerToken = crypto.randomUUID();
  let state;
  let expected;

  function authFor(taskId) {
    const index = scope.task_ids.indexOf(taskId);
    if (index < 0) fail("ERR_FIXTURE_TASK");
    const a = store.readJson("authorizations/" + scope.authorization_ids[index] + ".json").value;
    const target = "fixture-artifacts/" + taskId + ".txt";
    if (!a || a.schema_version !== "1.0" || a.authorization_id !== scope.authorization_ids[index]
      || a.decision_id !== scope.decision_id || a.decision_source !== ".agent/decisions/D-FIXTURE.json"
      || a.policy !== "fixture-only" || a.child_inheritance !== false || !a.validity || a.validity.mode !== "single"
      || !Array.isArray(a.consumed_operation_ids) || a.consumed_operation_ids.length > 1
      || !a.scope || Object.keys(a.scope).sort().join(",") !== "relative_path,repository,revision,task_id"
      || a.scope.revision !== pinned.revision || a.scope.repository !== scope.project_ref
      || a.scope.task_id !== taskId || a.scope.relative_path !== target
      || iso(a.expires_at) === null || iso(a.expires_at) > iso(scope.expires_at)
      || a.revision !== lifecycle.stableHash({ decision_id: a.decision_id, scope: a.scope, validity: a.validity })) fail("ERR_FIXTURE_AUTHORIZATION");
    return a;
  }
  function gate(taskId) {
    const currentScope = scopeFrom(store);
    if (currentScope.revision !== pinned.revision) fail("ERR_FIXTURE_SCOPE_CHANGED");
    const d = store.readJson("decisions/D-FIXTURE.json").value;
    const w = store.readJson("waitpoints/WP-FIXTURE.json").value;
    validateStrictPairRecords(d, w, { taskId, decisionId: scope.decision_id, waitpointId: scope.waitpoint_id,
      ownerWorkflow: scope.owner_workflow, resourceRef: resource });
    if (!d.relations.artifact_refs.includes(resource) || !w.relations.artifact_refs.includes(resource)
      || d.resolved_by !== "fixture-user" || w.released_by !== scope.owner_ref) fail("ERR_FIXTURE_PROVENANCE");
    const a = authFor(taskId);
    if (a.revoked_at !== null || iso(a.expires_at) <= Date.now()) fail("ERR_FIXTURE_REVOKED_OR_EXPIRED");
    return a;
  }
  // Validate the entire synthetic envelope before creating any runtime state.
  for (const taskId of scope.task_ids) gate(taskId);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    lockFd = fs.openSync(lockFile, "wx", 0o600);
    fs.writeFileSync(lockFd, JSON.stringify({ ownerToken, pid: process.pid, fixture_only: true }));
    fs.fsyncSync(lockFd);
  } catch (error) {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    fail(error.code === "EEXIST" ? "ERR_FIXTURE_WRITER_OR_RECOVERY_REQUIRED" : "ERR_FIXTURE_LOCK");
  }
  function saveState() { assertWrite(); atomicJson(stateFile, state); }
  function watchFiles() {
    const files = ["artifacts/strict-fixture-scope.json", "decisions/D-FIXTURE.json", "waitpoints/WP-FIXTURE.json",
      ...scope.authorization_ids.map((id) => "authorizations/" + id + ".json"),
      "operations/events.jsonl",
      ...Object.values(state.runs).map((run) => "operations/" + run.operation_id + ".json")].map((key) => store.resolve(key));
    files.push(path.join(leasesDir, "state.json"), path.join(leasesDir, "idempotency.json"), stateFile);
    const authority = files.map((file) => [file, readBytes(file, true)])
      .map(([file, bytes]) => [file, bytes === null ? null : digest(bytes)]);
    return authority.concat(receiptFiles(root, state.runs));
  }
  function assertOwner() {
    if (closed) fail("ERR_FIXTURE_CLOSED");
    const held = fs.fstatSync(lockFd);
    const current = fs.lstatSync(lockFile);
    const lock = JSON.parse(readBytes(lockFile));
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== held.ino || current.dev !== held.dev
      || lock.ownerToken !== ownerToken || lock.pid !== process.pid) fail("ERR_FIXTURE_LOCK_LOST");
  }
  function transaction(fn, allowStopped = false) {
    if (busy) fail("ERR_FIXTURE_REENTRANT");
    if (compromised) fail("ERR_FIXTURE_QUARANTINED");
    try {
      fixtureRoot(root);
      assertOwner();
      if (JSON.stringify(watchFiles()) !== JSON.stringify(expected)) fail("ERR_FIXTURE_EXTERNAL_WRITER");
    } catch (error) { compromised = true; state.quarantined = true; throw error; }
    busy = true;
    try {
      if (!allowStopped && (state.revoked || state.quarantined)) fail("ERR_FIXTURE_STOPPED");
      const value = fn();
      if (value && typeof value.then === "function") fail("ERR_FIXTURE_ASYNC_TRANSACTION");
      expected = watchFiles();
      return value;
    } catch (error) {
      state.quarantined = true;
      try { saveState(); expected = watchFiles(); } catch (_) {}
      throw error;
    } finally { busy = false; }
  }
  try {
    const previous = readBytes(stateFile, true);
    if (previous !== null) fail("ERR_FIXTURE_RECOVERY_REQUIRED");
    if (fs.existsSync(path.join(root, ".agent/operations")) || fs.existsSync(outputDir)
      || readBytes(path.join(leasesDir, "state.json"), true) !== null
      || readBytes(path.join(leasesDir, "idempotency.json"), true) !== null) fail("ERR_FIXTURE_NOT_FRESH");
    fs.mkdirSync(outputDir, { mode: 0o700 });
    state = { schema_version: 1, evidence_kind: "synthetic_process_fixture", scope_revision: pinned.revision,
      started_at: null, deadline: null, revoked: false, quarantined: false, runs: {} };
    busy = true; saveState(); busy = false;
    expected = watchFiles();
  } catch (error) {
    try { assertOwner(); fs.unlinkSync(lockFile); } catch (_) {}
    fs.closeSync(lockFd); lockFd = undefined;
    throw error;
  }
  function runFor(ref) {
    const run = state.runs[ref];
    if (!run) fail("ERR_FIXTURE_RUN_UNKNOWN");
    return run;
  }
  function evidence(run, proposalId) {
    return Object.freeze({ kind: "runtime_evidence", run_ref: run.run_ref, task_id: run.task_id,
      ...(proposalId ? { proposal_id: proposalId } : {}),
      evidence_refs: ["fixture-evidence:" + run.operation_id] });
  }
  function currentOperation(run) {
    const recovered = lifecycle.recoverOperation(root, run.operation_id);
    if (!recovered) fail("ERR_FIXTURE_OPERATION_MISSING");
    const op = recovered.resource;
    const index = scope.task_ids.indexOf(run.task_id);
    if (op.operation_id !== run.operation_id || op.attempt !== 1 || op.kind !== "fixture_effect"
      || op.relations.task_id !== run.task_id || op.relations.run_id !== run.run_ref
      || op.relations.session_id !== session || op.relations.workspace_id !== scope.project_ref
      || op.actor.session_id !== session || op.owner !== scope.owner_ref || op.workflow !== scope.owner_workflow
      || op.action.kind !== "fixture.record" || op.target.repository !== scope.project_ref
      || op.target.relative_path !== "fixture-artifacts/" + run.task_id + ".txt"
      || op.target_revision !== pinned.revision
      || (op.authorization_ref !== null && op.authorization_ref !== scope.authorization_ids[index])) fail("ERR_FIXTURE_OPERATION_BINDING");
    return op;
  }
  function transition(run, to, context = {}) {
    return lifecycle.writeTransition(root, currentOperation(run), to, { at: now(), ...context }).operation;
  }
  function onStart(input) {
    return transaction(() => {
      if (!input || !/^run:[A-Za-z0-9_-]{1,120}$/.test(input.run_ref || "")) fail("ERR_FIXTURE_RUN_REF");
      if (state.runs[input.run_ref] || Object.values(state.runs).some((run) => run.task_id === input.task_id)) fail("ERR_FIXTURE_ATTEMPT_BUDGET");
      const index = scope.task_ids.indexOf(input.task_id);
      if (index < 0 || Object.values(state.runs).some((run) => !["succeeded", "canceled", "timed_out", "failed"].includes(run.status))) fail("ERR_FIXTURE_PARALLEL_BUDGET");
      if (index > 0 && !Object.values(state.runs).some((run) => run.task_id === scope.task_ids[index - 1] && run.status === "succeeded")) fail("ERR_FIXTURE_DEPENDENCY");
      const auth = gate(input.task_id);
      const at = Date.now();
      if (state.deadline !== null && at >= state.deadline) fail("ERR_FIXTURE_TIME_BUDGET");
      if (state.started_at === null) { state.started_at = now(); state.deadline = Math.min(at + scope.max_total_ms, iso(scope.expires_at)); }
      if (state.deadline <= at) fail("ERR_FIXTURE_TIME_BUDGET");
      const manager = readLeaseState(leasesDir);
      const lease = manager.acquire("task:" + input.task_id, scope.owner_ref,
        { actorId: session, ttl: Math.min(scope.max_task_ms + 2000, state.deadline - at), evidence: [resource], idempotencyKey: input.run_ref });
      writeLeaseState(leasesDir, manager);
      const run = { run_ref: input.run_ref, task_id: input.task_id, operation_id: "OP-" + input.run_ref.slice(4),
        status: "running", started_at: now(), deadline: Math.min(at + scope.max_task_ms, state.deadline),
        lease_id: lease.leaseId, fencing_token: lease.fencingToken, canceled: false, effect: null, process_exited: false, process_stopped: false };
      state.runs[input.run_ref] = run; saveState();
      let operation = lifecycle.createOperation({ operation_id: run.operation_id, attempt: 1, kind: "fixture_effect",
        relations: { task_id: run.task_id, run_id: run.run_ref, session_id: session, workspace_id: scope.project_ref },
        owner: scope.owner_ref, workflow: scope.owner_workflow, actor: { session_id: session },
        action: { kind: "fixture.record" }, target: { repository: scope.project_ref, relative_path: auth.scope.relative_path },
        target_revision: pinned.revision, created_at: now() });
      lifecycle.writeAttempt(root, operation);
      const readiness = lifecycle.createReadiness({ revision: pinned.revision, verdict: "ready", inspected_at: now(),
        operation: { operation_id: operation.operation_id }, resolved: { fixture_only: true } });
      operation = transition(run, "inspected", { readiness });
      // Do not let the legacy authorization helper steal any stale nested lock.
      if (fs.existsSync(store.resolve("authorizations/" + auth.authorization_id + ".json.lock"))) fail("ERR_FIXTURE_RECOVERY_REQUIRED");
      const consumed = lifecycle.consumeAuthorization(root, auth, operation, now());
      operation = transition(run, "authorized", { authorization: consumed });
      transition(run, "executing");
      return evidence(run);
    });
  }
  function beforeSpawn(input) {
    return transaction(() => {
      const run = runFor(input.run_ref);
      if (input.task_id !== run.task_id || typeof input.assertActive !== "function") fail("ERR_FIXTURE_RUN_MISMATCH");
      input.assertActive();
      if (run.canceled || run.status !== "running" || Date.now() >= run.deadline || Date.now() >= state.deadline) fail("ERR_FIXTURE_STOPPED");
      const auth = gate(run.task_id);
      const operation = currentOperation(run);
      lifecycle.authorizeForOperation(auth, operation, now());
      if (operation.status !== "executing" || operation.authorization_ref !== auth.authorization_id || !auth.consumed_operation_ids.includes(run.operation_id)) fail("ERR_FIXTURE_AUTHORIZATION");
      const manager = readLeaseState(leasesDir);
      const lease = manager.getLease(run.lease_id);
      if (!lease || !manager.isActive(lease) || lease.scope !== "task:" + run.task_id || lease.owner !== scope.owner_ref
        || lease.actorId !== session || lease.fencingToken !== run.fencing_token
        || manager.getFencingToken(lease.scope) !== run.fencing_token
        || manager.listTakeovers({ status: "pending" }).some((takeover) => takeover.scope === lease.scope)) fail("ERR_FIXTURE_FENCE");
      input.assertActive();
      return evidence(run);
    });
  }
  function onProposal(input) {
    return transaction(() => {
      const run = runFor(input.run_ref);
      if (input.task_id !== run.task_id || input.proposal_id !== "P-FIXTURE-" + run.task_id.slice(-1)
        || !input.proposal || input.proposal.kind !== "fixture.record" || input.proposal.task_id !== run.task_id
        || Object.keys(input.proposal).sort().join(",") !== "kind,task_id" || typeof input.assertActive !== "function") fail("ERR_FIXTURE_PROPOSAL");
      input.assertActive();
      if (run.canceled || run.status !== "running" || Date.now() >= run.deadline || Date.now() >= state.deadline) fail("ERR_FIXTURE_STOPPED");
      const auth = gate(run.task_id);
      const operation = currentOperation(run);
      lifecycle.authorizeForOperation(auth, operation, now());
      if (operation.status !== "executing" || operation.authorization_ref !== auth.authorization_id || !auth.consumed_operation_ids.includes(run.operation_id)) fail("ERR_FIXTURE_AUTHORIZATION");
      const manager = readLeaseState(leasesDir);
      const lease = manager.getLease(run.lease_id);
      if (!lease || !manager.isActive(lease) || lease.scope !== "task:" + run.task_id || lease.owner !== scope.owner_ref
        || lease.actorId !== session || lease.fencingToken !== run.fencing_token
        || manager.getFencingToken(lease.scope) !== run.fencing_token
        || manager.listTakeovers({ status: "pending" }).some((takeover) => takeover.scope === lease.scope)) fail("ERR_FIXTURE_FENCE");
      if (run.effect) {
        if (run.effect.proposal_id !== input.proposal_id || run.effect.status !== "receipt") fail("ERR_FIXTURE_EFFECT_UNKNOWN");
        return evidence(run, input.proposal_id);
      }
      const target = path.join(outputDir, run.task_id + ".txt");
      if (fs.realpathSync(outputDir) !== outputDir || fs.lstatSync(outputDir).isSymbolicLink()) fail("ERR_FIXTURE_SINK_ESCAPE");
      const bytes = Buffer.from("Synthetic fixture completed: " + run.task_id + "\n");
      run.effect = { proposal_id: input.proposal_id, status: "intent", at: now() };
      saveState(); // Durable intent precedes the effect. It is never replayed.
      input.assertActive(); // Runtime cancellation guard, not an authorization token.
      gate(run.task_id); // Recheck finite validity after fsync of the intent.
      if (Date.now() >= run.deadline || Date.now() >= state.deadline || !manager.isActive(lease)) fail("ERR_FIXTURE_STOPPED");
      const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const dir = fs.openSync(outputDir, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      run.effect = { ...run.effect, status: "receipt", sha256: digest(bytes), completed_at: now() };
      saveState();
      return evidence(run, input.proposal_id);
    });
  }
  function onStop(input) {
    return transaction(() => {
      const run = runFor(input.run_ref);
      if (input.task_id !== run.task_id) fail("ERR_FIXTURE_RUN_MISMATCH");
      const status = input.status === "exited" ? "succeeded" : input.status;
      const noProcess = input.spawned === false && input.process_outcome === "not_started";
      const certain = (input.process_exited === true || noProcess) && ["succeeded", "canceled", "timed_out", "failed"].includes(status);
      run.spawned = input.spawned === true;
      run.process_exited = input.process_exited === true;
      run.process_stopped = input.process_exited === true || noProcess;
      run.status = certain && (status !== "succeeded" || run.effect?.status === "receipt") ? status : "unknown";
      if (run.status === "unknown") state.quarantined = true;
      saveState();
      const operation = currentOperation(run);
      if (operation.status === "executing") transition(run, run.status === "unknown" ? "blocked" : run.status);
      if (run.status !== "unknown") {
        const manager = readLeaseState(leasesDir);
        manager.release(run.lease_id, { actorId: session,
          evidence: [run.process_exited ? "fixture-process-exited" : "fixture-process-stopped-not-spawned"] });
        writeLeaseState(leasesDir, manager);
      }
      return evidence(run);
    }, true);
  }
  function cancel(ref) { return transaction(() => { const run = runFor(ref); run.canceled = true; saveState(); return evidence(run); }, true); }
  function revoke() {
    return transaction(() => {
      state.revoked = true; saveState(); // Deny-first durable tombstone.
      for (const id of scope.authorization_ids) {
        const key = "authorizations/" + id + ".json";
        const auth = store.readJson(key).value;
        store.writeJson(key, { ...auth, revoked_at: now() });
      }
      return { revoked: true, fixture_only: true };
    }, true);
  }
  function inspect() {
    return Object.freeze({ fixture_only: true, effect_permitted: false, quarantined: state.quarantined,
      revoked: state.revoked, runs: Object.values(state.runs).map((run) => ({ run_ref: run.run_ref, task_id: run.task_id, status: run.status })) });
  }
  function close() {
    if (closed) return;
    if (compromised) fail("ERR_FIXTURE_QUARANTINED");
    assertOwner();
    if (Object.values(state.runs).some((run) => !run.process_stopped || run.status === "unknown")) fail("ERR_FIXTURE_RECOVERY_REQUIRED");
    fs.unlinkSync(lockFile); fs.closeSync(lockFd); lockFd = undefined; closed = true;
  }
  return Object.freeze({ onStart, beforeSpawn, onProposal, onStop, cancel, revoke, inspect, close,
    limits: Object.freeze({ maxTaskMs: scope.max_task_ms, maxTotalMs: scope.max_total_ms }) });
}

function inspectStrictFixtureRecovery(projectRoot) {
  const root = fixtureRoot(projectRoot);
  const file = path.join(root, ".agent-runtime/strict-fixture/state.json");
  const bytes = readBytes(file, true);
  if (bytes === null) return Object.freeze({ status: "ABSENT", fixture_only: true, effect_permitted: false });
  const state = JSON.parse(bytes);
  if (state.schema_version !== 1 || state.evidence_kind !== "synthetic_process_fixture" || !state.runs) fail("ERR_FIXTURE_STATE");
  receiptFiles(root, state.runs);
  return Object.freeze({ status: "RECOVERY_REQUIRED", fixture_only: true, effect_permitted: false,
    runs: Object.values(state.runs).map((run) => ({ run_ref: run.run_ref, task_id: run.task_id,
      status: ["succeeded", "canceled", "timed_out", "failed"].includes(run.status) && run.process_stopped
        && (run.status !== "succeeded" || run.effect?.status === "receipt") ? run.status : "unknown" })) });
}

module.exports = { openStrictFixtureSink, inspectStrictFixtureRecovery };
