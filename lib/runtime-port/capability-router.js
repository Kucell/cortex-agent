"use strict";

const {
  filterRuntimeEndpoints,
} = require("../../packages/runtime-port/src/index.js");
const {
  matchExecutionSurface,
} = require("../runtime-adapters/execution-surface-matcher.js");

class RuntimeRoutingError extends Error {
  constructor(code, details = {}) {
    super(`[runtime-routing:${code}] ${JSON.stringify(details)}`);
    this.name = "RuntimeRoutingError";
    this.code = code;
    this.details = details;
  }
}

function normalizeBinding(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeRoutingError("ERR_RUNTIME_HOST_BINDING_INVALID", { index });
  }
  const keys = Object.keys(input);
  for (const key of keys) {
    if (!["endpoint_ref", "snapshot"].includes(key)) {
      throw new RuntimeRoutingError("ERR_RUNTIME_HOST_BINDING_FIELD_UNKNOWN", {
        index,
        key,
      });
    }
  }
  if (typeof input.endpoint_ref !== "string" || !input.endpoint_ref) {
    throw new RuntimeRoutingError("ERR_RUNTIME_HOST_BINDING_ENDPOINT", { index });
  }
  if (!input.snapshot || typeof input.snapshot !== "object" || Array.isArray(input.snapshot)) {
    throw new RuntimeRoutingError("ERR_RUNTIME_HOST_BINDING_SNAPSHOT", { index });
  }
  return Object.freeze({
    endpoint_ref: input.endpoint_ref,
    snapshot: input.snapshot,
  });
}

function routeRuntimeEndpoints(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeRoutingError("ERR_RUNTIME_ROUTING_INPUT", {});
  }
  if (!input.host_requirement) {
    throw new RuntimeRoutingError("ERR_HOST_REQUIREMENT_REQUIRED", {});
  }

  const runtimeFilter = filterRuntimeEndpoints(
    input.runtime_requirement,
    input.endpoints || [],
  );
  const acceptedByRef = new Map(
    runtimeFilter.accepted.map((endpoint) => [endpoint.endpoint_ref, endpoint]),
  );

  const bindings = (input.bindings || []).map(normalizeBinding);
  const usableBindings = [];
  const missingSnapshotEndpoints = [];

  for (const endpoint of runtimeFilter.accepted) {
    const binding = bindings.find((item) => item.endpoint_ref === endpoint.endpoint_ref);
    if (!binding) {
      missingSnapshotEndpoints.push(endpoint.endpoint_ref);
      continue;
    }
    usableBindings.push(binding);
  }

  const profileOwners = new Map();
  for (const binding of usableBindings) {
    const hostProfileRef = binding.snapshot.host_profile_ref;
    if (typeof hostProfileRef !== "string" || !hostProfileRef) {
      throw new RuntimeRoutingError("ERR_RUNTIME_HOST_PROFILE_REF_REQUIRED", {
        endpoint_ref: binding.endpoint_ref,
      });
    }
    if (profileOwners.has(hostProfileRef)) {
      throw new RuntimeRoutingError("ERR_RUNTIME_HOST_BINDING_AMBIGUOUS", {
        host_profile_ref: hostProfileRef,
        endpoints: [profileOwners.get(hostProfileRef), binding.endpoint_ref],
      });
    }
    profileOwners.set(hostProfileRef, binding.endpoint_ref);
  }

  const hostPlan = matchExecutionSurface(
    input.host_requirement,
    usableBindings.map((item) => item.snapshot),
    options,
  );

  let selection = null;
  if (hostPlan.selection) {
    const endpointRef = profileOwners.get(hostPlan.selection);
    const endpoint = endpointRef ? acceptedByRef.get(endpointRef) : null;
    if (!endpoint) {
      throw new RuntimeRoutingError("ERR_RUNTIME_SELECTION_BINDING_MISSING", {
        host_profile_ref: hostPlan.selection,
      });
    }
    selection = Object.freeze({
      endpoint_ref: endpoint.endpoint_ref,
      host_ref: endpoint.host_ref,
      runtime_ref: endpoint.runtime_ref,
      host_profile_ref: hostPlan.selection,
    });
  }

  return Object.freeze({
    runtime_filter: runtimeFilter,
    missing_snapshot_endpoints: Object.freeze(missingSnapshotEndpoints),
    host_plan: hostPlan,
    selection,
    authorization: Object.freeze({
      authorized: false,
      reason: "routing_is_not_authorization",
    }),
  });
}

module.exports = {
  RuntimeRoutingError,
  routeRuntimeEndpoints,
};
