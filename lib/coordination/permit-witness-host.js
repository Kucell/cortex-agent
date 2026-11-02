"use strict";

const crypto = require("node:crypto");
const { ProtectedPermitStore, validateReservationInput } = require("./protected-permit-store");
const { openWithLegacyRepair } = require("./permit-store-open-with-repair");
const witness = require("./permit-witness-contract");
const delivery = require("./permit-delivery");

const METHODS = Object.freeze({ register: "registerWitnessTarget", issue: "issueWitnessPermit", consume: "consumeWithCheckpoint" });
const PIN = ["decision_id", "instance_id", "fingerprint", "public_key_pem", "source_digest", "deployment_digest",
  "run_id", "generation", "valid_from", "valid_until"];
const LEASE = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"];
const PERMIT = ["operation", "targetDigest", "paramsDigest"];
const REQUESTS = Object.freeze({ register: ["targetId", "requestId", "checkpoint", "pin"],
  issue: ["targetId", "checkpoint", "lease", "permit", "batchFingerprint"],
  consume: ["targetId", "checkpoint", "message", "signature"] });

function fail(code = "ERR_WITNESS_HOST_INPUT") { throw Object.assign(new Error(code), { code }); }
function exact(value, required, optional = []) {
  if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => ![...required, ...optional].includes(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail();
  }
}
function text(value) { if (typeof value !== "string" || !value) fail(); }
function positive(value) { if (!Number.isSafeInteger(value) || value <= 0) fail(); }

// The optional automatic legacy repair. It is a DECLARATION, not an
// instruction to repair unconditionally:
//
// - `oldReaderSource` names the frozen 1.15.7 reader that fences the old
//   writer. Without it the repair cannot prove that the old writer loses
//   its authority, so it is refused.
// - `audit` names who authorised the repair and why, and it is written into
//   the anchor recovery log.
//
// The repair runs only when the store really is a legacy store, so a
// current store is never touched by this configuration.
function legacyRepairOptions(value, file, anchorDir, openOptions) {
  if (value === undefined || value === null) {
    return Object.freeze({ filePath: file, anchorDir, autoRepair: false });
  }
  exact(value, ["oldReaderSource", "audit"], []);
  text(value.oldReaderSource);
  exact(value.audit, ["by", "reason"], []);
  text(value.audit.by); text(value.audit.reason);
  return Object.freeze({ ...openOptions, filePath: file, anchorDir, autoRepair: true,
    oldReaderSource: value.oldReaderSource, audit: Object.freeze({ by: value.audit.by, reason: value.audit.reason }) });
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function copy(value) { return freeze(JSON.parse(witness.canonicalBytes(value).toString("utf8"))); }
function equal(left, right) { return witness.canonicalBytes(left).equals(witness.canonicalBytes(right)); }
function matches(actual, expected, fields) { return fields.every((field) => actual[field] === expected[field]); }
function outcome(status, commit, code, result) {
  return freeze({ status, commit, mode: "development-only", executionAuthorized: false,
    ...(code ? { code } : {}), ...(result ? { result } : {}) });
}
function historyOutcome(status, code, result) {
  return freeze({ ...outcome(status, "not-applicable", code, result), resumeAllowed: false,
    originalRequestOutcome: "unknown" });
}

// Pure grant validation, shared with managed-host preflight. This neither
// authenticates an identity nor opens a store or writes an anchor.
function validatePermitWitnessAssignment(input, decisionId) {
  exact(input, ["principal", "actions", "resources"]);
  text(input.principal);
  const actions = copy(input.actions), resources = copy(input.resources);
  if (!Array.isArray(actions) || actions.length === 0 || new Set(actions).size !== actions.length ||
      actions.some((action) => !Object.hasOwn(METHODS, action))) fail();
  exact(resources, ["targetId", "pin", "lease", "permit", "maxLeaseTtlMs", "maxPermitTtlMs"]);
  exact(resources.pin, PIN); exact(resources.lease, LEASE); exact(resources.permit, PERMIT);
  text(resources.targetId); Object.values(resources.lease).forEach(text); Object.values(resources.permit).forEach(text);
  if (resources.lease.owner !== input.principal) fail("ERR_WITNESS_HOST_BINDING");
  positive(resources.maxLeaseTtlMs); positive(resources.maxPermitTtlMs);
  const pin = resources.pin;
  if (pin.decision_id !== decisionId || pin.instance_id !== resources.targetId ||
      pin.run_id !== resources.lease.runId || pin.generation !== resources.lease.generation ||
      !/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pin.public_key_pem) || /PRIVATE KEY/.test(pin.public_key_pem) ||
      crypto.createPublicKey(pin.public_key_pem).asymmetricKeyType !== "ed25519" ||
      delivery.publicKeyFingerprint(pin.public_key_pem) !== pin.fingerprint) fail("ERR_WITNESS_HOST_BINDING");
  for (const field of ["source_digest", "deployment_digest"]) text(pin[field]);
  if (!Number.isSafeInteger(pin.valid_from) || !Number.isSafeInteger(pin.valid_until) ||
      pin.valid_from < 0 || pin.valid_until <= pin.valid_from) fail();
  validateReservationInput({ ...resources.permit, idempotencyKey: "validation", ttlMs: resources.maxPermitTtlMs });
  return { actions, resources };
}

// TRUSTED IN-PROCESS COMPOSITION ONLY. Keep the factory, context factories and the
// provider configuration outside request routing. createContext records a host's
// verified identity/resource assignment; it does NOT authenticate that identity.
// isCurrent(identity) must synchronously recheck the host's actual managed session.
// This module adds no listener, cross-machine authentication, production trust
// isolation or permission to execute. In particular its unsigned flags cannot
// isolate the existing 14+3 signatures: never trust these keys in production.
//
// Explicit backend/access are mandatory; open never initializes or upgrades a
// legacy store. Only synchronous, trusted local providers are supported. A
// thenable is refused, not awaited; asynchronous work cannot be cancelled here.
function createPermitWitnessHost(config) {
  exact(config, ["backend", "mode", "access", "file", "authorityId", "storeOptions", "providers"], ["clock", "legacyRepair"]);
  if (config.backend !== "development-witness" || config.mode !== "development-only" ||
      !["initialize", "open"].includes(config.access)) fail("ERR_WITNESS_AUTHORITY_DISABLED");
  text(config.file); text(config.authorityId);
  exact(config.storeOptions, ["decisionId", "anchorDir", "anchorMode"], ["serviceIdentity", "minimumEpoch"]);
  const options = copy(config.storeOptions);
  text(options.decisionId); text(options.anchorDir);
  if (!["strict", "permissive"].includes(options.anchorMode)) fail();
  if (options.serviceIdentity !== undefined) text(options.serviceIdentity);
  if (config.access === "open") positive(options.minimumEpoch);
  if (options.minimumEpoch !== undefined) positive(options.minimumEpoch);
  const clock = config.clock === undefined ? Date.now : config.clock;
  if (typeof clock !== "function") fail();
  exact(config.providers, ["observeTarget", "signPermit", "pullRevocation"]);
  const providers = { ...config.providers };
  if (Object.values(providers).some((provider) => typeof provider !== "function")) fail();
  const authorityId = config.authorityId;
  const contexts = new WeakMap(), historyContexts = new WeakMap();
  let closed = false, blocked = false, historyBlocked = false, active = null;

  function synchronous(value) {
    if (value && typeof value.then === "function") {
      // Observe rejection without ever accepting the eventual result.
      Promise.resolve(value).catch(() => {});
      fail("ERR_WITNESS_HOST_ASYNC_UNSUPPORTED");
    }
    return value;
  }
  function currentIdentity(record) {
    if (closed || record.revoked) return false;
    const verified = synchronous(record.isCurrent(record.identity));
    return verified === true && !closed && !record.revoked;
  }
  function current(record) {
    return !blocked && currentIdentity(record) && !blocked;
  }
  function currentHistory(record) {
    try { if (!historyBlocked && currentIdentity(record)) return true; }
    catch (error) { record.revoked = true; throw error; }
    record.revoked = true;
    return false;
  }
  function bindRequest(record, operation, request, state) {
    const r = record.resources;
    exact(request, REQUESTS[operation]);
    if (request.targetId !== r.targetId) fail("ERR_WITNESS_HOST_BINDING");
    if (request.checkpoint === null) {
      if (operation !== "register") fail("ERR_WITNESS_HOST_BINDING");
    } else {
      exact(request.checkpoint, ["format_version", "authority_id", "target_id", "store_generation", "revision", "full_state_digest"]);
      if (request.checkpoint.authority_id !== authorityId || request.checkpoint.target_id !== r.targetId) fail("ERR_WITNESS_HOST_BINDING");
    }
    if (operation === "register") {
      text(request.requestId);
      if (!equal(request.pin, r.pin)) fail("ERR_WITNESS_HOST_BINDING");
    } else if (operation === "issue") {
      exact(request.lease, [...LEASE, "idempotencyKey", "ttlMs"]);
      exact(request.permit, [...PERMIT, "idempotencyKey", "ttlMs"]);
      positive(request.lease.ttlMs);
      validateReservationInput(request.permit);
      if (!matches(request.lease, r.lease, LEASE) || !matches(request.permit, r.permit, PERMIT) ||
          request.batchFingerprint !== r.pin.fingerprint || request.lease.ttlMs > r.maxLeaseTtlMs ||
          request.permit.ttlMs > r.maxPermitTtlMs) fail("ERR_WITNESS_HOST_BINDING");
    } else {
      exact(request.message, [...delivery.BINDING_FIELD_MAP.map(([, name]) => name), "issued_at_ms", "deadline_ms", "permit_id"]);
      text(request.signature);
      for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
        const expected = Object.hasOwn(r.lease, storage) ? r.lease : r.permit;
        if (Object.hasOwn(expected, storage)) {
          // The store validates and lowercases these digests before signing.
          const value = ["targetDigest", "paramsDigest"].includes(storage) ? expected[storage].toLowerCase() : expected[storage];
          if (request.message[signed] !== value) fail("ERR_WITNESS_HOST_BINDING");
        }
      }
      if (state) {
        const id = request.message.permit_id;
        const binding = Object.hasOwn(state.witness_authority.issuance_bindings, id) && state.witness_authority.issuance_bindings[id];
        const permit = Object.hasOwn(state.permits, id) && state.permits[id];
        if (!binding || !permit || binding.fingerprint !== r.pin.fingerprint || !state.lease ||
            permit.leaseId !== state.lease.leaseId || !matches(state.lease, r.lease, LEASE)) fail("ERR_WITNESS_HOST_BINDING");
      }
    }
  }
  function authorize(context, operation, request, state) {
    const record = contexts.get(context);
    if (!active || active.kind !== "write" || active.context !== context || active.operation !== operation || !record ||
        !record.actions.includes(operation) || !current(record) || !equal(request, active.request) ||
        state.schema_version !== 3 || state.decision_id !== options.decisionId ||
        state.witness_authority.mode !== "development-only" || state.witness_authority.authority_id !== authorityId) return false;
    bindRequest(record, operation, request, state);
    return true;
  }
  function authorizeHistory(context, operation, query) {
    const record = historyContexts.get(context);
    if (!active || active.kind !== "history" || active.context !== context || !record ||
        operation !== "history." + record.query.operation || !equal(query, record.query) || !currentHistory(record)) return false;
    return { principal: record.principal, resources: record.query };
  }
  function provider(name) {
    return (...args) => {
      if (!active || active.kind !== "write" || !current(active.record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      const result = copy(synchronous(providers[name](...args)));
      if (!current(active.record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      return result;
    };
  }
  const storeConfig = { ...options, clock, witnessAuthority: { mode: "development-only", authorityId, authorize, authorizeHistory,
    observeTarget: provider("observeTarget"), signPermit: provider("signPermit"), pullRevocation: provider("pullRevocation") } };
  const store = config.access === "initialize"
    ? ProtectedPermitStore.initialize(config.file, storeConfig)
    : openWithLegacyRepair(() => ProtectedPermitStore.open(config.file, { ...storeConfig, expectedDecisionId: options.decisionId }),
      legacyRepairOptions(config.legacyRepair, config.file, options.anchorDir,
        { ...storeConfig, expectedDecisionId: options.decisionId })).store;

  function createContext(input) {
    if (closed || blocked || active) fail("ERR_WITNESS_HOST_UNAVAILABLE");
    exact(input, ["identity", "principal", "actions", "resources", "isCurrent"]);
    const { identity, isCurrent } = input;
    if (!identity || typeof identity !== "object" || typeof isCurrent !== "function") fail();
    const { actions, resources } = validatePermitWitnessAssignment({ principal: input.principal,
      actions: input.actions, resources: input.resources }, options.decisionId);
    const record = { identity, principal: input.principal, actions, resources, isCurrent, revoked: false };
    if (!current(record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
    const context = Object.freeze(Object.create(null));
    contexts.set(context, record);
    return context;
  }

  // Trusted host assignment, never request-controlled authorization. One context
  // grants exactly one detached query; the reviewer is not the old lease owner.
  function createHistoryContext(input) {
    if (closed || historyBlocked || active) fail("ERR_WITNESS_HOST_UNAVAILABLE");
    exact(input, ["identity", "principal", "query", "isCurrent"]);
    const { identity, principal, isCurrent } = input;
    if (!identity || typeof identity !== "object" || typeof isCurrent !== "function") fail();
    text(principal);
    const query = copy(input.query);
    exact(query, ["operation", "decisionId", "authorityId", "issuerStoreId", "targetGeneration", "resources", "request"]);
    if (!Object.hasOwn(REQUESTS, query.operation) || query.decisionId !== options.decisionId || query.authorityId !== authorityId) fail();
    text(query.issuerStoreId);
    if (query.targetGeneration !== null) text(query.targetGeneration);
    exact(query.resources, ["fingerprint", "lease", "permit"]);
    if (typeof query.resources.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(query.resources.fingerprint)) fail();
    exact(query.request, REQUESTS[query.operation]); text(query.request.targetId);
    if (query.operation === "register") {
      if (query.resources.lease !== null || query.resources.permit !== null) fail();
      exact(query.request.pin, PIN);
    } else {
      exact(query.resources.lease, LEASE); Object.values(query.resources.lease).forEach(text);
      exact(query.resources.permit, PERMIT); Object.values(query.resources.permit).forEach(text);
      if (query.operation === "issue") {
        exact(query.request.lease, [...LEASE, "idempotencyKey", "ttlMs"]);
        exact(query.request.permit, [...PERMIT, "idempotencyKey", "ttlMs"]);
      } else {
        exact(query.request.message, [...delivery.BINDING_FIELD_MAP.map(([, name]) => name), "issued_at_ms", "deadline_ms", "permit_id"]);
        text(query.request.signature);
      }
    }
    const record = { identity, principal, query, isCurrent, revoked: false };
    active = { kind: "history" };
    try {
      if (!currentHistory(record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      const context = Object.freeze(Object.create(null));
      historyContexts.set(context, record);
      return context;
    } finally { active = null; }
  }

  function queryHistory(context, input) {
    if (closed || historyBlocked || active) return historyOutcome("unavailable", "ERR_WITNESS_HOST_UNAVAILABLE");
    let entered = false;
    active = { kind: "history", context };
    try {
      const record = historyContexts.get(context), query = copy(input);
      if (!record || !equal(query, record.query) || !currentHistory(record)) fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
      entered = true;
      const result = copy(synchronous(store.queryWitnessHistory(context, query)));
      if (!currentHistory(record) || result.mode !== "development-only" || result.executionAuthorized !== false ||
          result.resumeAllowed !== false || result.originalRequestOutcome !== "unknown" ||
          !["found", "not-found-at-boundary"].includes(result.status)) fail("ERR_WITNESS_HISTORY_NOT_AUTHORIZED");
      return historyOutcome("observed", null, result);
    } catch {
      if (!entered) return historyOutcome("rejected", "ERR_WITNESS_HOST_HISTORY_REJECTED");
      // Never reopen a poisoned store, infer rollback, or clear the write latch.
      blocked = true; historyBlocked = true;
      return historyOutcome("unknown", "ERR_WITNESS_HISTORY_OBSERVATION_UNKNOWN");
    } finally { active = null; }
  }

  function dispatch(context, operation, input) {
    let record, request;
    try {
      if (closed || blocked || active) fail("ERR_WITNESS_HOST_UNAVAILABLE");
      record = contexts.get(context);
      if (!record || !Object.hasOwn(METHODS, operation) || !record.actions.includes(operation)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      request = copy(input);
      bindRequest(record, operation, request);
      if (!current(record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
    } catch {
      return outcome("rejected", "not-attempted", "ERR_WITNESS_HOST_REQUEST_REJECTED");
    }
    active = { kind: "write", context, record, operation, request };
    try {
      const result = copy(synchronous(store[METHODS[operation]](context, request)));
      if (!current(record) || result.executionAuthorized !== false) fail("ERR_WITNESS_NOT_AUTHORIZED");
      return outcome("committed", "confirmed", null, result);
    } catch {
      // Core errors may follow safety-state commits or a DB commit whose anchor
      // completion failed. No code-based rollback guess, snapshot inference,
      // automatic retry, recovery or legacy fallback is safe here. Halt this
      // host; an explicit host-owned reopen/recovery must establish what happened.
      blocked = true;
      return outcome("unknown", "unknown", "ERR_WITNESS_TRANSACTION_OUTCOME_UNKNOWN");
    } finally { active = null; }
  }

  return Object.freeze({ createContext, dispatch, createHistoryContext, queryHistory,
    revokeContext(context) {
      const record = contexts.get(context) || historyContexts.get(context);
      if (record) record.revoked = true;
    },
    close() {
      if (active) fail("ERR_WITNESS_HOST_UNAVAILABLE");
      closed = true;
      store.close();
    } });
}

module.exports = { createPermitWitnessHost, validatePermitWitnessAssignment };
