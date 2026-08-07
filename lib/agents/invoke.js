"use strict";

// ─── Agent Invoke (M-002 MS-003) ──────────────────────────────────────────────
//
// `agent invoke <agent_id> <task>` — produce a deterministic invocation plan
// from the static Agent Registry. **In MS-003 we do NOT actually execute the
// call against an external adapter** (real execution lands in M-003 mission:
// 5 adapters + 1 MCP bridge, 6-7 weeks).
//
// What MS-003 does:
//   1. Resolve target agent from `.agent/agents/<id>.json`
//   2. Verify target status is invocable (running / completed / paused /
//      handed_off — NOT failed / stale / expired)
//   3. Verify task-required capabilities are a subset of agent's declared
//      capabilities (otherwise ERR_CAPABILITY_MISMATCH)
//   4. Compose invocation plan: { entry_point, protocol, payload, timeout }
//      — for first-party agents (external=null): plan is `internal_call`
//      with a function descriptor (deferred to v1.12 if a real function
//      registry lands)
//      — for external agents (with external.adapter_type): plan is
//      `external_dispatch` with adapter + config_ref + credential_ref,
//      ready to be wired up in M-003 mission
//   5. Write run journal at .agent/runs/<run_id>/{result,error,rollback}.json
//
// MS-003 boundaries (deliberate):
//   - **NO** real HTTP / CLI / process dispatch. Plan is descriptive only.
//   - **NO** rollback protocol implementation (deferred to M-003 mission
//     when external adapters ship)
//   - **NO** wait-for-result / timeout (no real call to wait on)
//   - **NO** .agent-runtime/coordination/ write (M-008 owns that)
//
// This module produces a journal entry that says "invocation plan was
// generated" + "rolled back (no-op since no real dispatch happened)". The
// success path writes `result.json` with the plan; the failure path writes
// `error.json` + `rollback.json`.

const fs = require("node:fs");
const path = require("node:path");
const { readAgent, VALID_STATUSES } = require("../registry/index");

// Statuses that allow invocation per D-002-3 / agent-invoke.md §5
// ("不 invoke 状态非 available 的 agent" — interpret 'available' as these)
// Note: workflow uses "available" loosely; we map to the 4 valid states.
const INVOCABLE_STATUSES = Object.freeze([
  "running",
  "completed",
  "paused",
  "handed_off",
]);

function runDir(projectRoot, runId) {
  return path.join(projectRoot, ".agent", "runs", runId);
}

function writeRunArtifact(projectRoot, runId, name, payload) {
  const dir = runDir(projectRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

function generateRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `R-agent-invoke-${ts}-${rand}`;
}

function buildInvocationPlan({ entry, taskDescription, input, timeout, requiredCapabilities }) {
  // First-party agent (no external adapter): internal_call plan.
  // M-003 mission will wire real internal function calls (M-008's
  // CoordinationApplicationService is the runtime owner; in MS-003 we
  // don't touch it).
  if (!entry.external) {
    return {
      kind: "internal_call",
      target_agent_id: entry.agent_id,
      entry_point: {
        type: "first_party",
        role: entry.role,
        model: entry.model,
        // Per workflow contract §4, runtime-continuity skill is engaged.
        // The plan records this so a future executor knows what to call.
        skills_required: ["runtime-continuity"],
      },
      payload: {
        task: taskDescription,
        input: input || null,
      },
      protocol: "internal_v1",
      timeout: timeout,
      required_capabilities: requiredCapabilities,
      declared_capabilities: entry.capabilities || [],
      notes: "MS-003 plan only — real execution lands in M-003 mission (5 adapters + 1 MCP bridge)",
    };
  }

  // External agent: external_dispatch plan, ready for M-003 mission to wire.
  return {
    kind: "external_dispatch",
    target_agent_id: entry.agent_id,
    entry_point: {
      type: "external",
      adapter_type: entry.external.adapter_type,
      config_ref: entry.external.config_ref || null,
      credential_ref: entry.external.credential_ref || null,
    },
    payload: {
      task: taskDescription,
      input: input || null,
    },
    protocol: "external_v1",
    timeout: timeout,
    required_capabilities: requiredCapabilities,
    declared_capabilities: entry.capabilities || [],
    notes: "MS-003 plan only — real dispatch lands in M-003 mission (5 adapters)",
  };
}

function invoke({
  projectRoot,
  runId,
  agentId,
  taskDescription,
  input = null,
  requiredCapabilities = [],
  timeout = 300,
  now = Date.now(),
} = {}) {
  if (!projectRoot) {
    const err = new Error("invoke: projectRoot required");
    err.code = "ERR_PROJECT_ROOT_REQUIRED";
    throw err;
  }
  if (!agentId) {
    const err = new Error("invoke: agentId required");
    err.code = "ERR_AGENT_ID_REQUIRED";
    throw err;
  }
  if (!taskDescription || typeof taskDescription !== "string") {
    const err = new Error("invoke: taskDescription required (non-empty string)");
    err.code = "ERR_TASK_DESCRIPTION_REQUIRED";
    throw err;
  }

  const rid = runId || generateRunId();

  // 1. Resolve target agent
  let entry;
  try {
    entry = readAgent(projectRoot, agentId);
  } catch (error) {
    const result = {
      run_id: rid,
      agent_id: agentId,
      error: { code: error.code || "ERR_AGENT_READ", message: error.message },
      written_at: new Date(now).toISOString(),
    };
    writeRunArtifact(projectRoot, rid, "error.json", result);
    return result;
  }
  if (!entry) {
    const result = {
      run_id: rid,
      agent_id: agentId,
      error: { code: "ERR_AGENT_NOT_FOUND", message: `agent "${agentId}" not in .agent/agents/` },
      written_at: new Date(now).toISOString(),
    };
    writeRunArtifact(projectRoot, rid, "error.json", result);
    return result;
  }

  // 2. Verify status is invocable
  if (!INVOCABLE_STATUSES.includes(entry.status)) {
    const result = {
      run_id: rid,
      agent_id: agentId,
      error: {
        code: "ERR_AGENT_NOT_INVOCABLE",
        message: `agent "${agentId}" status is "${entry.status}"; invocable statuses: ${INVOCABLE_STATUSES.join(", ")}`,
      },
      written_at: new Date(now).toISOString(),
    };
    writeRunArtifact(projectRoot, rid, "error.json", result);
    return result;
  }

  // 3. Verify capabilities (subset check)
  if (Array.isArray(requiredCapabilities) && requiredCapabilities.length > 0) {
    const declared = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    const missing = requiredCapabilities.filter((c) => !declared.includes(c));
    if (missing.length > 0) {
      const result = {
        run_id: rid,
        agent_id: agentId,
        error: {
          code: "ERR_CAPABILITY_MISMATCH",
          message: `agent "${agentId}" missing capabilities: ${missing.join(", ")}`,
          required: requiredCapabilities,
          declared: declared,
          missing,
        },
        written_at: new Date(now).toISOString(),
      };
      writeRunArtifact(projectRoot, rid, "error.json", result);
      return result;
    }
  }

  // 4. Compose invocation plan
  const plan = buildInvocationPlan({
    entry,
    taskDescription,
    input,
    timeout,
    requiredCapabilities,
  });

  // 5. Write run journal
  // MS-003 is plan-only: no real dispatch happened, so no rollback needed.
  // We still write a "rollback.json" with status=not_applicable so consumers
  // know the rollback was intentionally a no-op (per D-002-4 strict).
  const result = {
    run_id: rid,
    agent_id: agentId,
    status: "planned",
    plan,
    written_at: new Date(now).toISOString(),
    note: "MS-003 ships plan + journal only. Real execution lands in M-003 mission (5 adapters + 1 MCP bridge, 6-7 weeks).",
  };
  writeRunArtifact(projectRoot, rid, "result.json", result);
  writeRunArtifact(projectRoot, rid, "rollback.json", {
    run_id: rid,
    agent_id: agentId,
    status: "not_applicable",
    reason: "MS-003 plan-only path; no real dispatch was performed; rollback would be a no-op.",
    written_at: new Date(now).toISOString(),
  });

  return result;
}

module.exports = {
  invoke,
  INVOCABLE_STATUSES,
  buildInvocationPlan,
  generateRunId,
  writeRunArtifact,
};
