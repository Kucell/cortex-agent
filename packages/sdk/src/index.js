"use strict";

let protocol;
try {
  protocol = require("@cortex-agent/protocol");
} catch (error) {
  // Root cortex-agent compatibility: the meta/CLI package ships workspace
  // sources together, but npm does not create workspace links inside that
  // package. Standalone @cortex-agent/sdk installs resolve the package name.
  protocol = require("../../protocol/src/index.js");
}

function requireTransport(transport) {
  if (!transport || typeof transport.query !== "function") {
    const error = new Error("Cortex SDK requires a transport with query(projection, filters).");
    error.code = "ERR_SDK_TRANSPORT_REQUIRED";
    throw error;
  }
  return transport;
}

function createCortexClient(options = {}) {
  const transport = requireTransport(options.transport);

  // Deliberately not declared async: local/root CLI transports are synchronous,
  // while remote transports may return Promises. Callers can await either.
  function queryProjection(projection, filters = {}) {
    return transport.query(projection, filters);
  }

  return Object.freeze({
    protocol,
    project: Object.freeze({
      resolve: typeof transport.resolveProject === "function"
        ? () => transport.resolveProject()
        : undefined,
    }),
    capabilities: Object.freeze({
      discover: typeof transport.discoverCapabilities === "function"
        ? () => transport.discoverCapabilities()
        : () => ({ protocol_version: protocol.PROTOCOL_VERSION, capabilities: [] }),
    }),
    management: Object.freeze({
      query: queryProjection,
      capabilities: () => queryProjection("capabilities"),
    }),
    tasks: Object.freeze({
      get: (taskId) => queryProjection("task-state", { task: taskId }),
    }),
    runs: Object.freeze({
      list: () => queryProjection("runs"),
      get: (runId) => queryProjection("run-state", { run: runId }),
    }),
    decisions: Object.freeze({
      list: () => queryProjection("decisions"),
    }),
    waitpoints: Object.freeze({
      list: () => queryProjection("waitpoints"),
    }),
    coordination: Object.freeze({
      tasks: Object.freeze({
        list: (filters = {}) => queryProjection("coordination-tasks", filters),
        get: (taskId) => queryProjection("coordination-tasks", { task: taskId }),
      }),
    }),
    topology: Object.freeze({
      get: typeof transport.getTopology === "function"
        ? () => transport.getTopology()
        : undefined,
    }),
  });
}

module.exports = {
  createCortexClient,
};
