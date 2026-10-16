"use strict";

// Controller composition seam only. No default resolver, authority provider,
// environment/CLI flag, project hook, or global registration is installed here.
// Supplying functions does not authenticate their source: ONLY a protected,
// independently approved controller may construct the production facade.
// Existing raw CLI/service exports remain legacy entry points outside this
// facade. This module is not a non-bypassable ingress, Owner verifier, lease
// implementation, atomic sink fence, or a claim that L3 is supported.
//
// withAuthorization is a trusted backend-owned scope, not a permit parser.
// It must freshly verify canonical Decision, independently released owning
// Waitpoint, scope, current Owner, lease/fence, budget and expiry, then await
// run() inside its authorized scope. It owns physical sink atomicity/rechecks.
// Returning true, evidence JSON, or a fabricated receipt never runs anything.
// After run starts, a backend/continuation error may leave an UNKNOWN outcome;
// it never proves zero effects and must not trigger blind retry. The trusted
// backend owns canonical outcome reconciliation before a new attempt.

const path = require("node:path");

const ENTRY_OPERATIONS = Object.freeze([
  "dispatch.execute",
  "agent.dispatch-execute",
  "agent.dispatch-protocol",
  "coordination.open",
  "coordination.submit",
  "coordination.reconcile",
  "coordination.lease",
  "coordination.ack",
  "management.invoke",
  "management.query",
]);
const OPERATIONS = new Set(ENTRY_OPERATIONS);
const MAX_AGE_MS = 60_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

class StrictEntryError extends Error {
  constructor(code) {
    super(code);
    this.name = "StrictEntryError";
    this.code = code;
  }
}
function fail(code) { throw new StrictEntryError(code); }
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(value, names, code) {
  if (!object(value) || Object.keys(value).length !== names.length
      || names.some((name) => !Object.prototype.hasOwnProperty.call(value, name))) fail(code);
}
function string(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && value.trim() === value && !/[\x00-\x1f]/.test(value);
}
function absolute(value) {
  return string(value) && path.isAbsolute(value) && path.resolve(value) === value;
}
function epoch(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : NaN;
}
function revision(value) {
  fields(value, ["store_kind", "value"], "ERR_STRICT_BINDING_INVALID");
  if (typeof value.value !== "string") fail("ERR_STRICT_BINDING_INVALID");
  if (value.store_kind === "git" && /^[a-f0-9]{40}$/.test(value.value)) return;
  if (value.store_kind === "filesystem" && DIGEST.test(value.value)) return;
  fail("ERR_STRICT_BINDING_INVALID");
}

// Immutable JSON snapshots prevent callers changing payload/scope while a
// resolver or backend is awaiting IO. Accessors and class instances are not
// input data; no project-supplied toJSON method is invoked.
function snapshot(value) {
  let count = 0;
  const ancestors = new Set();
  function copy(item, depth) {
    if (++count > 4096 || depth > 20) fail("ERR_STRICT_INPUT_INVALID");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) fail("ERR_STRICT_INPUT_INVALID");
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("ERR_STRICT_INPUT_INVALID");
    ancestors.add(item);
    const result = Array.isArray(item) ? [] : Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item) && (Object.keys(descriptors).length !== item.length + 1
        || Object.keys(descriptors).some((key) => key !== "length"
          && !/^(?:0|[1-9][0-9]*)$/.test(key)))) fail("ERR_STRICT_INPUT_INVALID");
    for (const key of Object.keys(descriptors).sort()) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")
          || key === "__proto__" || key === "constructor" || key === "prototype") fail("ERR_STRICT_INPUT_INVALID");
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && result.length !== item.length) fail("ERR_STRICT_INPUT_INVALID");
    ancestors.delete(item);
    return Object.freeze(result);
  }
  const result = copy(value, 0);
  if (JSON.stringify(result).length > 1024 * 1024) fail("ERR_STRICT_INPUT_INVALID");
  return result;
}

function requestSnapshot(input) {
  const request = snapshot(input);
  fields(request, ["project_root", "project_id", "resource_ref", "resource_digest",
    "operation_id", "expected_revision", "payload"], "ERR_STRICT_REQUEST_INVALID");
  if (!absolute(request.project_root) || !string(request.project_id)
      || !string(request.resource_ref) || !string(request.operation_id)
      || typeof request.resource_digest !== "string" || !DIGEST.test(request.resource_digest)) fail("ERR_STRICT_REQUEST_INVALID");
  revision(request.expected_revision);
  return request;
}
function bindingSnapshot(input, request, now) {
  const binding = snapshot(input);
  fields(binding, ["schema_version", "domain", "project_identity", "project_root",
    "backend", "revision", "resource_ref", "resource_digest", "observed_at",
    "expires_at"], "ERR_STRICT_BINDING_UNRESOLVED");
  if (binding.schema_version !== 1 || !["manual", "strict"].includes(binding.domain)) fail("ERR_STRICT_BINDING_UNRESOLVED");
  fields(binding.project_identity, ["kind", "value"], "ERR_STRICT_BINDING_INVALID");
  if (binding.project_identity.kind !== "project_id"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.project_identity.value || "")) fail("ERR_STRICT_BINDING_INVALID");
  fields(binding.backend, ["kind", "locator", "ref"], "ERR_STRICT_BINDING_INVALID");
  if (!["filesystem", "git"].includes(binding.backend.kind) || !string(binding.backend.locator)
      || (binding.backend.ref !== null && !string(binding.backend.ref))
      || (binding.backend.kind === "git" && !string(binding.backend.ref))) fail("ERR_STRICT_BINDING_INVALID");
  revision(binding.revision);
  if (binding.revision.store_kind !== binding.backend.kind
      || !absolute(binding.project_root)
      || binding.project_root !== request.project_root
      || binding.project_identity.value !== request.project_id
      || binding.resource_ref !== request.resource_ref
      || binding.resource_digest !== request.resource_digest
      || JSON.stringify(binding.revision) !== JSON.stringify(request.expected_revision)) fail("ERR_STRICT_BINDING_MISMATCH");
  const observed = epoch(binding.observed_at), expires = epoch(binding.expires_at);
  if (!Number.isSafeInteger(now) || !Number.isFinite(observed) || !Number.isFinite(expires)
      || observed > now || now - observed > MAX_AGE_MS || expires <= now || expires <= observed) fail("ERR_STRICT_BINDING_STALE");
  return binding;
}
function bindingKey(binding) {
  const { observed_at, expires_at, ...identity } = binding;
  return JSON.stringify(identity);
}

function createStrictDomainBoundary({ resolveBinding, withAuthorization, now = Date.now } = {}) {
  if (typeof resolveBinding !== "function" || typeof withAuthorization !== "function"
      || typeof now !== "function") fail("ERR_STRICT_CONTROLLER_REQUIRED");

  async function readBinding(request) {
    let value;
    try { value = await resolveBinding(request); }
    catch (_) { fail("ERR_STRICT_BINDING_UNREADABLE"); }
    return bindingSnapshot(value, request, now());
  }

  function bind(operation, continuation) {
    if (!OPERATIONS.has(operation) || typeof continuation !== "function") fail("ERR_STRICT_ENTRY_INVALID");
    return async function enter(input) {
      const request = requestSnapshot(input);
      const binding = await readBinding(request);
      const context = Object.freeze({ operation, request, binding });
      if (binding.domain === "manual") {
        // Positive canonical classification only. Missing/unknown is never
        // interpreted as manual and caller L3 flags are not part of the API.
        return continuation(request, context);
      }

      let active = true, called = false, execution;
      const run = () => {
        if (!active || called) fail("ERR_STRICT_CONTINUATION_CLOSED");
        called = true;
        execution = (async () => {
          const latest = await readBinding(request);
          if (!active) fail("ERR_STRICT_CONTINUATION_CLOSED");
          if (bindingKey(latest) !== bindingKey(binding)) fail("ERR_STRICT_BINDING_CHANGED");
          return continuation(request, context);
        })();
        // A backend may throw without awaiting its continuation. Do not leak
        // an unhandled rejection. The outer invocation rejects; once run starts,
        // rejection does not establish zero effects.
        execution.catch(() => {});
        return execution;
      };
      try {
        await withAuthorization(context, run);
        active = false;
        if (!called) fail("ERR_STRICT_AUTHORIZATION_NOT_RUN");
        // Backend return values cannot substitute for an actual continuation
        // or override its result (including a cached success result).
        return await execution;
      } finally {
        active = false;
      }
    };
  }
  return Object.freeze({ bind });
}

module.exports = Object.freeze({
  createStrictDomainBoundary,
  StrictEntryError,
  ENTRY_OPERATIONS,
});
