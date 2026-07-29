"use strict";

// ─── Capability-aware Manual Dispatch (MS-009 / P-004) ─────────────────────
//
// Manual dispatch is the only sanctioned way to start an Operation attempt
// against a host selected by the matcher. It is a thin orchestration layer:
//
//   1. Re-validate the dispatch plan via the deterministic matcher.
//   2. Re-check revision, snapshot TTL, governance, ownership, and lease.
//   3. Delegate the actual Operation attempt creation to the caller-provided
//      owner function (the existing owning service / runtime-state-integration).
//   4. Track plan_id → operation_attempt_id so duplicate manual triggers are
//      idempotent.
//
// This module NEVER writes to disk, NEVER acquires leases, NEVER spawns
// processes. The owner function is the only state-mutation surface.
//
// AUTOMATIC DISPATCH / DAEMON STATUS (frozen, per ARI production readiness):
//   automatic_dispatch_enabled = false
//   daemon_enabled             = false
// A caller that wants to enable automatic dispatch or a persistent
// dispatcher must present a non-default value, change the gate, and add a
// new Decision/Waitpoint; this module never flips those flags on its own.

const { matchExecutionSurface } = require("./execution-surface-matcher");
const operationLifecycle = require("../runtime-state/operation-lifecycle");

const SCHEMA_VERSION = "1.0";

// Frozen gates. Touching these at runtime is a contract violation; this
// module never sets either to true.
const AUTOMATIC_DISPATCH_ENABLED = false;
const DAEMON_ENABLED = false;

class CapabilityAwareDispatchError extends Error {
  constructor(code, details) {
    super(`[capability-aware-dispatch:${code}] ${JSON.stringify(details || {})}`);
    this.name = "CapabilityAwareDispatchError";
    this.code = code;
    this.details = details || {};
  }
}

function validateOwner(owner) {
  if (typeof owner !== "function") {
    throw new CapabilityAwareDispatchError("ERR_OWNER_REQUIRED", { type: typeof owner });
  }
}

function revalidatePlan(requirement, snapshots, options) {
  return matchExecutionSurface(requirement, snapshots, { now: options.now });
}

// findExistingAttempt: durable idempotency lookup. Scan the operations
// directory for any operation whose input_summary.plan_id matches the
// current plan_id. Returning the existing operation_attempt_id makes a
// repeated manual trigger safe across process restarts — the in-memory
// cache alone would lose idempotency on a crash.
function findExistingAttempt(root, planId) {
  if (!root || typeof root !== "string") return null;
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(root, ".agent", "operations");
  if (!fs.existsSync(dir)) return null;
  let found = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (value && value.input_summary && value.input_summary.plan_id === planId) {
        const candidate = {
          operation_attempt_id: `${value.operation_id}:${value.attempt}`,
          operation_id: value.operation_id,
          attempt: value.attempt,
          status: value.status,
        };
        if (!found || candidate.attempt > found.attempt) found = candidate;
      }
    } catch (_) {
      // Corrupt or unreadable resource is ignored during lookup; readers
      // raise through readProjection.
    }
  }
  return found;
}

function dispatch(requirement, snapshots, owner, options) {
  validateOwner(owner);
  if (!options || typeof options !== "object") {
    throw new CapabilityAwareDispatchError("ERR_OPTIONS_REQUIRED", {});
  }
  if (typeof options.now !== "string") {
    throw new CapabilityAwareDispatchError("ERR_OPTIONS_NOW_REQUIRED", {});
  }
  const state = options.idempotencyState || new Map();
  const ownerName = options.ownerName || "anonymous-owner";

  const plan = revalidatePlan(requirement, snapshots, options);
  if (!plan.selection) {
    throw new CapabilityAwareDispatchError("ERR_NO_SELECTION", {
      plan_id: plan.plan_id,
      rejected_count: plan.candidates.filter((c) => !c.hard_pass).length,
    });
  }

  // The caller owns authority to begin an Operation attempt. We call them
  // with a structured request the owner can audit. The owner returns an
  // operation_attempt_id (or throws) — we then cache it for idempotency.
  const request = {
    schema_version: SCHEMA_VERSION,
    request_id: `DISPATCH-${plan.plan_id}-${Date.now()}`,
    plan_id: plan.plan_id,
    plan_revision: plan.snapshot_revision,
    requirement_id: plan.requirement_id,
    host_profile_ref: plan.selection,
    issued_at: options.now,
    issued_by: ownerName,
    snapshot_ids: plan.candidates.filter((c) => c.host_profile_ref === plan.selection).map((c) => c.snapshot_id),
  };

  if (state.has(plan.plan_id)) {
    const cached = state.get(plan.plan_id);
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      plan_id: plan.plan_id,
      operation_attempt_id: cached,
      host_profile_ref: plan.selection,
      revalidation: Object.freeze({ revalidated: true, plan_revision: plan.snapshot_revision }),
      idempotent: true,
      idempotency_source: "in_memory",
      request_id: request.request_id,
    });
  }

  // Durable slow path: scan operations on disk for an existing attempt
  // with the same plan_id. This survives process restarts and makes a
  // duplicate manual trigger idempotent without trusting the caller.
  const durable = findExistingAttempt(options.root, plan.plan_id);
  if (durable) {
    state.set(plan.plan_id, durable.operation_attempt_id);
    return Object.freeze({
      schema_version: SCHEMA_VERSION,
      plan_id: plan.plan_id,
      operation_attempt_id: durable.operation_attempt_id,
      host_profile_ref: plan.selection,
      revalidation: Object.freeze({ revalidated: true, plan_revision: plan.snapshot_revision }),
      idempotent: true,
      idempotency_source: "durable",
      request_id: request.request_id,
    });
  }

  let result;
  try {
    result = owner(request);
  } catch (error) {
    throw new CapabilityAwareDispatchError("ERR_OWNER_REJECTED", {
      owner_error: error && error.message ? error.message : String(error),
    });
  }
  if (!result || typeof result !== "object" || typeof result.operation_attempt_id !== "string") {
    throw new CapabilityAwareDispatchError("ERR_OWNER_INVALID_RESPONSE", { received: result });
  }

  state.set(plan.plan_id, result.operation_attempt_id);

  return Object.freeze({
    schema_version: SCHEMA_VERSION,
    plan_id: plan.plan_id,
    operation_attempt_id: result.operation_attempt_id,
    host_profile_ref: plan.selection,
    revalidation: Object.freeze({ revalidated: true, plan_revision: plan.snapshot_revision }),
    idempotent: false,
    idempotency_source: "new",
    request_id: request.request_id,
  });
}

function createAuthoritativeOwner(config) {
  if (!config || typeof config !== "object") throw new CapabilityAwareDispatchError("ERR_OWNER_CONFIG_REQUIRED", {});
  const required = ["root", "operationId", "taskId", "runId", "sessionId", "workspaceId", "actor", "authorization", "readiness", "targetRevision"];
  for (const field of required) {
    if (config[field] === undefined || config[field] === null) throw new CapabilityAwareDispatchError("ERR_OWNER_CONFIG_FIELD", { field });
  }
  return function authoritativeOwner(request) {
    const candidate = operationLifecycle.createOperation({
      operation_id: config.operationId,
      attempt: config.attempt || 1,
      kind: "manual_dispatch",
      relations: { task_id: config.taskId, run_id: config.runId, session_id: config.sessionId, workspace_id: config.workspaceId, retry_of_operation_id: config.retryOfOperationId || null },
      actor: config.actor,
      owner: "operation-lifecycle",
      workflow: config.workflow || "/mission",
      action: { name: "capability-aware-dispatch", host_profile_ref: request.host_profile_ref },
      input_summary: { requirement_id: request.requirement_id, plan_id: request.plan_id, redacted: true },
      target: { repository: config.repository || "cortex-agent", host_profile_ref: request.host_profile_ref },
      target_revision: config.targetRevision,
      created_at: request.issued_at,
    });
    const recovered = operationLifecycle.recoverOperation(config.root, config.operationId);
    let current = recovered ? recovered.resource : candidate;
    if (current.target_revision !== candidate.target_revision
      || current.input_summary.plan_id !== candidate.input_summary.plan_id) {
      throw new CapabilityAwareDispatchError("ERR_EXISTING_OPERATION_MISMATCH", {
        operation_id: current.operation_id,
      });
    }
    const consumed = operationLifecycle.consumeAuthorization(
      config.root,
      config.authorization,
      current,
      request.issued_at,
    );
    if (!recovered) current = operationLifecycle.writeAttempt(config.root, current);
    if (current.target_revision !== candidate.target_revision
      || current.input_summary.plan_id !== candidate.input_summary.plan_id) {
      throw new CapabilityAwareDispatchError("ERR_EXISTING_OPERATION_MISMATCH", {
        operation_id: current.operation_id,
      });
    }
    if (current.status === "planned") {
      current = operationLifecycle.writeTransition(config.root, current, "inspected", {
        at: request.issued_at,
        actor: config.actor,
        readiness: config.readiness,
      }).operation;
    }
    if (current.status === "inspected") {
      current = operationLifecycle.writeTransition(config.root, current, "awaiting_authorization", {
        at: request.issued_at,
        actor: config.actor,
      }).operation;
    }
    if (current.status === "awaiting_authorization") {
      current = operationLifecycle.writeTransition(config.root, current, "authorized", {
        at: request.issued_at,
        actor: config.actor,
        authorization: consumed,
      }).operation;
    }
    if (current.status !== "authorized") {
      throw new CapabilityAwareDispatchError("ERR_EXISTING_OPERATION_STATE", {
        operation_id: current.operation_id,
        status: current.status,
      });
    }
    return { operation_attempt_id: `${current.operation_id}:${current.attempt}`, operation_id: current.operation_id };
  };
}

function isIdempotent(replay) {
  if (!replay || typeof replay !== "object") return false;
  return replay.idempotent === true;
}

module.exports = {
  AUTOMATIC_DISPATCH_ENABLED,
  DAEMON_ENABLED,
  CapabilityAwareDispatchError,
  SCHEMA_VERSION,
  createAuthoritativeOwner,
  dispatch,
  isIdempotent,
  revalidatePlan,
  validateOwner,
  findExistingAttempt,
};
