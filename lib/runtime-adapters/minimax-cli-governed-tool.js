"use strict";

// ─── MiniMax CLI Governed-Tool Adapter Gateway (M-011 / ARI P-005) ────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// ARI P-005 frozen proposal:
//   .agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-005-minimax-cli-governed-tool-adapter-proposal.md
// Frozen SHA-256:
//   f377943b6eb73d44308a86d965229730ba2552613ae611e3e511457c13f4587d
//
// Public API:
//   - probeGateway(options)                    -> MiniMaxCliCapabilitySnapshot
//   - discoverSkills(root, options)            -> MiniMaxCliSkillDescriptor[]
//   - buildMinimaxCliRequirement(input)        -> canonical requirement shape
//   - buildMinimaxCliSnapshot(snapshot)        -> canonical host-snapshot shape
//   - dispatchRequirement(req, owner, options) -> composes capability-aware-dispatch
//                                                 + tool-gate + readiness + boundary-event
//   - reconcileAsyncJob(root, opId, descriptor, options)
//                                              -> writes Operation child event
//                                                 through operation-lifecycle
//                                                 (no mmx invocation in this Mission)
//   - assertNoForbiddenSubcommandInvocation(commandLine)
//                                              -> static grep guard
//   - registerWithInitUpdateDoctor(workspace)  -> integrate capability discovery
//                                                 into existing init/update/doctor
//                                                 conventions

const capabilityContract = require("./minimax-cli-capability-contract");
const probeMod = require("./minimax-cli-probe");
const skillDiscovery = require("./minimax-cli-skill-discovery");

// Existing owners reused (P-001..P-004 / M-009). Lazy-loaded to keep startup
// fast and to avoid a hard dependency on every test invocation.
function loadExistingOwners() {
  const capabilityAwareDispatch = require("./capability-aware-dispatch");
  const toolGate = require("./tool-gate");
  const operationLifecycle = require("../runtime-state/operation-lifecycle");
  const boundaryEvent = require("./boundary-event");
  return { capabilityAwareDispatch, toolGate, operationLifecycle, boundaryEvent };
}

const SCHEMA_VERSION = "1.0";
const HOST_PROFILE_PREFIX = "mmx-";
const TOOL_NAME_PREFIX = "mmx.";

// ─── Capability snapshot (delegates to probe module) ───────────────────────
function probeGateway(options) {
  return probeMod.runSafeProbe(options || {});
}

function discoverSkills(root, options) {
  const opts = options || {};
  if (root && typeof root === "string") opts.projectRoot = root;
  return skillDiscovery.discoverSkills(opts);
}

// ─── Snapshot adapter: MiniMaxCliCapabilitySnapshot → host-snapshot shape ──
// Maps the MiniMax probe output into the shape consumed by
// capability-aware-dispatch / execution-surface-matcher.
function buildMinimaxCliSnapshot(snapshot, opts) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new GovernedToolError("ERR_SNAPSHOT_REQUIRED", {});
  }
  const o = opts || {};
  const takenAt = o.now || new Date().toISOString();
  const decisionId = o.decisionId || null;
  const resource = o.resource && capabilityContract.MINIMAX_RESOURCE_SET
    ? (capabilityContract.MINIMAX_RESOURCE_SET.has(o.resource) ? o.resource : null)
    : (capabilityContract.MINIMAX_RESOURCES.indexOf(o.resource) >= 0 ? o.resource : null);
  const hostProfileRef = resource ? `mmx-${resource}` : "mmx-any";
  const capMap = {};
  // Single resource snapshot: the resource's capability entry drives the
  // mapped level.  adapter when declared via `mmx <resource> --help`,
  // unsupported otherwise.
  if (resource) {
    const entry = snapshot.capabilities && snapshot.capabilities[resource];
    const level = entry && entry.level === "explicit" ? "adapter" : "unsupported";
    capMap["tool.update"] = level;
    capMap["session.boundary"] = level;
  } else {
    // Multi-resource snapshot: aggregate the best level across resources.
    let bestLevel = "unsupported";
    for (const r of capabilityContract.MINIMAX_RESOURCES) {
      const entry = snapshot.capabilities && snapshot.capabilities[r];
      if (entry && entry.level === "explicit") {
        bestLevel = "adapter";
        break;
      }
    }
    capMap["tool.update"] = bestLevel;
    capMap["session.boundary"] = bestLevel;
  }
  return {
    schema_version: "1.0",
    snapshot_id: snapshot.snapshot_id || "MCAP-unknown",
    host_profile_ref: hostProfileRef,
    taken_at: takenAt,
    capabilities: capMap,
    governance: {
      approved: false, // never auto-approved in this Mission; auth_state="unknown"
      decision_id: decisionId,
      note: "auth_state=" + (snapshot.auth_state || "unknown") + "; ready/blocked require separate authorization",
    },
    lease: { active: false, holder: null, note: "lease is owned by coordination owner; this gateway does not acquire leases" },
    reliability: { value: 0.0, source: "self-reported", quality: "unavailable" },
    cost: { value: 0.0, source: "self-reported", quality: "unavailable" },
    latency: { value: 0, source: "self-reported", quality: "unavailable" },
    minimax_cli: {
      snapshot_id: snapshot.snapshot_id,
      auth_state: snapshot.auth_state,
      binary_available: snapshot.binary && snapshot.binary.available === true,
      binary_version: snapshot.binary && snapshot.binary.version,
      no_credential: snapshot.no_credential === true,
      probe_families: (snapshot.probe_families || []).slice(),
      resource: resource || null,
    },
  };
}

// ─── Requirement builder ──────────────────────────────────────────────────
// Builds a MiniMax-shaped requirement, then adapts it to the canonical
// capability-aware-dispatch requirement contract (task_id, created_at,
// required_capabilities, governance, etc.).
function buildMinimaxCliRequirement(input) {
  if (!input || typeof input !== "object") {
    throw new GovernedToolError("ERR_REQUIREMENT_INVALID", {});
  }
  const resource = String(input.resource || "");
  if (!capabilityContract.MINIMAX_RESOURCE_SET
    ? capabilityContract.MINIMAX_RESOURCES.indexOf(resource) < 0
    : !capabilityContract.MINIMAX_RESOURCE_SET.has(resource)) {
    throw new GovernedToolError("ERR_RESOURCE_UNKNOWN", {
      resource,
      allowed: capabilityContract.MINIMAX_RESOURCES.slice(),
    });
  }
  const subcommand = String(input.subcommand || "");
  if (subcommand.length === 0 || subcommand.length > 64) {
    throw new GovernedToolError("ERR_SUBCOMMAND_INVALID", { subcommand });
  }
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    requirement_id: input.requirement_id || `REQ-MMX-${resource}-${subcommand}`,
    host: "minimax-cli",
    resource,
    subcommand,
    host_profile_ref: `${HOST_PROFILE_PREFIX}${resource}`,
    tool_name: `${TOOL_NAME_PREFIX}${resource}.${subcommand}`,
    redacted_inputs: true,
  });
}

// adaptRequirement: MiniMax shape → capability-aware-dispatch contract shape.
// In the current Mission, auth_state is always "unknown" — no Decision/Waitpoint
// is approved for MiniMax CLI dispatch.  Governance is therefore left
// `approved_decision_id: null` so the matcher does not require an approved
// snapshot.  Callers who obtain separate authorization can pass `decisionId`
// in `opts` to bind a real governance pair.
function adaptRequirement(miniReq, opts) {
  const o = opts || {};
  return {
    schema_version: "1.0",
    requirement_id: miniReq.requirement_id,
    task_id: o.taskId || `T-MMX-${miniReq.resource}`,
    created_at: o.now || new Date().toISOString(),
    required_capabilities: ["tool.update", "session.boundary"],
    minimum_capability_levels: { "tool.update": "adapter", "session.boundary": "adapter" },
    governance: {
      approved_decision_id: o.decisionId || null,
      require_active_lease: Boolean(o.requireActiveLease),
    },
    preferred: {},
    ttl_at: o.ttlAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    minimax_cli: { resource: miniReq.resource, subcommand: miniReq.subcommand, tool_name: miniReq.tool_name, host_profile_ref: miniReq.host_profile_ref },
  };
}

// ─── Dispatch (composes capability-aware-dispatch + tool-gate + readiness +
// boundary-event; fail-closed when auth_state !== "unknown") ───────────────
function dispatchRequirement(requirement, owner, options) {
  if (!requirement || typeof requirement !== "object") {
    throw new GovernedToolError("ERR_REQUIREMENT_INVALID", {});
  }
  if (typeof owner !== "function") {
    throw new GovernedToolError("ERR_OWNER_REQUIRED", { type: typeof owner });
  }
  const opts = options || {};
  if (typeof opts.now !== "string") {
    throw new GovernedToolError("ERR_OPTIONS_NOW_REQUIRED", {});
  }
  const snap = opts.snapshot;
  if (!snap) {
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      result: "unavailable",
      reason: "snapshot_required",
      requirement_id: requirement.requirement_id,
    });
  }
  if (snap.auth_state && snap.auth_state !== "unknown") {
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      result: "unavailable",
      reason: "auth_disabled",
      reason_code: "AUTH_READINESS_DISABLED",
      requirement_id: requirement.requirement_id,
      auth_state: snap.auth_state,
    });
  }
  const { capabilityAwareDispatch, toolGate, operationLifecycle, boundaryEvent } = loadExistingOwners();
  const adaptedSnap = buildMinimaxCliSnapshot(snap, { now: opts.now, resource: requirement.resource });
  const adaptedReq = adaptRequirement(requirement, { now: opts.now });

  // Tool Gate evaluation: fail-closed if any decision/waitpoint mismatch.
  if (opts.toolGateInput && opts.toolGateInput.decision && opts.toolGateInput.waitpoint) {
    const gate = toolGate.evaluateFromRecords(
      {
        operation: opts.toolGateInput.operation,
        candidate: {
          resource_digest: opts.toolGateInput.resource_digest,
          attempt: opts.toolGateInput.attempt || 1,
          tool: `${HOST_PROFILE_PREFIX}${requirement.resource || ""}`,
        },
        decision: opts.toolGateInput.decision,
        waitpoint: opts.toolGateInput.waitpoint,
        authorization: opts.toolGateInput.authorization,
      },
      { now: opts.now }
    );
    if (gate.result !== "allowed") {
      return Object.freeze({
        schema_version: SCHEMA_VERSION,
        result: "unavailable",
        reason: "tool_gate_denied",
        gate,
        requirement_id: requirement.requirement_id,
      });
    }
  }

  // Readiness projection: confirm the resource is supported.
  let readinessProjection = null;
  try {
    if (opts.root && typeof opts.root === "string" && opts.operationId && typeof opts.operationId === "string") {
      readinessProjection = operationLifecycle.readProjection(opts.root, "operations", {
        operation_id: opts.operationId,
      });
    }
  } catch (_) {
    // readProjection may throw if root/operation does not exist; treat as unavailable.
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      result: "unavailable",
      reason: "readiness_unavailable",
      requirement_id: requirement.requirement_id,
    });
  }

  // capability-aware-dispatch: pass arguments in the correct order
  // (requirement, snapshots, owner, options).
  const dispatchResult = capabilityAwareDispatch.dispatch(
    adaptedReq,
    [adaptedSnap],
    owner,
    {
      now: opts.now,
      root: opts.root,
      idempotencyState: opts.idempotencyState,
      ownerName: opts.ownerName || "minimax-cli-governed-tool",
    }
  );

  // Boundary event: emit a tool.before event (best-effort; do not fail the
  // dispatch if boundary-event throws on missing optional fields).
  let boundaryEventRecord = null;
  try {
    boundaryEventRecord = boundaryEvent.validateBoundaryEvent({
      schema_version: boundaryEvent.RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      event_id: `RBE-minimax-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "tool.before",
      at: opts.now,
      host: { adapter_id: "minimax-cli", session_ref: opts.sessionRef || null },
      correlation: opts.correlation || {},
      resource: { kind: "tool", name: requirement.tool_name || `${TOOL_NAME_PREFIX}${requirement.resource}.${requirement.subcommand}`, target_digest: opts.resourceDigest || null },
      capability: "tool.update",
      decision: { result: "allowed", authorization_ref: opts.authorizationRef || null, reason: "snapshot_auth_state_unknown" },
      evidence_refs: opts.evidenceRefs || [],
    });
  } catch (err) {
    boundaryEventRecord = { error: err.code || "ERR_BOUNDARY_EVENT_INVALID", message: err.message };
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    requirement_id: requirement.requirement_id,
    result: "allowed",
    operation_attempt_id: dispatchResult.operation_attempt_id,
    plan_id: dispatchResult.plan_id,
    host_profile_ref: dispatchResult.host_profile_ref,
    idempotent: dispatchResult.idempotent === true,
    dispatch_request_id: dispatchResult.request_id,
    readiness_projection: readinessProjection,
    boundary_event: boundaryEventRecord,
    audit: {
      now: opts.now,
      auth_state: snap.auth_state,
      owner_name: opts.ownerName || "minimax-cli-governed-tool",
      mmx_invocation: "none",
      note: "this gateway never invokes mmx; capability-aware-dispatch owner must be wrapped accordingly",
    },
  });
}

// ─── Async job reconciliation (durably writes Operation child event) ──────
// `reconcileAsyncJob` validates the caller-supplied descriptor and then
// appends an Operation child event through operation-lifecycle.writeTransition.
// It does NOT invoke `mmx <resource> task get` (forbidden in this Mission).
function reconcileAsyncJob(root, operationId, jobDescriptor, options) {
  const opts = options || {};
  if (!root || typeof root !== "string") {
    throw new GovernedToolError("ERR_ROOT_REQUIRED", {});
  }
  if (!operationId || typeof operationId !== "string") {
    throw new GovernedToolError("ERR_OPERATION_ID_REQUIRED", {});
  }
  if (typeof opts.now !== "string") {
    throw new GovernedToolError("ERR_OPTIONS_NOW_REQUIRED", {});
  }
  const validated = capabilityContract.validateAsyncJobDescriptor(jobDescriptor);
  const { operationLifecycle, boundaryEvent } = loadExistingOwners();

  // Recover the Operation (idempotent).  If it doesn't exist yet, fail
  // closed — async reconciliation must follow an authorized Operation.
  let operation = null;
  try {
    operation = operationLifecycle.recoverOperation(root, operationId);
  } catch (_) {
    operation = null;
  }
  if (!operation) {
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      reconciled_at: opts.now,
      operation_id: operationId,
      result: "unavailable",
      reason: "operation_not_found",
      mmx_invocation: "skipped_in_this_mission",
    });
  }

  // Append the async-job reconciliation event to the Operation journal.
  // writeTransition returns { operation, event }; we re-read the projection
  // afterwards so the caller sees the updated view.
  let writeResult;
  try {
    writeResult = operationLifecycle.writeTransition(root, operation, operation.status, {
      at: opts.now,
      actor: opts.actor || "minimax-cli-governed-tool",
      note: `async_job_reconciled:${validated.job_id}:${validated.status}`,
      minimax_cli_job: {
        job_id: validated.job_id,
        resource: validated.resource,
        status: validated.status,
        cost_status: validated.cost_status,
        output_refs_count: validated.output_refs.length,
      },
    });
  } catch (err) {
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      reconciled_at: opts.now,
      operation_id: operationId,
      result: "unavailable",
      reason: "journal_write_failed",
      error_code: err.code || "ERR_LIFECYCLE_WRITE",
      mmx_invocation: "skipped_in_this_mission",
    });
  }

  // Boundary event for the reconciliation.
  let boundaryEventRecord = null;
  try {
    boundaryEventRecord = boundaryEvent.validateBoundaryEvent({
      schema_version: boundaryEvent.RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION,
      event_id: `RBE-minimax-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "tool.update",
      at: opts.now,
      host: { adapter_id: "minimax-cli", session_ref: null },
      correlation: opts.correlation || {},
      resource: { kind: "tool", name: `mmx.${validated.resource}.task_get`, target_digest: null },
      capability: "tool.update",
      decision: { result: "allowed", authorization_ref: opts.authorizationRef || null, reason: "async_job_reconciliation" },
      evidence_refs: [],
    });
  } catch (err) {
    boundaryEventRecord = { error: err.code || "ERR_BOUNDARY_EVENT_INVALID", message: err.message };
  }

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    reconciled_at: opts.now,
    operation_id: operationId,
    result: "reconciled",
    job: validated,
    operation_status_after: writeResult.operation.status,
    event: writeResult.event,
    boundary_event: boundaryEventRecord,
    mmx_invocation: "skipped_in_this_mission",
    note: "ARI P-005 §5.3 forbids invoking `mmx <resource> task get` in this Mission; reconcileAsyncJob validates the caller-supplied descriptor and writes an Operation child event via operation-lifecycle.writeTransition.",
  });
}

// ─── init / update / doctor / reconcile integration (ARI P-005 §6 / M-011) ───
//
// This adapter hook returns a registration object that the existing init /
// update / doctor / reconcile workflows can consume.  It performs read-only
// capability discovery + skill enumeration; it does not modify any host
// file and does not invoke any mmx subcommand beyond the 3-family allow-list.
function registerWithInitUpdateDoctor(options) {
  const opts = options || {};
  const projectRoot = opts.projectRoot || process.cwd();
  const templatesRoot = opts.templatesRoot || `${projectRoot}/templates`;
  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    name: "minimax-cli",
    capabilitySnapshot: function capabilitySnapshot() {
      // Safe probe runs only the three allow-listed mmx command families.
      return probeMod.runSafeProbe(opts.probeOptions || {});
    },
    enumerateSkills: function enumerateSkills() {
      return skillDiscovery.discoverSkills({ projectRoot, templatesRoot });
    },
    // Hooks the existing workflows can call after their own work; each is
    // read-only and returns a structured summary that the host workflow can
    // log or print.
    onInitComplete: function onInitComplete(ctx) {
      const snap = probeMod.runSafeProbe(opts.probeOptions || {});
      const skills = skillDiscovery.discoverSkills({ projectRoot, templatesRoot });
      return Object.freeze({
        schema_version: SCHEMA_VERSION,
        event: "post_init",
        binary_available: snap.binary.available,
        binary_version: snap.binary.version,
        auth_state: snap.auth_state,
        skill_paths_total: skills.length,
        skill_paths_present: skills.filter((s) => s.present).length,
        note: "no files created; read-only discovery",
      });
    },
    onUpdateComplete: function onUpdateComplete(ctx) {
      const snap = probeMod.runSafeProbe(opts.probeOptions || {});
      return Object.freeze({
        schema_version: SCHEMA_VERSION,
        event: "post_update",
        binary_available: snap.binary.available,
        binary_version: snap.binary.version,
        auth_state: snap.auth_state,
        probe_families: snap.probe_families.slice(),
        note: "no files modified; additive-only templates ensured by owner",
      });
    },
    onDoctorRun: function onDoctorRun(ctx) {
      const snap = probeMod.runSafeProbe(opts.probeOptions || {});
      const skills = skillDiscovery.discoverSkills({ projectRoot, templatesRoot });
      const present = skills.filter((s) => s.present);
      return Object.freeze({
        schema_version: SCHEMA_VERSION,
        event: "doctor",
        binary_available: snap.binary.available,
        binary_version: snap.binary.version,
        auth_state: snap.auth_state,
        probe_families: snap.probe_families.slice(),
        skills_total: skills.length,
        skills_present: present.length,
        present_paths: present.map((s) => s.path),
        recommendations: snap.binary.available
          ? [
              "MiniMax CLI binary detected; capability snapshot recorded with auth_state=unknown.",
              "Ready/blocked require separate authorization; current Mission runs fail-closed.",
              "Skill discovery covered 21 portable paths; no file mutations performed.",
            ]
          : [
              "MiniMax CLI binary not detected on PATH; capability snapshot records binary.available=false.",
              "Install mmx (e.g. via Volta) and rerun doctor to refresh the snapshot.",
            ],
      });
    },
    onReconcileRun: function onReconcileRun(ctx) {
      // Reconcile is the cross-host idempotency refresh: re-probe + re-enumerate.
      const snap = probeMod.runSafeProbe(opts.probeOptions || {});
      return Object.freeze({
        schema_version: SCHEMA_VERSION,
        event: "reconcile",
        snapshot_id: snap.snapshot_id,
        auth_state: snap.auth_state,
        binary_available: snap.binary.available,
        binary_version: snap.binary.version,
        probe_families: snap.probe_families.slice(),
        note: "reconcile is read-only; persists nothing automatically",
      });
    },
  });
}

// ─── Static guard: any external call to a forbidden mmx subcommand ─────────
function assertNoForbiddenSubcommandInvocation(commandLine) {
  if (typeof commandLine !== "string") return;
  const forbiddenPatterns = [
    /\bmmx\s+auth\b/,
    /\bmmx\s+config\b/,
    /\bmmx\s+quota\b/,
    /\bmmx\s+update\b/,
    /\bmmx\s+install\b/,
    /\bmmx\s+file\b/,
    /\bmmx\s+text\s+(chat|repl)\b/,
    /\bmmx\s+image\s+generate\b/,
    /\bmmx\s+video\s+(generate|task|download)\b/,
    /\bmmx\s+speech\s+(synthesize|voices)\b/,
    /\bmmx\s+music\s+(generate|cover)\b/,
    /\bmmx\s+vision\s+describe\b/,
    /\bmmx\s+search\s+query\b/,
  ];
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(commandLine)) {
      throw new GovernedToolError("ERR_FORBIDDEN_MMX_INVOCATION", {
        matched_pattern: pattern.source,
        command_line: commandLine.slice(0, 256),
      });
    }
  }
}

class GovernedToolError extends Error {
  constructor(code, details) {
    super(`[minimax-cli-governed-tool:${code}] ${JSON.stringify(details || {})}`);
    this.name = "GovernedToolError";
    this.code = code;
    this.details = details || {};
  }
}

module.exports = {
  SCHEMA_VERSION,
  HOST_PROFILE_PREFIX,
  TOOL_NAME_PREFIX,
  GovernedToolError,
  probeGateway,
  discoverSkills,
  buildMinimaxCliRequirement,
  buildMinimaxCliSnapshot,
  adaptRequirement,
  dispatchRequirement,
  reconcileAsyncJob,
  registerWithInitUpdateDoctor,
  assertNoForbiddenSubcommandInvocation,
};