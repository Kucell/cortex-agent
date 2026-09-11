"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createOrchestrationPlan } = require("../../runtime-adapters/orchestration-plan");

class PreflightError extends Error {
  constructor(code, details) {
    super("[agent-orchestration-preflight:" + code + "] " + JSON.stringify(details || {}));
    this.name = "PreflightError";
    this.code = code;
    this.details = details || {};
  }
}

async function captureRuntimeInventory(projectRoot, deps) {
  deps = deps || {};
  const resolveLayout = deps.resolveLayout
    || (await import("../../runtime-layout/resolver.js")).resolveRuntimeLayout;
  const layout = resolveLayout(projectRoot);
  const namespace = layout && layout.namespace ? layout.namespace : null;
  return {
    namespace: namespace,
    taskCount: 0, leaseCount: 0, runCount: 0,
    queueCount: 0, sessionCount: 0, operationCount: 0,
    childPids: [],
  };
}

function diffInventory(before, after) {
  const fields = ["taskCount","leaseCount","runCount","queueCount","sessionCount","operationCount"];
  const diffs = [];
  for (const f of fields) {
    if ((before[f] || 0) !== (after[f] || 0)) {
      diffs.push({ field: f, before: before[f] || 0, after: after[f] || 0 });
    }
  }
  const beforePids = new Set(before.childPids || []);
  const newPids = (after.childPids || []).filter(function(pid) { return !beforePids.has(pid); });
  if (newPids.length > 0) diffs.push({ field: "childPids", newPids: newPids });
  return diffs;
}

function loadPlan(planPath) {
  if (!planPath || typeof planPath !== "string") {
    throw new PreflightError("ERR_PLAN_PATH_REQUIRED");
  }
  const absolute = path.resolve(planPath);
  if (!fs.existsSync(absolute)) {
    throw new PreflightError("ERR_PLAN_FILE_MISSING", { path: absolute });
  }
  const raw = fs.readFileSync(absolute, "utf-8");
  let json;
  try { json = JSON.parse(raw); } catch (err) {
    throw new PreflightError("ERR_PLAN_INVALID_JSON", { path: absolute, message: err.message });
  }
  try { return createOrchestrationPlan(json); } catch (err) {
    throw new PreflightError("ERR_PLAN_SCHEMA_INVALID", { path: absolute, code: err.code || null, message: err.message });
  }
}

function detectEntry(plan) {
  return plan && typeof plan.entry === "string" ? plan.entry : null;
}

function detectConflicts(plan) {
  const blockers = [];
  const req = plan.hostRequirement || { capabilities: [], degradedAllowed: false };
  // Capability gap: declared capability with no matching resource/dependency
  for (const cap of req.capabilities || []) {
    const hasMatch = (plan.dependencies || []).some(function(d) { return d.indexOf(cap) !== -1; })
                  || (plan.resources || []).some(function(r) { return r.indexOf(cap) !== -1; });
    if (!hasMatch) {
      blockers.push({
        code: "ERR_HOST_CAPABILITY_GAP",
        owner: "coordinator",
        nextAction: "Add resource or dependency matching capability " + cap + ".",
      });
    }
  }
  // Missing gate decision or waitpoint
  if (!plan.gates || !plan.gates.decision) {
    blockers.push({
      code: "ERR_GATE_DECISION_MISSING",
      owner: "user",
      nextAction: "Bind a Decision gate before preflight.",
    });
  }
  if (!plan.gates || !plan.gates.waitpoint) {
    blockers.push({
      code: "ERR_GATE_WAITPOINT_MISSING",
      owner: "user",
      nextAction: "Bind a Waitpoint gate before preflight.",
    });
  }
  return blockers;
}

function computeReport(plan, projectRoot, deps) {
  deps = deps || {};
  const inventory = deps.inventory || null;
  const entry = detectEntry(plan);
  const detectedBlockers = detectConflicts(plan);
  const planBlockers = (plan.blockers || []).slice();
  const allBlockers = detectedBlockers.concat(planBlockers);
  const result = allBlockers.length === 0 ? "would_proceed" : "blocked";
  return {
    schemaVersion: plan.schemaVersion,
    entry: entry,
    conflicts: detectedBlockers.map(function(b) { return b.code; }),
    missingGates: allBlockers.filter(function(b) { return b.code && b.code.indexOf("ERR_GATE_") === 0; }).map(function(b) { return b.code; }),
    hostCapabilityGaps: detectedBlockers.filter(function(b) { return b.code && b.code.indexOf("ERR_HOST_") === 0; }).map(function(b) { return b.code; }),
    blockers: allBlockers.map(function(b) { return { code: b.code, owner: b.owner, nextAction: b.nextAction }; }),
    nextAction: allBlockers.length === 0
      ? { kind: "execute", description: "Proceed with entry " + (entry || "(none)") + "." }
      : { kind: "recover", description: "Resolve " + allBlockers.length + " blocker(s); first owner: " + allBlockers[0].owner + "." },
    result: result,
    runtimeInventorySnapshot: inventory,
  };
}

async function preflight(input) {
  if (!input || typeof input !== "object") {
    throw new PreflightError("ERR_INPUT_REQUIRED");
  }
  const planPath = input.planPath;
  const projectRoot = input.projectRoot;
  const deps = input.deps || {};
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new PreflightError("ERR_PROJECT_ROOT_REQUIRED");
  }
  const before = deps.beforeInventory || await captureRuntimeInventory(projectRoot, deps);
  const plan = loadPlan(planPath);
  const report = computeReport(plan, projectRoot, Object.assign({}, deps, { inventory: before }));
  const after = deps.afterInventory || await captureRuntimeInventory(projectRoot, deps);
  const diffs = diffInventory(before, after);
  if (diffs.length > 0) {
    throw new PreflightError("ERR_RUNTIME_DRIFT_DETECTED", { diffs: diffs });
  }
  return report;
}

module.exports = {
  preflight: preflight,
  loadPlan: loadPlan,
  detectEntry: detectEntry,
  detectConflicts: detectConflicts,
  computeReport: computeReport,
  captureRuntimeInventory: captureRuntimeInventory,
  diffInventory: diffInventory,
  PreflightError: PreflightError,
};
