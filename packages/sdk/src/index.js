"use strict";

const protocol = require("@cortex-agent/protocol");

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

  async function query(projection, filters = {}) {
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
        : async () => ({ protocol_version: protocol.PROTOCOL_VERSION, capabilities: [] }),
    }),
    tasks: Object.freeze({
      get: (taskId) => query("task-state", { task: taskId }),
    }),
    runs: Object.freeze({
      list: () => query("runs"),
      get: (runId) => query("run-state", { run: runId }),
    }),
    decisions: Object.freeze({
      list: () => query("decisions"),
    }),
    waitpoints: Object.freeze({
      list: () => query("waitpoints"),
    }),
    coordination: Object.freeze({
      tasks: Object.freeze({
        list: (filters = {}) => query("coordination-tasks", filters),
        get: (taskId) => query("coordination-tasks", { task: taskId }),
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
