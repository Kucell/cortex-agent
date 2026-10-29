"use strict";

// Opt-in READ-ONLY preflight over a bound local FilesystemGovernanceStore.
// A match is NOT authorization. No Host/lease/Operation is created and no
// record is written. The legacy manual dispatcher is deliberately unchanged.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { resolveGovernanceRoot } = require("../governance/root");
const { createFilesystemGovernanceStore, createFilesystemRevision } = require("../governance/store");
const { resolveRuntimePaths } = require("../runtime-layout");
const decisionSchema = require("../../templates/_shared/.agent/decisions/decision.schema.json");
const waitpointSchema = require("../../templates/_shared/.agent/waitpoints/waitpoint.schema.json");

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function iso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function result(status, code, extra = {}) {
  return Object.freeze({ status, code, execution_authorized: false, effect_permitted: false, ...extra });
}

// Evaluates the keywords used by the two bundled closed schemas. Timestamp
// inputs are intentionally restricted to the canonical UTC form emitted by
// Management API. Do not use this small evaluator as a general schema library.
function supportedSchema(schema) {
  if (!object(schema)) return false;
  const keys = ["$schema", "title", "description", "type", "const", "enum", "minLength", "pattern", "format",
    "minItems", "uniqueItems", "items", "required", "properties", "additionalProperties", "allOf", "if", "then"];
  if (Object.keys(schema).some((key) => !keys.includes(key))) return false;
  if (schema.$schema !== undefined && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") return false;
  if (schema.format !== undefined && schema.format !== "date-time") return false;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false;
  for (const key of ["items", "if", "then"]) if (schema[key] !== undefined && !supportedSchema(schema[key])) return false;
  if (schema.allOf && !schema.allOf.every(supportedSchema)) return false;
  return !schema.properties || Object.values(schema.properties).every(supportedSchema);
}
function matches(schema, value) {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) return false;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (typeof value === "string") {
    if (schema.minLength && value.length < schema.minLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "date-time" && iso(value) === null) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) return false;
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every((v) => matches(schema.items, v))) return false;
  }
  if (object(value)) {
    if (schema.required && !schema.required.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schema.additionalProperties === false
      && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(schema.properties || {}, key))) return false;
    for (const [key, rule] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key) && !matches(rule, value[key])) return false;
    }
  }
  if (schema.allOf && !schema.allOf.every((rule) => matches(rule, value))) return false;
  if (schema.if && matches(schema.if, value) && schema.then && !matches(schema.then, value)) return false;
  return true;
}

function readBoundedBytes(file) {
  const limit = 1024 * 1024;
  if (![fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK].every((flag) => Number.isInteger(flag) && flag > 0)) fail("ERR_STRICT_PLATFORM");
  const stable = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
  let fd, observed = false;
  try {
    const leaf = fs.lstatSync(file);
    observed = true;
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1 || leaf.size > limit) fail("ERR_STRICT_SOURCE_UNSAFE");
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || !stable(leaf, before)) fail("ERR_STRICT_SOURCE_CHANGED");
    // Bound allocation and total reads even if a cooperative writer grows the file.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (length > limit || length !== before.size || !after.isFile() || !current.isFile()
      || current.isSymbolicLink() || !stable(before, after) || !stable(after, current)) fail("ERR_STRICT_SOURCE_CHANGED");
    const bytes = buffer.subarray(0, length);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) fail("ERR_STRICT_SOURCE_UTF8");
    return bytes;
  } catch (error) {
    if (observed && error.code === "ENOENT") fail("ERR_STRICT_SOURCE_CHANGED");
    if (error.code === "ELOOP") fail("ERR_STRICT_SOURCE_UNSAFE");
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function checkedRead(file, missingCode, optional = false) {
  try {
    const bytes = readBoundedBytes(file);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch (_) { fail("ERR_STRICT_SOURCE_JSON"); }
    return { value, revision: createFilesystemRevision(bytes) };
  } catch (error) {
    if (error.code === "ENOENT") { if (optional) return null; fail(missingCode); }
    throw error;
  }
}
function readPair(store, args) {
  // The leaf is opened O_NOFOLLOW and read through the same descriptor.
  // Parent directories remain trusted local materialization: this is not a
  // hostile-filesystem or cross-process atomic authority/effect-sink proof.
  for (const directory of ["decisions", "waitpoints"]) {
    const dir = store.resolve(directory);
    let stat;
    try { stat = fs.lstatSync(dir); } catch (_) { fail("ERR_STRICT_PAIR_MISSING"); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) fail("ERR_STRICT_SOURCE_UNSAFE");
  }
  const d = checkedRead(store.resolve("decisions/" + args.decisionId + ".json"), "ERR_STRICT_PAIR_MISSING");
  const w = checkedRead(store.resolve("waitpoints/" + args.waitpointId + ".json"), "ERR_STRICT_PAIR_MISSING");
  return { d, w };
}
function fingerprint(pair, binding) {
  return hash([binding.project_root, binding.agent_root, pair.d.revision, pair.w.revision]);
}

// Subordinate schema/pair validation only; input objects are not authority.
function validateStrictPairRecords(d, w, args) {
  if (!supportedSchema(decisionSchema) || !supportedSchema(waitpointSchema)) fail("ERR_STRICT_SCHEMA_UNSUPPORTED");
  if (!matches(decisionSchema, d) || !matches(waitpointSchema, w)) fail("ERR_STRICT_SCHEMA_INVALID");
  if (d.decision_id !== args.decisionId || w.waitpoint_id !== args.waitpointId) fail("ERR_STRICT_RECORD_ID");
  if (d.type !== "approval" || d.status !== "approved" || d.selected_option !== "approve"
    || !d.options.includes("approve") || d.superseded_by_decision_id != null) fail("ERR_STRICT_DECISION_NOT_APPROVED");
  if (w.status !== "released" || w.decision_id !== d.decision_id) fail("ERR_STRICT_WAITPOINT_NOT_RELEASED");
  if (w.owner_workflow !== args.ownerWorkflow) fail("ERR_STRICT_OWNER_WORKFLOW_MISMATCH");
  if (d.gate.action !== "external_side_effect" || d.gate.resource_ref !== (args.resourceRef || "task:" + args.taskId)
    || w.gate.action !== d.gate.action || w.gate.resource_ref !== d.gate.resource_ref
    || !d.relations.task_ids.includes(args.taskId) || !w.relations.task_ids.includes(args.taskId)) fail("ERR_STRICT_SCOPE_MISMATCH");
  const now = Date.now();
  const resolved = iso(d.resolved_at);
  const released = iso(w.released_at);
  const expiry = iso(w.expires_at);
  if (resolved === null || released === null || released < resolved || released > now) fail("ERR_STRICT_RELEASE_PROVENANCE");
  // The opt-in path requires a finite Waitpoint deadline; no new Decision
  // fields are invented. L3 Authorization validity remains a separate gate.
  if (expiry === null || expiry <= now) fail("ERR_STRICT_WAITPOINT_EXPIRED");

  return true;
}

function prepareStrictDispatch(args = {}) {
  if (!object(args) || args.enabled !== true) return result("DISABLED", "STRICT_DISPATCH_DISABLED");
  try {
    const fields = ["enabled", "projectRoot", "taskId", "decisionId", "waitpointId", "ownerWorkflow", "hostRef", "idempotencyKey"];
    if (Object.keys(args).some((key) => !fields.includes(key))) fail("ERR_STRICT_INPUT_UNKNOWN");
    if (typeof args.projectRoot !== "string" || !path.isAbsolute(args.projectRoot)) fail("ERR_STRICT_PROJECT_REQUIRED");
    for (const [key, prefix] of [["taskId", "T"], ["decisionId", "D"], ["waitpointId", "WP"]]) {
      if (typeof args[key] !== "string" || !new RegExp("^" + prefix + "-[A-Za-z0-9][A-Za-z0-9._-]*$").test(args[key])) fail("ERR_STRICT_ID_INVALID");
    }
    if (!/^\/[A-Za-z0-9][A-Za-z0-9-]*$/.test(args.ownerWorkflow || "")) fail("ERR_STRICT_OWNER_WORKFLOW_REQUIRED");
    if (!/^host:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.hostRef || "")) fail("ERR_STRICT_HOST_REF_REQUIRED");
    if (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(args.idempotencyKey)) fail("ERR_STRICT_IDEMPOTENCY_KEY");

    const binding = resolveGovernanceRoot(args.projectRoot);
    const store = createFilesystemGovernanceStore(binding.agent_root);
    const pair = readPair(store, args);
    const d = pair.d.value;
    const w = pair.w.value;
    validateStrictPairRecords(d, w, args);

    const paths = resolveRuntimePaths(binding.project_root);
    const dispatchRoot = paths.legacyExists && !paths.activated ? paths.dispatch.legacy : paths.dispatch.new;
    const cache = checkedRead(path.join(dispatchRoot, "idempotency", args.idempotencyKey + ".json"),
      "ERR_STRICT_CACHE_MISSING", true);
    // Fresh pair read occurs before interpreting or returning any cache state.
    const latest = readPair(store, args);
    validateStrictPairRecords(latest.d.value, latest.w.value, args);
    const latestBinding = resolveGovernanceRoot(args.projectRoot);
    if (fingerprint(latest, latestBinding) !== fingerprint(pair, binding)) fail("ERR_STRICT_SOURCE_CHANGED");
    // Local binding prevents copied caches from matching another materialization.
    // Canonical paths are not a stable cross-host ProjectIdentity.
    const requestDigest = hash([binding.project_root, binding.agent_root, args.taskId, args.hostRef,
      args.ownerWorkflow, args.decisionId, args.waitpointId]);
    if (cache) {
      const c = cache.value;
      if (!object(c) || c.schema_version !== 1 || c.idempotency_key !== args.idempotencyKey
        || c.task_id !== args.taskId || c.request_digest !== requestDigest
        || c.status !== "accepted" || !object(c.execution)
        || c.execution.decision_id !== args.decisionId || c.execution.waitpoint_id !== args.waitpointId
        || c.execution.approval_digest !== fingerprint(pair, binding)
        || iso(c.expires_at) === null || iso(c.expires_at) <= Date.now()) fail("ERR_STRICT_CACHE_UNUSABLE");
    }
    return result("DEFERRED", "STRICT_RUNTIME_GATES_REQUIRED", {
      preflight_matched: true,
      source: Object.freeze({ kind: "bound_local_filesystem", decision_revision: pair.d.revision, waitpoint_revision: pair.w.revision }),
      cache_state: cache ? "matched_non_authoritative_record" : "absent",
      pending_gates: Object.freeze(["project_identity_and_scope_artifact", "current_owner_authentication",
        "atomic_authority_fence_at_sink", "live_runtime_and_budget", "independent_review"]),
    });
  } catch (error) {
    return result("BLOCKED", /^ERR_/.test(error.code || "") ? error.code : "ERR_STRICT_SOURCE_UNREADABLE");
  }
}

module.exports = Object.freeze({ prepareStrictDispatch, validateStrictPairRecords });
