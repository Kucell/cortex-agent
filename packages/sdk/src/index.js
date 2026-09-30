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

function normalizeDescriptor(value) {
  if (value && typeof value.then === "function") {
    return value.then((resolved) => protocol.createCapabilityDescriptor(resolved));
  }
  return protocol.createCapabilityDescriptor(value);
}

function createCortexClient(options = {}) {
  const transport = requireTransport(options.transport);

  // Deliberately not declared async: local/root CLI transports are synchronous,
  // while remote transports may return Promises. Callers can await either.
  function queryProjection(projection, filters = {}) {
    return transport.query(projection, filters);
  }

  function discoverCapabilities() {
    const raw = typeof transport.discoverCapabilities === "function"
      ? transport.discoverCapabilities()
      : {
          protocol: protocol.PROTOCOL_NAME,
          protocol_version: protocol.PROTOCOL_VERSION,
          implementation: "cortex-sdk-transport",
          implementation_version: null,
          capabilities: [],
        };
    return normalizeDescriptor(raw);
  }

  return Object.freeze({
    protocol,
    project: Object.freeze({
      resolve: typeof transport.resolveProject === "function"
        ? () => transport.resolveProject()
        : undefined,
      connected: Object.freeze({
        list: typeof transport.listConnectedProjects === "function"
          ? () => transport.listConnectedProjects()
          : undefined,
        get: typeof transport.getConnectedProject === "function"
          ? (projectRefOrId, options = {}) => transport.getConnectedProject(projectRefOrId, options)
          : undefined,
        register: typeof transport.registerConnectedProject === "function"
          ? (projectRoot, options = {}) => transport.registerConnectedProject(projectRoot, options)
          : undefined,
        unregister: typeof transport.unregisterConnectedProject === "function"
          ? (projectRefOrId) => transport.unregisterConnectedProject(projectRefOrId)
          : undefined,
      }),
    }),
    capabilities: Object.freeze({
      discover: discoverCapabilities,
      negotiate: (remoteDescriptor, options = {}) => {
        const local = discoverCapabilities();
        if (local && typeof local.then === "function") {
          return local.then((resolved) => protocol.negotiateProtocol(resolved, remoteDescriptor, options));
        }
        return protocol.negotiateProtocol(local, remoteDescriptor, options);
      },
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
