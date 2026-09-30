"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  atomicWrite,
  readJson,
  runtimeRoot,
} = require("./daemon-state.js");
const {
  queryDispatchState,
} = require("../coordination/dispatch-state.js");

const REQUEST_SCHEMA_VERSION = 1;

function requestsRoot(projectRoot) {
  return path.join(runtimeRoot(projectRoot), "requests");
}

function requestFilename(taskId) {
  return crypto.createHash("sha256").update(String(taskId)).digest("hex") + ".json";
}

function requestPath(projectRoot, taskId) {
  return path.join(requestsRoot(projectRoot), requestFilename(taskId));
}

function validateRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    const error = new Error("daemon request must be an object");
    error.code = "ERR_DAEMON_REQUEST_INVALID";
    throw error;
  }
  for (const field of [
    "task_id",
    "idempotency_key",
    "workflow_gate",
    "runtime_requirement",
    "endpoints",
    "host_requirement",
    "bindings",
  ]) {
    if (input[field] === undefined || input[field] === null) {
      const error = new Error(`daemon request field required: ${field}`);
      error.code = "ERR_DAEMON_REQUEST_FIELD";
      error.details = { field };
      throw error;
    }
  }
  if (typeof input.task_id !== "string" || !input.task_id.trim()) {
    const error = new Error("daemon request task_id invalid");
    error.code = "ERR_DAEMON_REQUEST_TASK";
    throw error;
  }
  if (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim()) {
    const error = new Error("daemon request idempotency_key invalid");
    error.code = "ERR_DAEMON_REQUEST_IDEMPOTENCY";
    throw error;
  }
  if (!["mission", "agent", "user", "owner"].includes(input.workflow_gate)) {
    const error = new Error("daemon request workflow_gate invalid");
    error.code = "ERR_DAEMON_REQUEST_GATE";
    throw error;
  }
  if (!Array.isArray(input.endpoints) || !Array.isArray(input.bindings)) {
    const error = new Error("daemon request endpoints/bindings must be arrays");
    error.code = "ERR_DAEMON_REQUEST_ROUTING";
    throw error;
  }
  if (input.opt_in !== true) {
    const error = new Error("daemon request requires explicit opt_in=true");
    error.code = "ERR_DAEMON_REQUEST_OPT_IN";
    throw error;
  }
  return input;
}

function submitDaemonRequest(projectRoot, input) {
  validateRequest(input);
  const record = {
    schema_version: REQUEST_SCHEMA_VERSION,
    status: "pending",
    opt_in: true,
    task_id: input.task_id,
    idempotency_key: input.idempotency_key,
    workflow_gate: input.workflow_gate,
    runtime_requirement: input.runtime_requirement,
    endpoints: input.endpoints,
    host_requirement: input.host_requirement,
    bindings: input.bindings,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_result: null,
  };
  atomicWrite(requestPath(projectRoot, input.task_id), record);
  return record;
}

function listDaemonRequests(projectRoot) {
  const root = requestsRoot(projectRoot);
  let names = [];
  try {
    names = fs.readdirSync(root).filter((name) => name.endsWith(".json")).sort();
  } catch (_) {
    return [];
  }
  return names
    .map((name) => readJson(path.join(root, name), null))
    .filter((record) => record && record.schema_version === REQUEST_SCHEMA_VERSION);
}

function updateDaemonRequest(projectRoot, taskId, patch) {
  const file = requestPath(projectRoot, taskId);
  const current = readJson(file, null);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    schema_version: REQUEST_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
  atomicWrite(file, next);
  return next;
}

function createQueuedRequestSource(projectRoot, options = {}) {
  const readDispatchState = options.readDispatchState
    || (() => queryDispatchState(projectRoot));

  return async function requestSource() {
    const dispatchState = await Promise.resolve(readDispatchState());
    const queued = new Set(
      (dispatchState && Array.isArray(dispatchState.queued) ? dispatchState.queued : [])
        .map((item) => item.task_id)
        .filter(Boolean),
    );

    return listDaemonRequests(projectRoot)
      .filter((record) =>
        record.status === "pending"
        && record.opt_in === true
        && queued.has(record.task_id))
      .map((record) => Object.freeze({
        task_id: record.task_id,
        idempotency_key: record.idempotency_key,
        workflow_gate: record.workflow_gate,
        project_root: path.resolve(projectRoot),
        runtime_requirement: record.runtime_requirement,
        endpoints: record.endpoints,
        host_requirement: record.host_requirement,
        bindings: record.bindings,
      }));
  };
}

module.exports = {
  REQUEST_SCHEMA_VERSION,
  requestsRoot,
  requestPath,
  validateRequest,
  submitDaemonRequest,
  listDaemonRequests,
  updateDaemonRequest,
  createQueuedRequestSource,
};
