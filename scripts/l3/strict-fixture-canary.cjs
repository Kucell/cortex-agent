"use strict";

// REVIEW CANDIDATE ONLY. Importing this file does not execute a canary.
// The trusted launcher must independently authorize this exact script digest,
// source manifest and one invocation. Values passed here are binding assertions,
// not proof of human approval, owner identity, or canonical Mission completion.
// Linux-only, five fixed cooperative children, three fresh synthetic roots.
// This composes the real process factory and sink with trusted gate closures;
// it does not exercise the shipped createStrictFixtureRuntime wrapper.
// No CLI, network, install, arbitrary command, or user project is accepted.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { performance } = require("node:perf_hooks");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) => crypto.createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
const TASKS = Object.freeze(["T-FIXTURE-1", "T-FIXTURE-2", "T-FIXTURE-3"]);
const WORKER_PATH = "tests/fixtures/l3/strict-process-worker.cjs";
const REQUIRED_PATHS = Object.freeze(["lib/coordination/errors.js","lib/coordination/lease-store.js","lib/coordination/lease.js","lib/dispatch/strict-approval.js","lib/governance/root.js","lib/governance/store.js","lib/runtime-layout/identity.js","lib/runtime-layout/index.js","lib/runtime-layout/local-binding.js","lib/runtime-layout/logical-uri.js","lib/runtime-layout/resolver.js","lib/runtime-layout/schemas.js","lib/runtime-port/strict-fixture-process.js","lib/runtime-port/strict-fixture.js","lib/runtime-state/operation-lifecycle.js","lib/runtime-state/strict-fixture-sink.js","lib/security/scan.js","packages/project-sdk/src/governance.js","packages/protocol/src/capabilities.js","packages/protocol/src/events.js","packages/protocol/src/evolution.js","packages/protocol/src/index.js","packages/protocol/src/negotiation.js","packages/protocol/src/refs.js","packages/protocol/src/result.js","packages/protocol/src/timeline.js","packages/protocol/src/version.js","packages/runtime-port/src/index.js","packages/runtime-port/src/topology.js","templates/_shared/.agent/decisions/decision.schema.json","templates/_shared/.agent/waitpoints/waitpoint.schema.json","tests/dispatch/strict-approval.test.js","tests/fixtures/l3/strict-process-worker.cjs","tests/runtime-port/strict-fixture-process.test.js","tests/runtime-port/strict-fixture.test.js","tests/runtime-state/strict-fixture-sink.test.js"]);
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function check(ok, code) { if (!ok) fail(code); }
function read(file, limit = 2 * 1024 * 1024) {
  check([fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK].every((n) => Number.isInteger(n) && n > 0), "CANARY_PLATFORM");
  const a = fs.lstatSync(file);
  check(a.isFile() && !a.isSymbolicLink() && a.nlink === 1 && a.size <= limit, "CANARY_FILE_TYPE");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const same = (x, y) => x.dev === y.dev && x.ino === y.ino && x.size === y.size
      && x.mtimeMs === y.mtimeMs && x.ctimeMs === y.ctimeMs && x.nlink === y.nlink;
    const b = fs.fstatSync(fd); check(same(a, b), "CANARY_FILE_CHANGED");
    const buffer = Buffer.alloc(limit + 1); let n = 0;
    while (n < buffer.length) { const got = fs.readSync(fd, buffer, n, buffer.length - n, n); if (!got) break; n += got; }
    check(n === b.size && n <= limit && same(b, fs.fstatSync(fd)) && same(b, fs.lstatSync(file)), "CANARY_FILE_CHANGED");
    return buffer.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
function json(file) { return JSON.parse(read(file).toString("utf8")); }
function createJson(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function canonicalDirectory(input) {
  check(typeof input === "string" && path.isAbsolute(input), "CANARY_DIRECTORY");
  const root = fs.realpathSync(input);
  check(root === path.resolve(input) && fs.lstatSync(root).isDirectory(), "CANARY_DIRECTORY");
  return root;
}
function processIdentity(record) {
  const dir = "/proc/" + record.child.pid;
  const raw = fs.readFileSync(dir + "/stat", "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
  check(Number(fields[1]) === process.pid && Number(fields[2]) === record.child.pid && Number(fields[3]) === record.child.pid, "CANARY_PID_PARENT_GROUP");
  check(fs.realpathSync(dir + "/exe") === fs.realpathSync(process.execPath), "CANARY_PID_EXECUTABLE");
  check(fs.realpathSync(dir + "/cwd") === record.root, "CANARY_PID_CWD");
  const argv = fs.readFileSync(dir + "/cmdline").toString("utf8").split("\0").filter(Boolean);
  check(argv.length === 2 && argv[0] === process.execPath && argv[1] === record.worker, "CANARY_PID_ARGV");
  check(/^\d+$/.test(fields[19] || ""), "CANARY_PID_STARTTIME");
  return { starttime: fields[19], state: fields[0] };
}
function evidenceInventory(root) {
  const files = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), info = fs.lstatSync(file);
      check(!info.isSymbolicLink(), "CANARY_EVIDENCE_SYMLINK");
      if (info.isDirectory()) walk(file);
      else {
        const bytes = read(file);
        files.push({ path: path.relative(root, file), bytes: bytes.length, sha256: hash(bytes) });
      }
    }
  }
  walk(root); return files;
}
async function runTierICanary(launch) {
  if (!launch || launch.enabled !== true) return Object.freeze({ status: "DISABLED", executed: false });
  const allowed = ["enabled", "source_root", "source_head", "code_blobs", "script_sha256", "worker_sha256",
    "job_id", "invocation_id", "expires_at"];
  check(Object.keys(launch).every((key) => allowed.includes(key)) && allowed.every((key) => Object.hasOwn(launch, key)), "CANARY_LAUNCH_KEYS");
  const cfg = JSON.parse(JSON.stringify(launch)); // Capture input once; never use a live caller object.
  check(process.platform === "linux" && [22, 24].includes(Number(process.versions.node.split(".")[0])), "CANARY_PLATFORM");
  check(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, "CANARY_MODULE_ENV");
  check(/^[a-f0-9]{40}$/.test(cfg.source_head) && /^[a-f0-9]{64}$/.test(cfg.script_sha256)
    && /^[a-f0-9]{64}$/.test(cfg.worker_sha256), "CANARY_DIGEST");
  check(/^[A-Za-z0-9:_-]{1,160}$/.test(cfg.job_id) && /^[a-f0-9-]{36}$/.test(cfg.invocation_id), "CANARY_INVOCATION");
  const start = performance.now(), wallStart = Date.now(), expiry = Date.parse(cfg.expires_at);
  check(Number.isFinite(expiry) && expiry > wallStart && expiry <= wallStart + 60000, "CANARY_EXPIRY");
  const source = canonicalDirectory(cfg.source_root), temp = fs.realpathSync(os.tmpdir());
  const ownFile = fs.realpathSync(__filename), scriptDigest = hash(read(ownFile));
  check(scriptDigest === cfg.script_sha256, "CANARY_SCRIPT_CHANGED");
  const paths = Object.keys(cfg.code_blobs).sort();
  check(JSON.stringify(paths) === JSON.stringify(REQUIRED_PATHS), "CANARY_MANIFEST");
  for (const name of paths) check(/^(lib|packages|templates|tests)\/[A-Za-z0-9_./-]+$/.test(name)
    && !name.split("/").includes("..") && /^[a-f0-9]{40}$/.test(cfg.code_blobs[name]), "CANARY_MANIFEST");
  const verifyCode = () => {
    check(hash(read(ownFile)) === scriptDigest, "CANARY_SCRIPT_CHANGED");
    for (const name of paths) {
      const file = path.join(source, name);
      check(fs.realpathSync(file) === file && gitBlob(read(file)) === cfg.code_blobs[name], "CANARY_CODE_CHANGED");
    }
    check(hash(read(path.join(source, WORKER_PATH))) === cfg.worker_sha256, "CANARY_WORKER_CHANGED");
  };
  verifyCode();
  for (const name of paths.filter((name) => /\.[cm]?js$/.test(name))) {
    check(!require.cache[path.join(source, name)], "CANARY_PRELOADED_MODULE");
  }
  // The trusted launcher must also materialize the complete closed manifest,
  // with no node_modules or global alias fallback. No package installation.
  for (const searchRoot of new Set([source, ...paths.filter((name) => /\.[cm]?js$/.test(name)).map((name) => path.dirname(path.join(source, name)))])) {
    try { require.resolve("@cortex-agent/protocol", { paths: [searchRoot] }); fail("CANARY_EXTERNAL_ALIAS"); }
    catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }
  }
  const { openStrictFixtureSink } = require(path.join(source, "lib/runtime-state/strict-fixture-sink.js"));
  const { createStrictFixtureProcessRuntime } = require(path.join(source, "lib/runtime-port/strict-fixture-process.js"));
  const { createAuthorization } = require(path.join(source, "lib/runtime-state/operation-lifecycle.js"));
  const { createFilesystemRevision } = require(path.join(source, "lib/governance/store.js"));
  const { readLeaseState } = require(path.join(source, "lib/coordination/lease-store.js"));
  const roots = [], children = [], results = [], events = [];
  const originalSpawn = cp.spawn, originalKill = process.kill;
  let active = null, fatal = null, closed = false;
  const recordEvent = (event, detail = {}) => events.push({ event, elapsed_ms: Math.round(performance.now() - start), ...detail });
  const within = () => {
    check(performance.now() - start < 45000 && Date.now() < expiry, "CANARY_DEADLINE");
    check(!fatal && !closed, "CANARY_STOPPED");
  };
  function admit(context, stage, input) {
    within(); verifyCode();
    check(canonicalDirectory(context.root) === context.root && path.dirname(context.root) === temp, "CANARY_ROOT");
    const st = fs.lstatSync(context.root);
    check((st.mode & 0o077) === 0 && st.uid === process.getuid(), "CANARY_ROOT_OWNER");
    check(hash(read(context.bindingFile)) === context.bindingDigest, "CANARY_BINDING_CHANGED");
    const binding = json(context.bindingFile);
    check(binding.root === context.root && binding.project_ref === context.projectRef
      && binding.job_id === cfg.job_id && binding.invocation_id === cfg.invocation_id
      && binding.source_head === cfg.source_head && binding.script_sha256 === scriptDigest
      && binding.expires_at === cfg.expires_at, "CANARY_BINDING");
    if (input) {
      check(TASKS.includes(input.task_id), "CANARY_TASK");
      if (stage === "start") {
        check(!context.runBindings.has(input.run_ref), "CANARY_REPLAY");
        context.runBindings.set(input.run_ref, Object.freeze({ task_id: input.task_id,
          project_ref: context.projectRef, job_id: cfg.job_id, source_head: cfg.source_head,
          root: context.root, script_sha256: scriptDigest, expires_at: cfg.expires_at }));
      }
      check(context.runBindings.get(input.run_ref)?.task_id === input.task_id, "CANARY_RUN_BINDING");
    }
  }
  function signal(record, name) {
    if (record.exited) return false;
    const identity = processIdentity(record);
    check(identity.starttime === record.identity.starttime, "CANARY_PID_REUSED");
    originalKill(-record.child.pid, name);
    recordEvent("signal_requested", { root: record.root, pid: record.child.pid, starttime: identity.starttime, signal: name });
    return true;
  }
  process.kill = (pid, name) => {
    check(Number.isInteger(pid) && pid < 0 && ["SIGTERM", "SIGKILL"].includes(name), "CANARY_SIGNAL_SCOPE");
    const record = children.find((item) => item.child.pid === -pid && !item.exited);
    if (!record) throw Object.assign(new Error("Owned leader no longer observed"), { code: "ESRCH" });
    signal(record, name); return true;
  };
  cp.spawn = (executable, argv, options) => {
    within(); check(active && children.filter((item) => !item.exited).length === 0 && children.length < 5, "CANARY_CHILD_BUDGET");
    admit(active, "spawn", active.current);
    check(executable === process.execPath && JSON.stringify(argv) === JSON.stringify([path.join(source, WORKER_PATH)])
      && options.cwd === active.root && options.shell === false && options.detached === true
      && JSON.stringify(options.env) === JSON.stringify({ LANG: "C", LC_ALL: "C", TZ: "UTC" })
      && JSON.stringify(options.stdio) === JSON.stringify(["ignore", "ignore", "ignore", "ipc"]), "CANARY_SPAWN_SCOPE");
    const context = active, child = originalSpawn(executable, argv, options);
    const record = { child, root: context.root, worker: argv[0], exited: false, identity: null, exit_code: null, exit_signal: null };
    children.push(record);
    child.once("exit", (code, sig) => {
      record.exited = true; record.exit_code = code; record.exit_signal = sig;
      recordEvent("leader_exit_observed", { root: record.root, pid: child.pid, code, signal: sig });
    });
    child.prependOnceListener("spawn", () => {
      try {
        record.identity = processIdentity(record);
        recordEvent("leader_spawn_observed", { root: record.root, pid: child.pid, starttime: record.identity.starttime });
        if (context.mode === "revoke") {
          context.sink.revoke(); recordEvent("synthetic_revocation_written", { root: context.root });
          context.runtime.port.cancel(context.current.run_ref);
        } else if (context.mode === "escalation") {
          signal(record, "SIGSTOP");
          const end = performance.now() + 250, cell = new Int32Array(new SharedArrayBuffer(4));
          let state;
          do {
            const identity = processIdentity(record);
            check(identity.starttime === record.identity.starttime, "CANARY_PID_REUSED"); state = identity.state;
            if (state === "T" || state === "t") break;
            Atomics.wait(cell, 0, 0, 1);
          } while (performance.now() < end);
          check(state === "T" || state === "t", "CANARY_STOP_UNOBSERVED");
          recordEvent("leader_stop_observed", { root: record.root, pid: child.pid, state });
          context.sink.cancel(context.current.run_ref); context.runtime.port.cancel(context.current.run_ref);
        }
      } catch (e) {
        fatal = e.code || "CANARY_OBSERVER_FAILED";
        try { context.runtime.port.cancel(context.current.run_ref); } catch (_) {}
      }
    });
    return child;
  };
  function seed(mode) {
    within();
    const root = fs.mkdtempSync(path.join(temp, "cortex-l3-fixture-"));
    const context = { root, mode, projectRef: "project:fixture-" + crypto.randomUUID(), runBindings: new Map(), current: null };
    roots.push(context);
    for (const dir of ["decisions", "waitpoints", "authorizations", "artifacts"]) fs.mkdirSync(path.join(root, ".agent", dir), { recursive: true, mode: 0o700 });
    const scope = { schema_version: 1, kind: "synthetic_l3_fixture", project_ref: context.projectRef, owner_ref: "fixture-owner",
      owner_workflow: "/mission", decision_id: "D-FIXTURE", waitpoint_id: "WP-FIXTURE",
      task_ids: [...TASKS], authorization_ids: ["A-FIXTURE-1", "A-FIXTURE-2", "A-FIXTURE-3"],
      expires_at: cfg.expires_at, max_task_ms: 10000, max_total_ms: Math.max(1, Math.min(45000, expiry - Date.now())) };
    const scopeFile = path.join(root, ".agent/artifacts/strict-fixture-scope.json");
    createJson(scopeFile, scope); const revision = createFilesystemRevision(read(scopeFile)).value;
    const ref = "artifact:strict-fixture-scope@" + revision;
    const at = new Date().toISOString();
    const relations = { task_ids: [...TASKS], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [], artifact_refs: [ref], worktree_paths: [] };
    const gate = { action: "external_side_effect", resource_ref: ref };
    createJson(path.join(root, ".agent/decisions/D-FIXTURE.json"), { schema_version: 1, decision_id: "D-FIXTURE", type: "approval",
      status: "approved", requested_by: "fixture-owner", prompt: "Synthetic fixture input, not human approval.", options: ["approve", "reject"],
      selected_option: "approve", resolved_by: "fixture-user", resolved_at: at, rationale: "Synthetic fixture", gate, relations, created_at: at, updated_at: at });
    createJson(path.join(root, ".agent/waitpoints/WP-FIXTURE.json"), { schema_version: 1, waitpoint_id: "WP-FIXTURE", status: "released",
      owner_workflow: "/mission", reason: "Synthetic fixture", gate, decision_id: "D-FIXTURE", evidence_refs: [".agent/decisions/D-FIXTURE.json"],
      relations, released_by: "fixture-owner", released_at: at, release_note: "Synthetic fixture", expires_at: cfg.expires_at, created_at: at, updated_at: at });
    for (let i = 0; i < 3; i++) createJson(path.join(root, ".agent/authorizations/A-FIXTURE-" + (i + 1) + ".json"),
      createAuthorization({ authorization_id: "A-FIXTURE-" + (i + 1), decision_id: "D-FIXTURE", decision_source: ".agent/decisions/D-FIXTURE.json",
        policy: "fixture-only", reason: "Synthetic test input", scope: { repository: context.projectRef, revision, task_id: TASKS[i],
          relative_path: "fixture-artifacts/" + TASKS[i] + ".txt" }, validity: { mode: "single" }, created_at: at, expires_at: cfg.expires_at }));
    context.bindingFile = path.join(root, "canary-binding.json");
    createJson(context.bindingFile, { root, project_ref: context.projectRef, job_id: cfg.job_id, invocation_id: cfg.invocation_id,
      source_head: cfg.source_head, script_sha256: scriptDigest, expires_at: cfg.expires_at, scope_revision: revision, mode,
      synthetic_authority_only: true });
    context.bindingDigest = hash(read(context.bindingFile));
    context.sink = openStrictFixtureSink({ enabled: true, fixtureOnly: true, projectRoot: root });
    const wrap = (stage, fn) => (input) => {
      admit(context, stage, input);
      if (stage === "start") context.current = { run_ref: input.run_ref, task_id: input.task_id };
      return fn({ ...input, assertActive: () => { admit(context, "effect_guard", input); input.assertActive(); } });
    };
    context.runtime = createStrictFixtureProcessRuntime({ enabled: true, fixtureOnly: true, cwd: root,
      ...context.sink.limits, cancelGraceMs: 200,
      onStart: wrap("start", context.sink.onStart),
      onBeforeSpawn: wrap("before_spawn", context.sink.beforeSpawn),
      onBeforeSend: wrap("before_send", context.sink.beforeSpawn),
      onProposal: wrap("proposal", context.sink.onProposal),
      onStop: context.sink.onStop });
    return context;
  }
  async function one(context, task) {
    active = context; const before = children.length;
    const accepted = context.runtime.port.createRun({ task_id: task });
    check(accepted.accepted && children.length === before, "CANARY_RUNREF_NOT_IMMEDIATE");
    const outcome = await context.runtime.port.wait(accepted.run_ref, { timeout_ms: Math.min(13000, Math.max(1, expiry - Date.now())) });
    check(!outcome.wait_timed_out && !fatal && outcome.process_exited === true && outcome.process_tree_verified === false, "CANARY_OUTCOME_UNKNOWN");
    check(outcome.status === (context.mode === "success" ? "exited" : "canceled"), "CANARY_UNEXPECTED_STATUS");
    const state = json(path.join(context.root, ".agent-runtime/strict-fixture/state.json")), run = state.runs[accepted.run_ref];
    const operation = json(path.join(context.root, ".agent/operations/" + run.operation_id + ".json"));
    check(operation.relations.run_id === accepted.run_ref && operation.relations.task_id === task && operation.attempt === 1
      && operation.status === (context.mode === "success" ? "succeeded" : "canceled"), "CANARY_OPERATION");
    const authorization = json(path.join(context.root, ".agent/authorizations/A-FIXTURE-" + task.slice(-1) + ".json"));
    check(authorization.consumed_operation_ids.length === 1 && authorization.consumed_operation_ids[0] === run.operation_id,
      "CANARY_AUTHORIZATION_CONSUMPTION");
    if (context.mode === "revoke") check(state.revoked === true && typeof authorization.revoked_at === "string", "CANARY_REVOCATION");
    const manager = readLeaseState(path.join(context.root, ".agent-runtime/strict-fixture/leases"));
    const lease = manager.getLease(run.lease_id);
    check(lease && !manager.isActive(lease) && manager.getFencingToken(lease.scope) === run.fencing_token, "CANARY_LEASE_NOT_RELEASED");
    const releasedAt = Date.parse(lease.releasedAt);
    check(typeof lease.releasedAt === "string" && Number.isFinite(releasedAt)
      && new Date(releasedAt).toISOString() === lease.releasedAt && releasedAt >= Date.parse(lease.acquiredAt)
      && releasedAt <= Date.now() && lease.staleAt === null
      && lease.scope === "task:" + task && lease.actorId === operation.relations.session_id
      && lease.fencingToken === run.fencing_token, "CANARY_LEASE_RELEASE_BINDING");
    const releases = manager.getAuditLog({ eventType: "ownership.released", leaseId: run.lease_id });
    check(releases.length === 1, "CANARY_LEASE_RELEASE_AUDIT");
    const release = releases[0], releaseAuditAt = Date.parse(release.timestamp);
    check(release.scope === lease.scope && release.actor === operation.relations.session_id
      && release.fencingToken === run.fencing_token && release.reason === "released"
      && Number.isFinite(releaseAuditAt) && releaseAuditAt >= releasedAt && releaseAuditAt <= Date.now()
      && release.details.owner === lease.owner
      && JSON.stringify(release.evidence) === JSON.stringify(["fixture-process-exited"]), "CANARY_LEASE_RELEASE_AUDIT");
    const files = fs.readdirSync(path.join(context.root, "fixture-artifacts")).sort();
    if (context.mode === "success") {
      const bytes = read(path.join(context.root, "fixture-artifacts/" + task + ".txt"));
      check(bytes.toString("utf8") === "Synthetic fixture completed: " + task + "\n"
        && run.status === "succeeded" && run.effect.status === "receipt" && hash(bytes) === run.effect.sha256, "CANARY_RECEIPT");
    } else check(files.length === 0 && run.effect === null && run.status === "canceled", "CANARY_NEGATIVE_EFFECT");
    results.push({ mode: context.mode, root: context.root, run_ref: accepted.run_ref, task_id: task, status: outcome.status,
      operation_id: run.operation_id, operation_status: operation.status, lease_id: run.lease_id, fencing_token: run.fencing_token,
      artifact_names: files, receipt_sha256: run.effect?.sha256 || null, process_exited: true, process_tree_verified: false,
      authorization_revision: authorization.revision, authorization_revoked_at: authorization.revoked_at,
      consumed_operation_ids: [...authorization.consumed_operation_ids], lease_active: false,
      lease_released_at: lease.releasedAt, lease_release_audit: release,
      operation_sha256: hash(read(path.join(context.root, ".agent/operations/" + run.operation_id + ".json"))) });
    const child = children.at(-1);
    if (context.mode === "escalation") check(child.exit_signal === "SIGKILL"
      && events.some((e) => e.pid === child.child.pid && e.event === "leader_stop_observed")
      && events.some((e) => e.pid === child.child.pid && e.signal === "SIGTERM")
      && events.some((e) => e.pid === child.child.pid && e.signal === "SIGKILL"), "CANARY_ESCALATION_UNPROVED");
  }
  let status = "UNKNOWN", reason = null;
  const deadlineTimer = setTimeout(() => {
    fatal = "CANARY_DEADLINE";
    if (active?.current) {
      try { active.sink.revoke(); } catch (_) {}
      try { active.runtime.port.cancel(active.current.run_ref); } catch (_) {}
    }
  }, Math.max(1, Math.min(45000 - (performance.now() - start), expiry - Date.now())));
  try {
    const success = seed("success");
    for (const task of TASKS) await one(success, task);
    check(fs.readdirSync(path.join(success.root, "fixture-artifacts")).length === 3, "CANARY_ARTIFACT_COUNT");
    await one(seed("revoke"), TASKS[0]);
    await one(seed("escalation"), TASKS[0]);
    check(children.length === 5, "CANARY_CHILD_COUNT");
    status = "FIXTURE_EVIDENCE_RECORDED";
  } catch (e) { reason = e.code || "CANARY_FAILED"; fatal = reason; }
  finally {
    closed = true; clearTimeout(deadlineTimer);
    // Signals are only for still-matching children created by this invocation.
    // UNKNOWN never authorizes replay, deleting evidence, or stale-lock stealing.
    for (const record of children) if (!record.exited) {
      try { signal(record, "SIGCONT"); signal(record, "SIGTERM"); } catch (_) {}
    }
    const termUntil = performance.now() + 250;
    while (children.some((item) => !item.exited) && performance.now() < termUntil) await delay(10);
    for (const record of children) if (!record.exited) { try { signal(record, "SIGKILL"); } catch (_) {} }
    const killUntil = Math.min(start + 59000, performance.now() + 11500);
    while (children.some((item) => !item.exited) && performance.now() < killUntil) await delay(10);
    for (const context of roots) {
      try {
        const final = await context.runtime?.close();
        context.safe = !!final?.all_workers_exited && !final.quarantined;
        if (context.safe) context.sink.close();
        else { status = "UNKNOWN"; reason ||= "CANARY_RECOVERY_REQUIRED"; }
      } catch (_) { context.safe = false; status = "UNKNOWN"; reason ||= "CANARY_RECOVERY_REQUIRED"; }
    }
    cp.spawn = originalSpawn; process.kill = originalKill;
    if (children.some((item) => !item.exited)) { status = "UNKNOWN"; reason = "CANARY_LEADER_NOT_REAPED"; }
  }
  const report = { status, reason, tier: "I", synthetic_authority_only: true, canonical_mission_created: false,
    canonical_task_completion_asserted: false, real_ai_host: false, process_tree_verified: false,
    source_head: cfg.source_head, script_sha256: scriptDigest, worker_sha256: cfg.worker_sha256,
    job_id: cfg.job_id, invocation_id: cfg.invocation_id, node_version: process.version,
    elapsed_ms: Math.round(performance.now() - start), child_count: children.length,
    all_owned_leader_exits_observed: children.every((item) => item.exited), results, events,
    roots: roots.map((item) => {
      let evidence;
      try { evidence = evidenceInventory(item.root); }
      catch (e) { status = "UNKNOWN"; reason ||= e.code || "CANARY_EVIDENCE_UNAVAILABLE"; evidence = { unavailable: true }; }
      return { root: item.root, binding_sha256: item.bindingDigest || null, removed: false, evidence_files: evidence };
    }) };
  report.status = status; report.reason = reason;
  if (status === "FIXTURE_EVIDENCE_RECORDED" && roots.every((item) => item.safe)) {
    for (const item of report.roots) {
      try {
        check(canonicalDirectory(item.root) === item.root && path.dirname(item.root) === temp, "CANARY_CLEANUP_ROOT");
        check(hash(read(path.join(item.root, "canary-binding.json"))) === item.binding_sha256, "CANARY_CLEANUP_BINDING");
        fs.rmSync(item.root, { recursive: true, force: false }); item.removed = !fs.existsSync(item.root);
      } catch (e) { report.status = "UNKNOWN"; report.reason = e.code || "CANARY_CLEANUP_FAILED"; break; }
    }
  }
  report.job_must_fail = report.status !== "FIXTURE_EVIDENCE_RECORDED";
  report.requested_exit_code = report.job_must_fail ? 1 : 0;
  return Object.freeze(report);
}
module.exports = { runTierICanary };
