"use strict";

const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

const CAPABILITY_NAMESPACES = Object.freeze([
  "management",
  "tasks",
  "runs",
  "decisions",
  "waitpoints",
  "coordination",
  "topology",
  "runtime",
  "project",
  "extension",
]);

const CAPABILITY_NAMESPACE_SET = new Set(CAPABILITY_NAMESPACES);

function parseCapabilityId(value) {
  if (typeof value !== "string" || !CAPABILITY_ID_PATTERN.test(value)) return null;
  const [namespace, ...segments] = value.split(".");
  if (!CAPABILITY_NAMESPACE_SET.has(namespace)) return null;
  return Object.freeze({
    id: value,
    namespace,
    segments: Object.freeze(segments),
  });
}

function isCapabilityId(value, namespace) {
  const parsed = parseCapabilityId(value);
  if (!parsed) return false;
  return !namespace || parsed.namespace === namespace;
}

function validateCapabilityList(values) {
  if (!Array.isArray(values)) {
    const error = new Error("Capability list must be an array.");
    error.code = "ERR_CAPABILITY_LIST_INVALID";
    throw error;
  }
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    const parsed = parseCapabilityId(value);
    if (!parsed) {
      const error = new Error(`Invalid Cortex capability id: ${value}`);
      error.code = "ERR_CAPABILITY_ID_INVALID";
      error.details = { capability: value };
      throw error;
    }
    if (!seen.has(parsed.id)) {
      seen.add(parsed.id);
      normalized.push(parsed.id);
    }
  }
  return Object.freeze(normalized);
}

module.exports = {
  CAPABILITY_NAMESPACES,
  parseCapabilityId,
  isCapabilityId,
  validateCapabilityList,
};
