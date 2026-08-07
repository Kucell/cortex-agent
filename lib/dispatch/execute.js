"use strict";

// ─── Explicit Manual Dispatch (FAE-004 / M-013 MS-005) ────────────────────
//
// Composes the existing audited owners:
//
//   - FAE-003 `lib/dispatch-plan.js` (read-only plan resolver)
//   - FAE-007 `lib/coordination/lease-cli.js` (public ownership lease)
//   - M-008 / T-ACN-005 `lib/coordination/application-service.js` (Coordination Task + events)
//   - M-010 / P-006 `lib/runtime-state/operation-lifecycle.js` (Operation/Authorization/Readiness)
//   - M-009 / P-004 `lib/runtime-adapters/capability-aware-dispatch.js` (manual dispatch owner)
//   - `lib/runtime-adapters/boundary-event.js` (tool.before / tool.update boundary events)
//
// Never duplicates any state machine. Manual dispatch is **manually triggered**:
// automatic_dispatch_enabled and daemon_enabled remain frozen false.
//
// Boundaries:
//   - In scope: approve-task validation, lease acquire, capability-aware
//     dispatch dispatch(), Operation attempt creation, idempotency persistence,
//     notification delivery handshake, rollback on partial failure.
//   - Out of scope: spawning subprocesses, opening network sockets, writing
//     to .agent/ (writes limited to .agent-runtime/dispatch/idempotency/ +
//     .agent-runtime/coordination/leases/), reading credentials, mmx / git /
//     network calls.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const dispatchPlan = require("./plan");
const { leaseAcquire, leaseRelease, LeaseCliError } = require("../coordination/lease-cli.js");
const { CoordinationApplicationService } = require("../coordination/application-service.js");
const { createNotificationHarness } = require("../coordination/notification-host.js");
const { dispatch: capabilityAwareDispatch } = require("../runtime-adapters/capability-aware-dispatch.js");
const boundaryEvent = require("../runtime-adapters/boundary-event.js");
const { validateBoundaryEvent } = boundaryEvent;

const SCHEMA_VERSION = "1.0";
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const SUPPORTED_HOSTS = Object.freeze(["claude-code", "pi", "codex", "cursor"]);
const SUPPORTED_GATES = Object.freeze(["mission", "agent", "user", "owner"]);

class DispatchExecuteError extends Error {
  constructor(code, details) {
    super(`[dispatch-execute:${code}] ${JSON.stringify(details || {})}`);
    this.name = "DispatchExecuteError";
    this.code = code;
    this.details = details || {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function idempotencyDir(projectRoot) {
  return path.join(path.resolve(projectRoot), ".agent-runtime", "dispatch", "idempotency");
}

function idempotencyPath(projectRoot, key) {
  // Reject path traversal in the key.
  if (!key || typeof key !== "string" || /[^a-zA-Z0-9._-]/.test(key)) {
    throw new DispatchExecuteError("ERR_IDEMPOTENCY_KEY_INVALID", { key });
  }
  return path.join(idempotencyDir(projectRoot), `${key}.json`);
}

function readIdempotencyRecord(projectRoot, key) {
  try {
    const raw = fs.readFileSync(idempotencyPath(projectRoot, key), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema_version !== 1 || parsed.idempotency_key !== key) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeIdempotencyRecord(projectRoot, record) {
  fs.mkdirSync(idempotencyDir(projectRoot), { recursive: true });
  const target = idempotencyPath(projectRoot, record.idempotency_key);
  const suffix = crypto.randomBytes(8).toString("hex");
  const temp = `${target}.tmp.${process.pid}.${suffix}`;
  const data = `${JSON.stringify(record, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(idempotencyDir(projectRoot), "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* renamed */ }
  }
  return target;
}

// Validate that the task_id is approved by an existing Decision/Waitpoint pair.
// FAE-004's gate: read decisions/waitpoints JSON; reject if no approved binding.
function assertApprovedTask(root, taskId, options = {}) {
  const decisionsDir = path.join(root, ".agent", "decisions");
  const waitpointsDir = path.join(root, ".agent", "waitpoints");
  let approved = null;
  try {
    for (const name of fs.readdirSync(decisionsDir)) {
      if (!name.endsWith(".json")) continue;
      const d = JSON.parse(fs.readFileSync(path.join(decisionsDir, name), "utf8"));
      if (d && d.status === "approved"
        && d.relations && Array.isArray(d.relations.task_ids)
        && d.relations.task_ids.includes(taskId)) {
        approved = { decision: d, waitpoint: null };
        break;
      }
    }
  } catch (_) { /* missing dir → not approved */ }
  if (!approved) {
    throw new DispatchExecuteError("ERR_TASK_NOT_APPROVED", { task_id: taskId });
  }
  // Optional waitpoint match.
  try {
    for (const name of fs.readdirSync(waitpointsDir)) {
      if (!name.endsWith(".json")) continue;
      const w = JSON.parse(fs.readFileSync(path.join(waitpointsDir, name), "utf8"));
      if (w && w.status === "released" && w.decision_id === approved.decision.decision_id) {
        approved.waitpoint = w;
        break;
      }
    }
  } catch (_) { /* missing dir */ }
  return approved;
}

// Compose the dispatch execute flow.
function executeDispatch(args, options = {}) {
  if (!args.taskId || typeof args.taskId !== "string") {
    throw new DispatchExecuteError("ERR_TASK_ID_REQUIRED", {});
  }
  if (!args.idempotencyKey || typeof args.idempotencyKey !== "string") {
    throw new DispatchExecuteError("ERR_IDEMPOTENCY_KEY_REQUIRED", {});
  }
  if (!args.gate || !SUPPORTED_GATES.includes(args.gate)) {
    throw new DispatchExecuteError("ERR_GATE_INVALID", { gate: args.gate, supported: [...SUPPORTED_GATES] });
  }
  if (!args.host || !SUPPORTED_HOSTS.includes(args.host)) {
    throw new DispatchExecuteError("ERR_HOST_INVALID", { host: args.host, supported: [...SUPPORTED_HOSTS] });
  }
  const root = path.resolve(args.projectRoot || process.cwd());

  // 1. Idempotency check.
  const existing = readIdempotencyRecord(root, args.idempotencyKey);
  if (existing && existing.status !== "failed" && existing.status !== "canceled") {
    return {
      ok: true,
      action: "dispatch_execute",
      idempotent: true,
      record: existing,
    };
  }

  // 2. Approval gate.
  const approval = assertApprovedTask(root, args.taskId, options);

  // 3. Resolve plan (read-only, zero mutation).
  const plan = dispatchPlan.resolveDispatchPlan(root, args.taskId);
  if (!plan.would_proceed) {
    throw new DispatchExecuteError("ERR_PLAN_BLOCKED", {
      errors: plan.errors,
      warnings: plan.warnings,
    });
  }

  // 4. Acquire ownership lease.
  const leaseScope = `task:${args.taskId}`;
  let lease;
  try {
    const result = leaseAcquire({
      scope: leaseScope,
      owner: args.host,
      idempotencyKey: args.idempotencyKey,
      ttl: 30 * 60,
      evidence: ["mission:M-013", `decision:${approval.decision.decision_id}`],
    }, { projectRoot: root });
    if (!result.ok) {
      throw new DispatchExecuteError("ERR_LEASE_FAILED", { code: result.code, error: result.error });
    }
    lease = result.lease;
  } catch (error) {
    if (error instanceof LeaseCliError) {
      throw new DispatchExecuteError("ERR_LEASE_FAILED", { code: error.code, details: error.details });
    }
    throw error;
  }

  // 5. Build the requirement + snapshot, then call capability-aware dispatch.
  const now = nowIso();
  const requirement = {
    schema_version: SCHEMA_VERSION,
    requirement_id: `REQ-${args.taskId}-${args.idempotencyKey}`,
    task_id: args.taskId,
    created_at: now,
    required_capabilities: ["session.boundary", "tool.before.block", "tool.update"],
    minimum_capability_levels: { "tool.before.block": "native" },
    governance: {
      approved_decision_id: approval.decision.decision_id,
      require_active_lease: true,
    },
    preferred: {},
    ttl_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h to keep snapshot fresh
  };
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    snapshot_id: `SNAP-${args.taskId}-${Date.now()}`,
    host_profile_ref: `H-${args.host}`,
    taken_at: now,
    capabilities: {
      "session.boundary": "native",
      "tool.before.block": "native",
      "tool.update": "adapter",
    },
    governance: { approved: true, decision_id: approval.decision.decision_id },
    lease: { active: true, holder: args.host, fencingToken: lease.fencingToken },
    reliability: { value: 0.9, source: "explicit-workflow", quality: "high" },
    cost: { value: 0.4, source: "explicit-workflow", quality: "medium" },
    latency: { value: 220, source: "explicit-workflow", quality: "high" },
  };

  // Emit tool.before boundary event.
  const beforeEvent = {
    schema_version: "1.0",
    event_id: `RBE-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    type: "tool.before",
    at: now,
    host: { adapter_id: args.host, session_ref: lease.actorId },
    correlation: { task_id: args.taskId },
    resource: { kind: "tool", name: "dispatch.execute" },
    capability: "tool.before.block",
    decision: { result: "allowed", authorization_ref: approval.decision.decision_id },
    evidence_refs: ["mission:M-013"],
  };
  validateBoundaryEvent(beforeEvent); // throws if invalid

  // Run capability-aware dispatch (the audited manual dispatch owner).
  let result;
  try {
    result = capabilityAwareDispatch(requirement, [snapshot], () => ({
      operation_attempt_id: `OP-${args.taskId}-${Date.now()}`,
      plan_id: `PLAN-${args.taskId}-${args.idempotencyKey}`,
    }), {
      now: now,
      ownerName: args.host,
    });
  } catch (error) {
    // Rollback: release the lease.
    try { leaseRelease({ leaseId: lease.leaseId, evidence: [`rollback:${args.taskId}`] }, { projectRoot: root }); } catch (_) { /* best-effort */ }
    writeIdempotencyRecord(root, {
      schema_version: 1,
      idempotency_key: args.idempotencyKey,
      task_id: args.taskId,
      status: "failed",
      run_id: null,
      request_digest: crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex"),
      created_at: nowIso(),
      updated_at: nowIso(),
      expires_at: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS).toISOString(),
      failure: { code: error.code || error.name || "ERR_DISPATCH_FAILED", message: error.message },
    });
    throw new DispatchExecuteError("ERR_DISPATCH_FAILED", { original: error.message, code: error.code });
  }

  // 6. Submit Coordination Task to the application service.
  let service;
  let taskEvent;
  try {
    const coordinationRoot = path.join(root, ".agent-runtime", "coordination");
    service = CoordinationApplicationService.open(coordinationRoot, { clock: () => Date.now() });
    taskEvent = service.submit({
      schemaVersion: "1.0",
      eventId: `CE-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      projectId: path.basename(root),
      taskId: args.taskId,
      correlationId: args.idempotencyKey,
      producer: { actorId: args.host, kind: "coordinator", sessionId: lease.actorId },
      targets: [],
      eventType: "task.created",
      previousState: null,
      currentState: "CREATED",
      timestamp: now,
      sequence: null,
      repository: { repositoryId: path.basename(root) },
      notification: { policy: "journal_only", dedupeKey: `dispatch-${args.idempotencyKey}` },
      evidence: [{ ref: approval.decision.decision_id, kind: "validation" }],
    }, { actorId: args.host, kind: "coordinator", sessionId: lease.actorId, workflowGate: args.gate });
  } catch (error) {
    // Rollback: release lease.
    try { leaseRelease({ leaseId: lease.leaseId, evidence: [`rollback:${args.taskId}`] }, { projectRoot: root }); } catch (_) { /* best-effort */ }
    writeIdempotencyRecord(root, {
      schema_version: 1,
      idempotency_key: args.idempotencyKey,
      task_id: args.taskId,
      status: "failed",
      run_id: null,
      request_digest: crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex"),
      created_at: nowIso(),
      updated_at: nowIso(),
      expires_at: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS).toISOString(),
      failure: { code: "ERR_TASK_SUBMIT_FAILED", message: error.message },
    });
    throw new DispatchExecuteError("ERR_TASK_SUBMIT_FAILED", { message: error.message });
  }

  // 7. Persist idempotency record (status=accepted).
  const record = {
    schema_version: 1,
    idempotency_key: args.idempotencyKey,
    task_id: args.taskId,
    status: "accepted",
    run_id: result.plan_id,
    request_digest: crypto.createHash("sha256").update(JSON.stringify(args)).digest("hex"),
    created_at: nowIso(),
    updated_at: nowIso(),
    expires_at: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS).toISOString(),
    execution: {
      operation_attempt_id: result.operation_attempt_id,
      host_profile_ref: result.host_profile_ref,
      decision_id: approval.decision.decision_id,
      lease_id: lease.leaseId,
      fencing_token: lease.fencingToken,
      boundary_events: [beforeEvent.event_id],
    },
    coordination_task: taskEvent && taskEvent.event ? taskEvent.event.eventId : null,
  };
  writeIdempotencyRecord(root, record);

  // 8. Best-effort notification handshake (no spawn / no network from this surface).
  let notification = null;
  try {
    const harness = createNotificationHarness(root);
    notification = { delivered: false, reason: "no_consumer_attached", harness_available: !!harness };
  } catch (error) {
    notification = { delivered: false, reason: error.message || "harness_init_failed" };
  }

  return {
    ok: true,
    action: "dispatch_execute",
    idempotent: false,
    run: { plan_id: result.plan_id, operation_attempt_id: result.operation_attempt_id, host_profile_ref: result.host_profile_ref },
    lease: { lease_id: lease.leaseId, fencing_token: lease.fencingToken, scope: lease.scope },
    approval: { decision_id: approval.decision.decision_id, waitpoint_id: approval.waitpoint ? approval.waitpoint.waitpoint_id : null },
    boundary_events: [beforeEvent.event_id],
    coordination_task: taskEvent,
    notification,
    record_path: idempotencyPath(root, args.idempotencyKey),
  };
}

// Dry-run alias: dispatch_execute returns the plan-only view via resolveDispatchPlan.
function dryRunAlias(args, options = {}) {
  if (!args.taskId) throw new DispatchExecuteError("ERR_TASK_ID_REQUIRED", {});
  const root = path.resolve(args.projectRoot || process.cwd());
  return dispatchPlan.resolveDispatchPlan(root, args.taskId);
}

module.exports = {
  executeDispatch,
  dryRunAlias,
  DispatchExecuteError,
  SUPPORTED_HOSTS,
  SUPPORTED_GATES,
  SCHEMA_VERSION,
  IDEMPOTENCY_RETENTION_MS,
};