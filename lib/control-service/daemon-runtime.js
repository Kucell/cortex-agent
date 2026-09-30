"use strict";

const {
  createLocalControlService,
} = require("./local.js");
const {
  createDaemonEngine,
} = require("./daemon-engine.js");
const {
  createFileIdempotencyStore,
} = require("./daemon-idempotency.js");
const {
  createQueuedRequestSource,
  updateDaemonRequest,
} = require("./daemon-requests.js");
const {
  executeDispatch,
  assertApprovedTask,
  SUPPORTED_HOSTS,
} = require("../dispatch/execute.js");

function hostFromSelection(selection) {
  const profile = selection && selection.host_profile_ref;
  if (typeof profile !== "string" || !profile.startsWith("H-")) {
    const error = new Error("daemon dispatch requires a legacy host profile selection");
    error.code = "ERR_DAEMON_HOST_SELECTION";
    throw error;
  }
  const host = profile.slice(2);
  if (!SUPPORTED_HOSTS.includes(host)) {
    const error = new Error("daemon selected host is not supported by legacy dispatch");
    error.code = "ERR_DAEMON_HOST_UNSUPPORTED";
    error.details = { host };
    throw error;
  }
  return host;
}

function createLocalDaemonEngine(projectRoot, options = {}) {
  const requestSource = options.requestSource
    || createQueuedRequestSource(projectRoot, options.requestSourceOptions);
  const idempotency = options.idempotency
    || createFileIdempotencyStore(projectRoot);

  const controlService = options.controlService || createLocalControlService({
    authorize(input) {
      const approval = assertApprovedTask(projectRoot, input.task_id);
      return {
        authorized: true,
        authorization_ref: `decision:${approval.decision.decision_id}`,
      };
    },
    dispatch(input) {
      return executeDispatch({
        projectRoot,
        taskId: input.task_id,
        idempotencyKey: input.idempotency_key,
        gate: input.workflow_gate || "mission",
        host: hostFromSelection(input.selection),
      });
    },
  });

  return createDaemonEngine({
    requestSource,
    controlService,
    idempotency,
    concurrencyLimit: options.concurrencyLimit || 1,
    rememberResult(result) {
      return Boolean(result && result.status === "dispatched");
    },
    async onResult(envelope) {
      const result = envelope && envelope.result;
      const status = result && result.status === "dispatched" ? "processed" : "pending";
      updateDaemonRequest(projectRoot, envelope.task_id, {
        status,
        last_result: result
          ? {
              status: result.status || null,
              reason: result.reason || null,
            }
          : null,
      });
      if (typeof options.onResult === "function") {
        await options.onResult(envelope);
      }
    },
  });
}

module.exports = {
  hostFromSelection,
  createLocalDaemonEngine,
};
