"use strict";

const { PROTOCOL_CURRENT } = require("./version");
const { validateCapabilityList } = require("./capabilities");

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DESCRIPTOR_SCHEMA_VERSION = "1";
const KNOWN_DESCRIPTOR_KEYS = new Set([
  "schema_version",
  "protocol",
  "protocol_version",
  "implementation",
  "implementation_version",
  "capabilities",
  "deprecated_capabilities",
]);
const KNOWN_DEPRECATION_KEYS = new Set([
  "id",
  "replacement",
  "remove_in",
  "reason",
]);

class ProtocolNegotiationError extends Error {
  constructor(code, details = {}) {
    super(`[protocol-negotiation:${code}] ${JSON.stringify(details)}`);
    this.name = "ProtocolNegotiationError";
    this.code = code;
    this.details = details;
  }
}

function parseProtocolVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return Object.freeze({
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
  });
}

function compareProtocolVersions(left, right) {
  const a = typeof left === "string" ? parseProtocolVersion(left) : left;
  const b = typeof right === "string" ? parseProtocolVersion(right) : right;
  if (!a || !b) {
    throw new ProtocolNegotiationError("ERR_PROTOCOL_VERSION_INVALID", { left, right });
  }
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  return 0;
}

function rejectUnknownKeys(value, known, where) {
  for (const key of Object.keys(value || {})) {
    if (!known.has(key)) {
      throw new ProtocolNegotiationError("ERR_PROTOCOL_FIELD_UNKNOWN", { where, key });
    }
  }
}

function nonEmpty(value, where) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolNegotiationError("ERR_PROTOCOL_FIELD_INVALID", { where });
  }
  return value.trim();
}

function normalizeDeprecations(value, capabilities) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new ProtocolNegotiationError("ERR_DEPRECATIONS_INVALID", {});
  }
  const capabilitySet = new Set(capabilities);
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProtocolNegotiationError("ERR_DEPRECATION_INVALID", { item });
    }
    rejectUnknownKeys(item, KNOWN_DEPRECATION_KEYS, "deprecated_capabilities[]");
    const id = nonEmpty(item.id, "deprecated_capabilities[].id");
    if (!capabilitySet.has(id)) {
      throw new ProtocolNegotiationError("ERR_DEPRECATION_CAPABILITY_NOT_PROVIDED", { id });
    }
    if (seen.has(id)) {
      throw new ProtocolNegotiationError("ERR_DEPRECATION_DUPLICATE", { id });
    }
    seen.add(id);
    const replacement = item.replacement == null ? null : nonEmpty(item.replacement, "deprecated_capabilities[].replacement");
    if (replacement) validateCapabilityList([replacement]);
    const removeIn = item.remove_in == null ? null : nonEmpty(item.remove_in, "deprecated_capabilities[].remove_in");
    if (removeIn && !parseProtocolVersion(removeIn)) {
      throw new ProtocolNegotiationError("ERR_DEPRECATION_REMOVE_VERSION_INVALID", { id, remove_in: removeIn });
    }
    out.push(Object.freeze({
      id,
      replacement,
      remove_in: removeIn,
      reason: item.reason == null ? null : nonEmpty(item.reason, "deprecated_capabilities[].reason"),
    }));
  }
  return Object.freeze(out);
}

function createCapabilityDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ProtocolNegotiationError("ERR_DESCRIPTOR_INVALID", {});
  }
  rejectUnknownKeys(input, KNOWN_DESCRIPTOR_KEYS, "descriptor");

  const schemaVersion = input.schema_version == null ? DESCRIPTOR_SCHEMA_VERSION : String(input.schema_version);
  if (schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    throw new ProtocolNegotiationError("ERR_DESCRIPTOR_SCHEMA_VERSION", {
      expected: DESCRIPTOR_SCHEMA_VERSION,
      received: schemaVersion,
    });
  }

  const protocol = nonEmpty(input.protocol, "protocol");
  if (!Object.prototype.hasOwnProperty.call(PROTOCOL_CURRENT, protocol)) {
    throw new ProtocolNegotiationError("ERR_PROTOCOL_UNKNOWN", { protocol });
  }

  const protocolVersion = nonEmpty(input.protocol_version, "protocol_version");
  if (!parseProtocolVersion(protocolVersion)) {
    throw new ProtocolNegotiationError("ERR_PROTOCOL_VERSION_INVALID", { protocol_version: protocolVersion });
  }

  const capabilities = validateCapabilityList(input.capabilities || []);
  const deprecated = normalizeDeprecations(input.deprecated_capabilities, capabilities);

  return Object.freeze({
    schema_version: DESCRIPTOR_SCHEMA_VERSION,
    protocol,
    protocol_version: protocolVersion,
    implementation: nonEmpty(input.implementation, "implementation"),
    implementation_version: input.implementation_version == null
      ? null
      : nonEmpty(input.implementation_version, "implementation_version"),
    capabilities,
    deprecated_capabilities: deprecated,
  });
}

function negotiateProtocol(localInput, remoteInput, options = {}) {
  const local = createCapabilityDescriptor(localInput);
  const remote = createCapabilityDescriptor(remoteInput);

  if (local.protocol !== remote.protocol) {
    throw new ProtocolNegotiationError("ERR_PROTOCOL_NAME_MISMATCH", {
      local: local.protocol,
      remote: remote.protocol,
    });
  }

  const localVersion = parseProtocolVersion(local.protocol_version);
  const remoteVersion = parseProtocolVersion(remote.protocol_version);
  if (localVersion.major !== remoteVersion.major) {
    throw new ProtocolNegotiationError("ERR_PROTOCOL_MAJOR_MISMATCH", {
      local: local.protocol_version,
      remote: remote.protocol_version,
    });
  }

  const remoteCaps = new Set(remote.capabilities);
  const common = local.capabilities.filter((capability) => remoteCaps.has(capability));
  const required = validateCapabilityList(options.required_capabilities || []);
  const commonSet = new Set(common);
  const missing = required.filter((capability) => !commonSet.has(capability));
  if (missing.length) {
    throw new ProtocolNegotiationError("ERR_REQUIRED_CAPABILITY_MISSING", {
      missing,
      common,
    });
  }

  const negotiatedMinor = Math.min(localVersion.minor, remoteVersion.minor);
  const deprecations = [];
  for (const source of [
    ["local", local.deprecated_capabilities],
    ["remote", remote.deprecated_capabilities],
  ]) {
    for (const item of source[1]) {
      if (commonSet.has(item.id)) {
        deprecations.push(Object.freeze({ source: source[0], ...item }));
      }
    }
  }

  return Object.freeze({
    protocol: local.protocol,
    negotiated_version: `${localVersion.major}.${negotiatedMinor}`,
    local_version: local.protocol_version,
    remote_version: remote.protocol_version,
    local_newer: compareProtocolVersions(localVersion, remoteVersion) > 0,
    remote_newer: compareProtocolVersions(localVersion, remoteVersion) < 0,
    capabilities: Object.freeze(common),
    required_capabilities: required,
    deprecated_capabilities: Object.freeze(deprecations),
  });
}

module.exports = {
  DESCRIPTOR_SCHEMA_VERSION,
  ProtocolNegotiationError,
  parseProtocolVersion,
  compareProtocolVersions,
  createCapabilityDescriptor,
  negotiateProtocol,
};
