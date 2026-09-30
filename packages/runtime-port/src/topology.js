"use strict";

let protocol;
try {
  protocol = require("@cortex-agent/protocol");
} catch (_) {
  protocol = require("../../protocol/src/index.js");
}

const RUNTIME_ENDPOINT_SCHEMA_VERSION = "1";
const RUNTIME_REQUIREMENT_SCHEMA_VERSION = "1";

const RUNTIME_LOCATIONS = Object.freeze(["local", "remote"]);
const RUNTIME_TRANSPORTS = Object.freeze([
  "in-process",
  "stdio",
  "http",
  "websocket",
  "ipc",
  "ssh",
  "custom",
]);
const RUNTIME_AVAILABILITY = Object.freeze([
  "available",
  "unavailable",
  "unknown",
]);

const ENDPOINT_KEYS = new Set([
  "schema_version",
  "endpoint_ref",
  "host_ref",
  "runtime_ref",
  "location",
  "transport",
  "availability",
  "descriptor",
  "workspace_refs",
]);

const REQUIREMENT_KEYS = new Set([
  "schema_version",
  "requirement_id",
  "required_capabilities",
  "endpoint_ref",
  "host_ref",
  "runtime_ref",
  "location",
  "transport",
  "workspace_ref",
  "require_available",
]);

class RuntimeTopologyError extends Error {
  constructor(code, details = {}) {
    super(`[runtime-topology:${code}] ${JSON.stringify(details)}`);
    this.name = "RuntimeTopologyError";
    this.code = code;
    this.details = details;
  }
}

function rejectUnknownKeys(value, known, where) {
  for (const key of Object.keys(value || {})) {
    if (!known.has(key)) {
      throw new RuntimeTopologyError("ERR_RUNTIME_TOPOLOGY_FIELD_UNKNOWN", {
        where,
        key,
      });
    }
  }
}

function requireRef(value, kind, where) {
  if (!protocol.isRef(value, kind)) {
    throw new RuntimeTopologyError("ERR_RUNTIME_TOPOLOGY_REF_INVALID", {
      where,
      expected_kind: kind,
      value,
    });
  }
  return value;
}

function optionalRef(value, kind, where) {
  if (value == null) return null;
  return requireRef(value, kind, where);
}

function requireEnum(value, allowed, where) {
  if (!allowed.includes(value)) {
    throw new RuntimeTopologyError("ERR_RUNTIME_TOPOLOGY_ENUM_INVALID", {
      where,
      value,
      allowed,
    });
  }
  return value;
}

function normalizeRuntimeCapabilities(values, where) {
  const capabilities = protocol.validateCapabilityList(values || []);
  for (const capability of capabilities) {
    const parsed = protocol.parseCapabilityId(capability);
    if (!parsed || parsed.namespace !== "runtime") {
      throw new RuntimeTopologyError("ERR_RUNTIME_CAPABILITY_NAMESPACE", {
        where,
        capability,
      });
    }
  }
  return capabilities;
}

function normalizeRuntimeEndpoint(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeTopologyError("ERR_RUNTIME_ENDPOINT_INVALID", {});
  }
  rejectUnknownKeys(input, ENDPOINT_KEYS, "endpoint");

  const schemaVersion = input.schema_version == null
    ? RUNTIME_ENDPOINT_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== RUNTIME_ENDPOINT_SCHEMA_VERSION) {
    throw new RuntimeTopologyError("ERR_RUNTIME_ENDPOINT_SCHEMA_VERSION", {
      expected: RUNTIME_ENDPOINT_SCHEMA_VERSION,
      received: schemaVersion,
    });
  }

  const descriptor = protocol.createCapabilityDescriptor(input.descriptor || {});
  if (descriptor.protocol !== protocol.RUNTIME_PROTOCOL_NAME) {
    throw new RuntimeTopologyError("ERR_RUNTIME_ENDPOINT_PROTOCOL", {
      protocol: descriptor.protocol,
    });
  }
  normalizeRuntimeCapabilities(descriptor.capabilities, "endpoint.descriptor.capabilities");

  const workspaceRefs = Array.isArray(input.workspace_refs)
    ? input.workspace_refs.map((value, index) =>
        requireRef(value, "workspace", `endpoint.workspace_refs[${index}]`))
    : [];
  const dedupedWorkspaces = Object.freeze([...new Set(workspaceRefs)]);

  return Object.freeze({
    schema_version: RUNTIME_ENDPOINT_SCHEMA_VERSION,
    endpoint_ref: requireRef(input.endpoint_ref, "runtime-endpoint", "endpoint.endpoint_ref"),
    host_ref: requireRef(input.host_ref, "host", "endpoint.host_ref"),
    runtime_ref: requireRef(input.runtime_ref, "runtime", "endpoint.runtime_ref"),
    location: requireEnum(input.location, RUNTIME_LOCATIONS, "endpoint.location"),
    transport: requireEnum(input.transport, RUNTIME_TRANSPORTS, "endpoint.transport"),
    availability: requireEnum(
      input.availability == null ? "unknown" : input.availability,
      RUNTIME_AVAILABILITY,
      "endpoint.availability",
    ),
    descriptor,
    workspace_refs: dedupedWorkspaces,
  });
}

function normalizeRuntimeRequirement(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new RuntimeTopologyError("ERR_RUNTIME_REQUIREMENT_INVALID", {});
  }
  rejectUnknownKeys(input, REQUIREMENT_KEYS, "requirement");

  const schemaVersion = input.schema_version == null
    ? RUNTIME_REQUIREMENT_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== RUNTIME_REQUIREMENT_SCHEMA_VERSION) {
    throw new RuntimeTopologyError("ERR_RUNTIME_REQUIREMENT_SCHEMA_VERSION", {
      expected: RUNTIME_REQUIREMENT_SCHEMA_VERSION,
      received: schemaVersion,
    });
  }

  if (typeof input.requirement_id !== "string" || !input.requirement_id.trim()) {
    throw new RuntimeTopologyError("ERR_RUNTIME_REQUIREMENT_ID", {});
  }

  return Object.freeze({
    schema_version: RUNTIME_REQUIREMENT_SCHEMA_VERSION,
    requirement_id: input.requirement_id.trim(),
    required_capabilities: normalizeRuntimeCapabilities(
      input.required_capabilities || [],
      "requirement.required_capabilities",
    ),
    endpoint_ref: optionalRef(
      input.endpoint_ref,
      "runtime-endpoint",
      "requirement.endpoint_ref",
    ),
    host_ref: optionalRef(input.host_ref, "host", "requirement.host_ref"),
    runtime_ref: optionalRef(input.runtime_ref, "runtime", "requirement.runtime_ref"),
    location: input.location == null
      ? null
      : requireEnum(input.location, RUNTIME_LOCATIONS, "requirement.location"),
    transport: input.transport == null
      ? null
      : requireEnum(input.transport, RUNTIME_TRANSPORTS, "requirement.transport"),
    workspace_ref: optionalRef(
      input.workspace_ref,
      "workspace",
      "requirement.workspace_ref",
    ),
    require_available: input.require_available !== false,
  });
}

function reject(reasons, code, details = {}) {
  reasons.push(Object.freeze({ code, details: Object.freeze({ ...details }) }));
}

function evaluateRuntimeEndpoint(requirement, endpoint) {
  const reasons = [];

  if (requirement.endpoint_ref && endpoint.endpoint_ref !== requirement.endpoint_ref) {
    reject(reasons, "endpoint_mismatch", {
      expected: requirement.endpoint_ref,
      actual: endpoint.endpoint_ref,
    });
  }
  if (requirement.host_ref && endpoint.host_ref !== requirement.host_ref) {
    reject(reasons, "host_mismatch", {
      expected: requirement.host_ref,
      actual: endpoint.host_ref,
    });
  }
  if (requirement.runtime_ref && endpoint.runtime_ref !== requirement.runtime_ref) {
    reject(reasons, "runtime_mismatch", {
      expected: requirement.runtime_ref,
      actual: endpoint.runtime_ref,
    });
  }
  if (requirement.location && endpoint.location !== requirement.location) {
    reject(reasons, "location_mismatch", {
      expected: requirement.location,
      actual: endpoint.location,
    });
  }
  if (requirement.transport && endpoint.transport !== requirement.transport) {
    reject(reasons, "transport_mismatch", {
      expected: requirement.transport,
      actual: endpoint.transport,
    });
  }
  if (requirement.require_available && endpoint.availability !== "available") {
    reject(reasons, "runtime_unavailable", {
      availability: endpoint.availability,
    });
  }
  if (requirement.workspace_ref
    && !endpoint.workspace_refs.includes(requirement.workspace_ref)) {
    reject(reasons, "workspace_unavailable", {
      workspace_ref: requirement.workspace_ref,
    });
  }

  const provided = new Set(endpoint.descriptor.capabilities);
  for (const capability of requirement.required_capabilities) {
    if (!provided.has(capability)) {
      reject(reasons, "missing_runtime_capability", { capability });
    }
  }

  return Object.freeze({
    endpoint_ref: endpoint.endpoint_ref,
    accepted: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

function filterRuntimeEndpoints(requirementInput, endpointInputs) {
  const requirement = normalizeRuntimeRequirement(requirementInput);
  if (!Array.isArray(endpointInputs)) {
    throw new RuntimeTopologyError("ERR_RUNTIME_ENDPOINT_LIST_INVALID", {});
  }
  const endpoints = endpointInputs.map(normalizeRuntimeEndpoint);
  const evaluations = endpoints
    .map((endpoint) => ({
      endpoint,
      evaluation: evaluateRuntimeEndpoint(requirement, endpoint),
    }))
    .sort((left, right) =>
      left.endpoint.endpoint_ref.localeCompare(right.endpoint.endpoint_ref));

  return Object.freeze({
    requirement,
    accepted: Object.freeze(
      evaluations
        .filter((item) => item.evaluation.accepted)
        .map((item) => item.endpoint),
    ),
    rejected: Object.freeze(
      evaluations
        .filter((item) => !item.evaluation.accepted)
        .map((item) => Object.freeze({
          endpoint: item.endpoint,
          reasons: item.evaluation.reasons,
        })),
    ),
  });
}

module.exports = {
  RUNTIME_ENDPOINT_SCHEMA_VERSION,
  RUNTIME_REQUIREMENT_SCHEMA_VERSION,
  RUNTIME_LOCATIONS,
  RUNTIME_TRANSPORTS,
  RUNTIME_AVAILABILITY,
  RuntimeTopologyError,
  normalizeRuntimeEndpoint,
  normalizeRuntimeRequirement,
  evaluateRuntimeEndpoint,
  filterRuntimeEndpoints,
};
