"use strict";

let protocol;
try {
  protocol = require("@cortex-agent/protocol");
} catch (_) {
  protocol = require("../../protocol/src/index.js");
}

const EXTENSION_MANIFEST_SCHEMA_VERSION = "1";
const EXTENSION_TYPES = Object.freeze([
  "agent-adapter",
  "host-adapter",
  "runtime-adapter",
  "knowledge-provider",
  "policy-provider",
  "workflow",
  "skill",
  "validator",
  "event-consumer",
  "ui-surface",
  "project-adapter",
  "project-provider",
]);

const ENTRY_POINT_KEYS = Object.freeze(["server", "client", "cli", "worker"]);
const TOP_KEYS = new Set([
  "schema_version",
  "id",
  "version",
  "type",
  "cortex",
  "capabilities",
  "permissions",
  "entry_points",
  "config_schema",
]);
const CORTEX_KEYS = new Set([
  "protocol",
  "min_version",
  "max_version_exclusive",
]);
const CAPABILITY_KEYS = new Set(["provided", "required"]);

class ExtensionManifestError extends Error {
  constructor(code, details = {}) {
    super(`[extension-manifest:${code}] ${JSON.stringify(details)}`);
    this.name = "ExtensionManifestError";
    this.code = code;
    this.details = details;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value, known, where) {
  for (const key of Object.keys(value || {})) {
    if (!known.has(key)) {
      throw new ExtensionManifestError("ERR_EXTENSION_FIELD_UNKNOWN", { where, key });
    }
  }
}

function string(value, where) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExtensionManifestError("ERR_EXTENSION_FIELD_INVALID", { where });
  }
  return value.trim();
}

function normalizeId(value) {
  const id = string(value, "id");
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(id)) {
    throw new ExtensionManifestError("ERR_EXTENSION_ID_INVALID", { id });
  }
  return id;
}

function normalizeVersion(value, where) {
  const version = string(value, where);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ExtensionManifestError("ERR_EXTENSION_VERSION_INVALID", { where, version });
  }
  return version;
}

function normalizeCortexCompatibility(input) {
  if (!plain(input)) {
    throw new ExtensionManifestError("ERR_EXTENSION_CORTEX_COMPATIBILITY", {});
  }
  rejectUnknown(input, CORTEX_KEYS, "cortex");
  const protocolName = string(input.protocol, "cortex.protocol");
  if (protocolName !== protocol.EXTENSION_PROTOCOL_NAME) {
    throw new ExtensionManifestError("ERR_EXTENSION_PROTOCOL", {
      expected: protocol.EXTENSION_PROTOCOL_NAME,
      received: protocolName,
    });
  }
  const min = string(input.min_version, "cortex.min_version");
  const max = string(input.max_version_exclusive, "cortex.max_version_exclusive");
  if (!protocol.parseProtocolVersion(min) || !protocol.parseProtocolVersion(max)) {
    throw new ExtensionManifestError("ERR_EXTENSION_PROTOCOL_VERSION", { min, max });
  }
  if (protocol.compareProtocolVersions(min, max) >= 0) {
    throw new ExtensionManifestError("ERR_EXTENSION_COMPATIBILITY_RANGE", { min, max });
  }
  return Object.freeze({
    protocol: protocolName,
    min_version: min,
    max_version_exclusive: max,
  });
}

function isCortexVersionCompatible(compatibility, version = protocol.EXTENSION_PROTOCOL_VERSION) {
  const current = protocol.parseProtocolVersion(version);
  const min = protocol.parseProtocolVersion(compatibility.min_version);
  const max = protocol.parseProtocolVersion(compatibility.max_version_exclusive);
  if (!current || !min || !max) return false;
  return current.major === min.major
    && current.major === max.major - (max.minor === 0 ? 1 : 0)
      ? protocol.compareProtocolVersions(current, min) >= 0
        && protocol.compareProtocolVersions(current, max) < 0
      : protocol.compareProtocolVersions(current, min) >= 0
        && protocol.compareProtocolVersions(current, max) < 0;
}

function normalizeCapabilities(input) {
  if (input == null) input = {};
  if (!plain(input)) {
    throw new ExtensionManifestError("ERR_EXTENSION_CAPABILITIES", {});
  }
  rejectUnknown(input, CAPABILITY_KEYS, "capabilities");
  return Object.freeze({
    provided: protocol.validateCapabilityList(input.provided || []),
    required: protocol.validateCapabilityList(input.required || []),
  });
}

function normalizeEntryPoint(value, key) {
  const entry = string(value, `entry_points.${key}`);
  if (entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry)) {
    throw new ExtensionManifestError("ERR_EXTENSION_ENTRY_POINT_ABSOLUTE", { key, entry });
  }
  const normalized = entry.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new ExtensionManifestError("ERR_EXTENSION_ENTRY_POINT_TRAVERSAL", { key, entry });
  }
  return normalized;
}

function normalizeEntryPoints(input) {
  if (input == null) return Object.freeze({});
  if (!plain(input)) {
    throw new ExtensionManifestError("ERR_EXTENSION_ENTRY_POINTS", {});
  }
  const allowed = new Set(ENTRY_POINT_KEYS);
  rejectUnknown(input, allowed, "entry_points");
  const out = {};
  for (const key of ENTRY_POINT_KEYS) {
    if (input[key] != null) out[key] = normalizeEntryPoint(input[key], key);
  }
  return Object.freeze(out);
}

function normalizeExtensionManifest(input, permissionNormalizer) {
  if (!plain(input)) {
    throw new ExtensionManifestError("ERR_EXTENSION_MANIFEST_INVALID", {});
  }
  rejectUnknown(input, TOP_KEYS, "manifest");

  const schemaVersion = input.schema_version == null
    ? EXTENSION_MANIFEST_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== EXTENSION_MANIFEST_SCHEMA_VERSION) {
    throw new ExtensionManifestError("ERR_EXTENSION_SCHEMA_VERSION", {
      received: schemaVersion,
    });
  }

  const type = string(input.type, "type");
  if (!EXTENSION_TYPES.includes(type)) {
    throw new ExtensionManifestError("ERR_EXTENSION_TYPE_UNKNOWN", { type });
  }

  const compatibility = normalizeCortexCompatibility(input.cortex);
  if (!isCortexVersionCompatible(compatibility)) {
    throw new ExtensionManifestError("ERR_EXTENSION_CORTEX_INCOMPATIBLE", {
      current: protocol.EXTENSION_PROTOCOL_VERSION,
      compatibility,
    });
  }

  if (typeof permissionNormalizer !== "function") {
    throw new ExtensionManifestError("ERR_EXTENSION_PERMISSION_NORMALIZER_REQUIRED", {});
  }

  const configSchema = input.config_schema == null ? null : input.config_schema;
  if (configSchema !== null && !plain(configSchema)) {
    throw new ExtensionManifestError("ERR_EXTENSION_CONFIG_SCHEMA", {});
  }

  return Object.freeze({
    schema_version: EXTENSION_MANIFEST_SCHEMA_VERSION,
    id: normalizeId(input.id),
    version: normalizeVersion(input.version, "version"),
    type,
    cortex: compatibility,
    capabilities: normalizeCapabilities(input.capabilities),
    permissions: permissionNormalizer(input.permissions || {}),
    entry_points: normalizeEntryPoints(input.entry_points),
    config_schema: configSchema === null ? null : Object.freeze({ ...configSchema }),
  });
}

module.exports = {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  EXTENSION_TYPES,
  ENTRY_POINT_KEYS,
  ExtensionManifestError,
  normalizeCortexCompatibility,
  isCortexVersionCompatible,
  normalizeExtensionManifest,
};
