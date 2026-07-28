"use strict";

const path = require("node:path");

const REPORTING_MODES = Object.freeze({
  HOOK: "hook",
  EXPLICIT_CLI: "explicit_cli",
});

const DELIVERY_RESULTS = Object.freeze({
  DELIVERED: "delivered",
  DEFERRED: "deferred",
  SKIPPED: "skipped",
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERN = /(?:token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]/i;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'`])\/(?:Users|home|var|tmp|private|opt|etc)\//;
const WINDOWS_ABSOLUTE_PATH = /(^|[\s"'`])[A-Za-z]:[\\/]/;
const IPV4_ADDRESS = /(^|[^0-9])(?:\d{1,3}\.){3}\d{1,3}([^0-9]|$)/;

function assertSafeId(value, field) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(`${field} must be a stable identifier`);
  }
  return value;
}

function assertSafeText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
    throw new TypeError(`${field} must be a non-empty bounded string`);
  }
  if (SECRET_PATTERN.test(value) || POSIX_ABSOLUTE_PATH.test(value)
      || WINDOWS_ABSOLUTE_PATH.test(value) || IPV4_ADDRESS.test(value)) {
    throw new TypeError(`${field} contains private runtime data`);
  }
  return value;
}

function assertRepoRelative(value, field) {
  assertSafeText(value, field);
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".."
      || normalized.startsWith("../")) {
    throw new TypeError(`${field} must be repository-relative`);
  }
  return normalized;
}

function normalizeStringList(values, field, validator = assertSafeText) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${field} must be an array`);
  }
  return Object.freeze(values.map((value, index) =>
    validator(value, `${field}[${index}]`)));
}

function createAdapterDescriptor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("adapter descriptor must be an object");
  }
  const capabilities = {};
  for (const [name, enabled] of Object.entries(input.capabilities || {})) {
    assertSafeId(name, "capability");
    if (typeof enabled !== "boolean") {
      throw new TypeError(`capability ${name} must be boolean`);
    }
    capabilities[name] = enabled;
  }
  return Object.freeze({
    adapterId: assertSafeId(input.adapterId, "adapterId"),
    vendor: assertSafeId(input.vendor, "vendor"),
    capabilities: Object.freeze(capabilities),
  });
}

function hasCapability(descriptor, capability) {
  return descriptor.capabilities[capability] === true;
}

function sanitizeEvidenceRefs(evidenceRefs = []) {
  if (!Array.isArray(evidenceRefs)) {
    throw new TypeError("evidenceRefs must be an array");
  }
  return Object.freeze(evidenceRefs.map((ref, index) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      throw new TypeError(`evidenceRefs[${index}] must be an object`);
    }
    return Object.freeze({
      kind: assertSafeId(ref.kind, `evidenceRefs[${index}].kind`),
      ref: assertSafeText(ref.ref, `evidenceRefs[${index}].ref`),
    });
  }));
}

module.exports = {
  DELIVERY_RESULTS,
  REPORTING_MODES,
  assertRepoRelative,
  assertSafeId,
  assertSafeText,
  createAdapterDescriptor,
  hasCapability,
  normalizeStringList,
  sanitizeEvidenceRefs,
};
