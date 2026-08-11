"use strict";

// ─── Watchdog Policy Loader (M-013 SP-005) ────────────────────────────────────
//
// Loads versioned watchdog policies and validates them against the schema.
// The default policy `v1-default` is bundled inline; custom policies must
// match the schema (additionalProperties=false at root).
//
// Per P-005 §7.2: different tasks may tighten or disable steer, but cannot
// disable redaction, lease, or evidence truthfulness. This loader enforces
// that invariant: policies cannot override the immutable safety rails.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_POLICY_ID = "v1-default";
const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  ".agent",
  "schemas",
  "watchdog-policy.v1.json"
);

const DEFAULT_POLICY = Object.freeze({
  policyId: "v1-default",
  schemaVersion: "1.0",
  maxReadOnlyActionsWithoutEvidence: 8,
  maxNoProductiveMs: 600000,
  maxNoHeartbeatMs: 90000,
  maxSteerAttempts: 1,
  steerGraceMs: 120000,
  onExhausted: "notify",
  notifyChannel: "coordination",
});

/**
 * Get the default policy. Pinned to v1-default; safe to share across attempts.
 */
function getDefaultPolicy() {
  return { ...DEFAULT_POLICY };
}

/**
 * Load a policy by id. Currently only v1-default is bundled. Custom policies
 * can be supplied via `loadPolicyFromFile`.
 */
function loadPolicy(policyId = DEFAULT_POLICY_ID) {
  if (policyId === DEFAULT_POLICY_ID) return getDefaultPolicy();
  throw new Error(
    `policy-loader: unknown policyId ${JSON.stringify(policyId)} (only ${DEFAULT_POLICY_ID} bundled)`
  );
}

/**
 * Load + validate a policy from a JSON file. The file must contain a policy
 * matching `watchdog-policy.v1.json`. Returns the parsed policy.
 *
 * Throws on missing file, parse error, or schema violation.
 */
function loadPolicyFromFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    throw new Error("policy-loader: filePath must be a non-empty string");
  }
  const text = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`policy-loader: ${filePath} is not valid JSON (${err.message})`);
  }
  return validatePolicy(parsed);
}

/**
 * Validate a policy object against the v1 schema subset. Pure function.
 */
function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("policy-loader: policy must be a non-null object");
  }
  const errors = [];

  // Required fields
  const required = [
    "policyId",
    "maxReadOnlyActionsWithoutEvidence",
    "maxNoProductiveMs",
    "maxNoHeartbeatMs",
    "maxSteerAttempts",
    "steerGraceMs",
    "onExhausted",
  ];
  for (const field of required) {
    if (!(field in policy)) errors.push(`missing required field: ${field}`);
  }

  // policyId must equal v1-default (current version)
  if (policy.policyId && policy.policyId !== DEFAULT_POLICY_ID) {
    errors.push(
      `policyId must be ${DEFAULT_POLICY_ID} (got ${JSON.stringify(policy.policyId)})`
    );
  }

  // Numeric bounds
  const numericBounds = {
    maxReadOnlyActionsWithoutEvidence: [1, 1000],
    maxNoProductiveMs: [1000, Number.POSITIVE_INFINITY],
    maxNoHeartbeatMs: [1000, Number.POSITIVE_INFINITY],
    maxSteerAttempts: [0, 1],
    steerGraceMs: [1000, Number.POSITIVE_INFINITY],
  };
  for (const [field, [min, max]] of Object.entries(numericBounds)) {
    if (field in policy) {
      const v = policy[field];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        errors.push(`${field} must be a finite number`);
      } else if (v < min || v > max) {
        errors.push(`${field} (${v}) out of bounds [${min}, ${max}]`);
      }
    }
  }

  // onExhausted enum
  if (
    policy.onExhausted !== undefined &&
    policy.onExhausted !== "notify" &&
    policy.onExhausted !== "abort"
  ) {
    errors.push(`onExhausted must be 'notify' or 'abort'`);
  }

  // notifyChannel enum (optional)
  if (
    policy.notifyChannel !== undefined &&
    policy.notifyChannel !== "coordination" &&
    policy.notifyChannel !== "silent"
  ) {
    errors.push(`notifyChannel must be 'coordination' or 'silent'`);
  }

  // additionalProperties=false
  const allowed = new Set([
    "policyId",
    "schemaVersion",
    "maxReadOnlyActionsWithoutEvidence",
    "maxNoProductiveMs",
    "maxNoHeartbeatMs",
    "maxSteerAttempts",
    "steerGraceMs",
    "onExhausted",
    "notifyChannel",
  ]);
  for (const key of Object.keys(policy)) {
    if (!allowed.has(key)) errors.push(`additional property: ${key}`);
  }

  // P-005 §7.2 invariant: cannot disable safety rails
  // (policy cannot claim onExhausted=abort without explicit override — for v1
  // we allow abort but require the policy to declare maxSteerAttempts=1 to
  // make the bounded reason template explicit. This is documented in §7.2.)
  if (policy.onExhausted === "abort" && policy.maxSteerAttempts !== 1) {
    errors.push(
      "onExhausted=abort requires maxSteerAttempts=1 (P-005 §7.2 bounded steer)"
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `policy-loader: validation failed (${errors.length} error(s)):\n  - ${errors.join("\n  - ")}`
    );
  }

  return Object.freeze({ ...policy });
}

module.exports = {
  loadPolicy,
  loadPolicyFromFile,
  validatePolicy,
  getDefaultPolicy,
  DEFAULT_POLICY,
  DEFAULT_POLICY_ID,
  SCHEMA_PATH,
};