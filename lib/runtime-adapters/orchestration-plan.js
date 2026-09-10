"use strict";

// Pure L1 contract for the future agent-orchestration preflight. This module
// owns no runtime state and deliberately cannot create Tasks, Leases,
// Operations, Runs, Decisions, Waitpoints, worktrees, or host processes.

const SCHEMA_VERSION = "1.0";
const ENTRIES = new Set(["start-task", "plan", "mission", "parallel", "arch-design"]);
const RESULTS = new Set(["would_proceed", "blocked"]);

class OrchestrationPlanError extends Error {
  constructor(code, details = {}) {
    super(`[orchestration-plan:${code}] ${JSON.stringify(details)}`);
    this.name = "OrchestrationPlanError";
    this.code = code;
    this.details = details;
  }
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OrchestrationPlanError("ERR_TEXT_REQUIRED", { field });
  }
  return value.trim();
}

function strings(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new OrchestrationPlanError("ERR_STRING_ARRAY_REQUIRED", { field });
  }
  return Object.freeze(value.map((item) => item.trim()));
}

function blockers(value) {
  if (!Array.isArray(value)) throw new OrchestrationPlanError("ERR_BLOCKERS_ARRAY_REQUIRED");
  return Object.freeze(value.map((blocker, index) => {
    if (!blocker || typeof blocker !== "object" || Array.isArray(blocker)) {
      throw new OrchestrationPlanError("ERR_BLOCKER_INVALID", { index });
    }
    return Object.freeze({
      code: text(blocker.code, `blockers[${index}].code`),
      owner: text(blocker.owner, `blockers[${index}].owner`),
      nextAction: text(blocker.nextAction, `blockers[${index}].nextAction`),
    });
  }));
}

function createOrchestrationPlan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new OrchestrationPlanError("ERR_INPUT_REQUIRED");
  }
  const entry = text(input.entry, "entry");
  if (!ENTRIES.has(entry)) throw new OrchestrationPlanError("ERR_ENTRY_INVALID", { entry });
  const result = text(input.result, "result");
  if (!RESULTS.has(result)) throw new OrchestrationPlanError("ERR_RESULT_INVALID", { result });
  const hostRequirement = input.hostRequirement;
  const gates = input.gates;
  if (!hostRequirement || typeof hostRequirement !== "object" || Array.isArray(hostRequirement)) {
    throw new OrchestrationPlanError("ERR_HOST_REQUIREMENT_REQUIRED");
  }
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) {
    throw new OrchestrationPlanError("ERR_GATES_REQUIRED");
  }

  const plan = {
    schemaVersion: SCHEMA_VERSION,
    taskId: text(input.taskId, "taskId"),
    entry,
    ownedFiles: strings(input.ownedFiles, "ownedFiles"),
    resources: strings(input.resources || [], "resources"),
    dependencies: strings(input.dependencies || [], "dependencies"),
    hostRequirement: Object.freeze({
      capabilities: strings(hostRequirement.capabilities || [], "hostRequirement.capabilities"),
      degradedAllowed: hostRequirement.degradedAllowed === true,
    }),
    gates: Object.freeze({
      decision: text(gates.decision, "gates.decision"),
      waitpoint: text(gates.waitpoint, "gates.waitpoint"),
    }),
    result,
    blockers: blockers(input.blockers || []),
  };
  if (result === "would_proceed" && plan.blockers.length > 0) {
    throw new OrchestrationPlanError("ERR_PROCEEDING_PLAN_HAS_BLOCKERS");
  }
  if (result === "blocked" && plan.blockers.length === 0) {
    throw new OrchestrationPlanError("ERR_BLOCKED_PLAN_NEEDS_BLOCKER");
  }
  return Object.freeze(plan);
}

module.exports = {
  ENTRIES,
  RESULTS,
  SCHEMA_VERSION,
  OrchestrationPlanError,
  createOrchestrationPlan,
};
