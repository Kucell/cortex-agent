"use strict";

const SURFACE_SCHEMA_VERSION = "1";

class PaseoGovernanceSurfaceError extends Error {
  constructor(code, details = {}) {
    super(`[paseo-governance:${code}] ${JSON.stringify(details)}`);
    this.name = "PaseoGovernanceSurfaceError";
    this.code = code;
    this.details = details;
  }
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

function scalar(value) {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function boundedScalars(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key) && scalar(value[key])) {
      out[key] = value[key];
    }
  }
  return out;
}

function summarizeDecisions(value) {
  const items = arrayFrom(value).map((item) => Object.freeze(boundedScalars(item, [
    "decision_id",
    "status",
    "type",
    "workflow_gate",
    "gate",
  ])));
  return Object.freeze({
    total: items.length,
    pending: items.filter((item) => ["open", "pending", "requested"].includes(item.status)).length,
    items: Object.freeze(items),
  });
}

function summarizeWaitpoints(value) {
  const items = arrayFrom(value).map((item) => Object.freeze(boundedScalars(item, [
    "waitpoint_id",
    "status",
    "owner_workflow",
    "decision_id",
    "workflow_gate",
  ])));
  return Object.freeze({
    total: items.length,
    pending: items.filter((item) => ["pending", "blocked", "waiting"].includes(item.status)).length,
    items: Object.freeze(items),
  });
}

function summarizeRuns(value) {
  const items = arrayFrom(value).map((item) => Object.freeze(boundedScalars(item, [
    "run_id",
    "task_id",
    "status",
    "phase",
    "kind",
    "agent_id",
  ])));
  return Object.freeze({
    total: items.length,
    active: items.filter((item) => !["completed", "failed", "cancelled", "closed", "archived"].includes(item.status)).length,
    items: Object.freeze(items),
  });
}

function summarizeTask(value) {
  if (!value || typeof value !== "object") return null;
  const data = value.data && typeof value.data === "object" ? value.data : value;
  return Object.freeze(boundedScalars(data, [
    "task_id",
    "id",
    "status",
    "state",
    "phase",
    "validation_status",
  ]));
}

function projectionSummary(value) {
  const data = value && Object.prototype.hasOwnProperty.call(value, "data")
    ? value.data
    : value;
  if (Array.isArray(data)) {
    return Object.freeze({ kind: "collection", count: data.length });
  }
  if (data && typeof data === "object") {
    return Object.freeze({
      kind: "object",
      ...boundedScalars(data, [
        "status",
        "state",
        "verdict",
        "ready",
        "health",
        "validation_status",
        "risk_tier",
      ]),
    });
  }
  return Object.freeze({ kind: "scalar", value: scalar(data) ? data : null });
}

function errorSummary(error) {
  return Object.freeze({
    code: error && error.code ? String(error.code) : "UNAVAILABLE",
    message: error && error.message ? String(error.message).slice(0, 256) : "projection unavailable",
  });
}

async function optionalProjection(client, name) {
  if (!client.management || typeof client.management.query !== "function") {
    return Object.freeze({
      available: false,
      error: Object.freeze({ code: "SDK_MANAGEMENT_UNAVAILABLE", message: "management.query unavailable" }),
    });
  }
  try {
    const value = await client.management.query(name);
    return Object.freeze({
      available: true,
      summary: projectionSummary(value),
    });
  } catch (error) {
    return Object.freeze({
      available: false,
      error: errorSummary(error),
    });
  }
}

function createPaseoGovernanceSurface(client) {
  if (!client || typeof client !== "object") {
    throw new PaseoGovernanceSurfaceError("ERR_CORTEX_CLIENT_REQUIRED", {});
  }
  if (!client.runs || typeof client.runs.list !== "function"
    || !client.decisions || typeof client.decisions.list !== "function"
    || !client.waitpoints || typeof client.waitpoints.list !== "function") {
    throw new PaseoGovernanceSurfaceError("ERR_CORTEX_READ_SURFACE_REQUIRED", {});
  }

  async function snapshot(options = {}) {
    const taskId = options.task_id || null;
    const [project, runs, decisions, waitpoints, task, readiness, progress, knowledge] =
      await Promise.all([
        client.project && typeof client.project.resolve === "function"
          ? Promise.resolve(client.project.resolve()).catch(() => null)
          : null,
        Promise.resolve(client.runs.list()),
        Promise.resolve(client.decisions.list()),
        Promise.resolve(client.waitpoints.list()),
        taskId && client.tasks && typeof client.tasks.get === "function"
          ? Promise.resolve(client.tasks.get(taskId)).catch(() => null)
          : null,
        optionalProjection(client, "readiness"),
        optionalProjection(client, "governed-attempt-progress"),
        optionalProjection(client, "knowledge-health"),
      ]);

    return Object.freeze({
      schema_version: SURFACE_SCHEMA_VERSION,
      surface: "paseo-cortex-governance",
      generated_at: options.now || new Date().toISOString(),
      project: project
        ? Object.freeze(boundedScalars(project, ["project_ref", "project_id"]))
        : null,
      mission: Object.freeze({
        mission_id: options.mission_id || null,
        milestone_id: options.milestone_id || null,
        task: summarizeTask(task),
      }),
      gates: Object.freeze({
        decisions: summarizeDecisions(decisions),
        waitpoints: summarizeWaitpoints(waitpoints),
      }),
      execution: Object.freeze({
        runs: summarizeRuns(runs),
      }),
      verification: Object.freeze({
        readiness,
        governed_attempt_progress: progress,
      }),
      knowledge: Object.freeze({
        health: knowledge,
      }),
      mutation: Object.freeze({
        supported: false,
        reason: "read_only_governance_surface",
      }),
    });
  }

  return Object.freeze({ snapshot });
}

module.exports = {
  SURFACE_SCHEMA_VERSION,
  PaseoGovernanceSurfaceError,
  createPaseoGovernanceSurface,
  summarizeDecisions,
  summarizeWaitpoints,
  summarizeRuns,
};
