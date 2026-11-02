"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ProtectedPermitStore } = require("./protected-permit-store");
const { canonicalBytes } = require("./permit-witness-contract");

const FIELDS = ["requestKey", "action", "resourceScope", "businessKey", "request"];
const PERMISSIONS = ["request.admit", "request.lookup"];
const publicErrors = new WeakMap(), diagnosticCapabilities = new WeakMap();
function fixedError(code) {
  const error = Object.assign(new Error(code), { code });
  publicErrors.set(error, code);
  return error;
}
function fail(code = "ERR_WITNESS_ADMISSION_HOST_INPUT") { throw fixedError(code); }
// Opt-in trusted local capability. Raw faults never appear on the public error,
// including non-enumerable properties/cause/inspect. Do not expose this reader
// to request routing or default logging; retaining it retains raw faults.
function createPermitWitnessAdmissionDiagnostics() {
  const faults = new WeakMap();
  const capability = Object.freeze({ read: error => faults.get(error) });
  diagnosticCapabilities.set(capability, faults);
  return capability;
}
function publicFailure(primary, fallback, diagnostics, cleanup, cleanupFailed = false) {
  // Only locally minted codes are authoritative; do not inspect caller errors
  // (even their code/stack getters may throw or execute untrusted code).
  const error = fixedError(publicErrors.get(primary) || fallback);
  if (diagnostics) diagnostics.set(error, Object.freeze({ primary, cleanup, cleanupFailed }));
  return error;
}
function exact(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => ![...required, ...optional].includes(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail();
  }
}
function text(value) { if (typeof value !== "string" || !value) fail(); }
function positive(value) { if (!Number.isSafeInteger(value) || value <= 0) fail(); }
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function copy(value) { return freeze(JSON.parse(canonicalBytes(value).toString("utf8"))); }
function envelope(value) {
  const result = copy(value);
  exact(result, FIELDS);
  FIELDS.slice(0, 4).forEach(key => text(result[key]));
  if (!result.request || Array.isArray(result.request) || typeof result.request !== "object") fail();
  return result;
}
function synchronous(value) {
  if (value && typeof value.then === "function") {
    Promise.resolve(value).catch(() => {});
    fail("ERR_WITNESS_ADMISSION_HOST_ASYNC");
  }
  return value;
}
function outcome(status, commit, code, result) {
  return freeze({ status, commit, mode: "development-only", remoteAuthenticated: false,
    productionReady: false, publishable: false, executionAuthorized: false, resumeAllowed: false,
    autoRetryAllowed: false, originalRequestOutcome: "unknown",
    ...(code ? { code } : {}), ...(result ? { result } : {}) });
}

// R5 development/test composition ONLY, over an already trusted, provisioned
// SQLite schema and the store's existing local anchor protocol. This is NOT
// remote authentication, a hostile-schema validator, OS isolation, a durable
// grant registry, a publication certificate or rollback-domain separation.
// Production, signatures, registration, issue, consume, effects and recovery
// are CLOSED. No listener, peer parser, provider injection or legacy fallback.
//
// Keep this factory, createContext and its arguments in the TRUSTED composition
// root, outside request routing. That root derives the stable principal and
// canonical resource/business identities independently (including alias policy).
// Each context grants ONE complete envelope, not just an association key.
// identity is an opaque local session object; incarnation prevents session ABA.
// isCurrent(identity, binding) must be a synchronous, bounded, local check of
// that exact session/incarnation AND the frozen principal/grant/assignment.
// A frozen grant is metadata, never authentication or a cross-session bearer.
// This adapter cannot verify the composition root's assertions or bound its
// callback's work. It neither implements R5's remote service nor enables it.
function createPermitWitnessAdmissionHost(config) {
  exact(config, ["backend", "mode", "access", "file", "authorityId", "storeOptions"], ["clock", "diagnostics"]);
  const diagnostics = diagnosticCapabilities.get(config.diagnostics);
  if (config.diagnostics !== undefined && !diagnostics) fail();
  if (config.backend !== "development-witness" || config.mode !== "development-only" ||
      !["initialize", "open"].includes(config.access)) fail("ERR_WITNESS_AUTHORITY_DISABLED");
  text(config.file); text(config.authorityId);
  exact(config.storeOptions, ["decisionId", "anchorDir", "anchorMode"], ["serviceIdentity", "minimumEpoch"]);
  const options = copy(config.storeOptions), authorityId = config.authorityId;
  text(options.decisionId); text(options.anchorDir);
  if (!["strict", "permissive"].includes(options.anchorMode)) fail();
  if (options.serviceIdentity !== undefined) text(options.serviceIdentity);
  if (config.access === "open" || options.minimumEpoch !== undefined) positive(options.minimumEpoch);
  const clock = config.clock === undefined ? Date.now : config.clock;
  if (typeof clock !== "function") fail();
  const contexts = new WeakMap();
  let active = null, blocked = false, closed = false;
  let storage = [];

  function storageIdentity(file, directory) {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) fail();
    return `${stat.dev}:${stat.ino}`;
  }
  function sameStorage() {
    // Detect path replacement at checks; this is NOT an OS exclusion primitive
    // or proof against hostile concurrent filesystem/schema mutation.
    return storage.every(item => storageIdentity(item.file, item.directory) === item.identity);
  }

  function current(record) {
    if (closed || blocked || record.revoked) return false;
    try {
      if (!sameStorage()) fail("ERR_WITNESS_ADMISSION_HOST_STORAGE_CHANGED");
      if (synchronous(record.isCurrent(record.identity, record.binding)) === true &&
          !closed && !blocked && !record.revoked && sameStorage()) return true;
    } catch (error) { record.revoked = true; throw error; }
    record.revoked = true;
    return false;
  }
  function authorize(context, operation, request, state) {
    const record = contexts.get(context);
    if (!record || !active || active.context !== context || active.record !== record ||
        active.operation !== operation || !record.permissions.includes(operation) ||
        state.schema_version !== 4 || state.decision_id !== options.decisionId ||
        state.witness_authority.mode !== "development-only" || state.witness_authority.authority_id !== authorityId) return false;
    // Revalidate the WHOLE canonical envelope even for lookup / existing keys.
    const bytes = canonicalBytes(envelope(request)).toString("utf8");
    if (bytes !== record.bytes || bytes !== active.bytes || !current(record)) return false;
    return { principal: record.binding.principal, grant: record.binding.grant, resources: record.binding.resources };
  }
  function disabled() { fail("ERR_WITNESS_ADMISSION_ONLY"); }
  const storeOptions = { ...options, clock, witnessAuthority: { mode: "development-only",
    admissionMode: "development-only", authorityId, authorize,
    observeTarget: disabled, signPermit: disabled, pullRevocation: disabled } };
  const store = config.access === "initialize"
    ? ProtectedPermitStore.initialize(config.file, storeOptions)
    : ProtectedPermitStore.open(config.file, { ...storeOptions, expectedDecisionId: options.decisionId });
  try {
    storage = [[config.file, false], [path.dirname(config.file), true], [options.anchorDir, true]]
      .map(([file, directory]) => ({ file, directory, identity: storageIdentity(file, directory) }));
  } catch (primary) {
    let cleanup, cleanupFailed = false;
    try { store.close(); } catch (error) { cleanup = error; cleanupFailed = true; }
    throw publicFailure(primary, "ERR_WITNESS_ADMISSION_HOST_STORAGE_CHANGED", diagnostics, cleanup, cleanupFailed);
  }

  function createContext(input) {
    let ownsActive = false, fallback = "ERR_WITNESS_ADMISSION_HOST_INPUT";
    try {
      if (closed || blocked || active) fail("ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
      // Own the guard before touching input, including proxy reflection traps.
      active = { kind: "assignment" }; ownsActive = true;
      exact(input, ["identity", "incarnation", "principal", "grant", "permissions", "resources", "isCurrent"]);
      const { identity, isCurrent } = input;
      if (!identity || typeof identity !== "object" || typeof isCurrent !== "function") fail();
      text(input.incarnation);
      // Refuse mutable shared grants, then detach even the immutable metadata.
      exact(input.grant, ["id", "version"]);
      if (!Object.isFrozen(input.grant)) fail();
      const principal = copy(input.principal), grant = copy(input.grant), permissions = copy(input.permissions);
      exact(principal, ["subjectId", "issuer", "tenant"]);
      Object.values(principal).forEach(text); text(grant.id); positive(grant.version);
      if (!Array.isArray(permissions) || permissions.length === 0 || new Set(permissions).size !== permissions.length ||
          permissions.some(permission => !PERMISSIONS.includes(permission))) fail();
      const resources = envelope(input.resources);
      const binding = Object.freeze({ authorityId, decisionId: options.decisionId,
        incarnation: input.incarnation, principal, grant, permissions, resources });
      const record = { identity, isCurrent, binding, permissions, revoked: false,
        bytes: canonicalBytes(resources).toString("utf8") };
      fallback = "ERR_WITNESS_NOT_AUTHORIZED";
      if (!current(record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      const context = Object.freeze(Object.create(null));
      contexts.set(context, record);
      return context;
    } catch (error) {
      // Never inspect an unknown thrown value: it may itself be a proxy.
      throw publicFailure(error, fallback, diagnostics);
    } finally {
      // A rejected nested call must not release the outer assignment/dispatch.
      if (ownsActive) active = null;
    }
  }

  function dispatch(context, operation, input) {
    if (closed || blocked || active) return outcome("rejected", "not-attempted", "ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
    let entered = false;
    active = { context, operation };
    try {
      const record = contexts.get(context);
      if (!record || !record.permissions.includes(operation)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      const request = envelope(input), bytes = canonicalBytes(request).toString("utf8");
      if (bytes !== record.bytes) fail("ERR_WITNESS_NOT_AUTHORIZED");
      Object.assign(active, { record, bytes });
      if (!current(record)) fail("ERR_WITNESS_NOT_AUTHORIZED");
      entered = true;
      const result = copy(synchronous(operation === "request.admit"
        ? store.admitAuthorityRequest(context, request) : store.lookupAuthorityRequest(context, request)));
      exact(result, ["status", "requestDigest", "executionAuthorized", "resumeAllowed", "originalRequestOutcome"], ["attemptId"]);
      if (!current(record) || result.executionAuthorized !== false || result.resumeAllowed !== false ||
          result.originalRequestOutcome !== "unknown" ||
          result.requestDigest !== crypto.createHash("sha256").update(bytes).digest("hex")) fail();
      if (result.status === "admitted") text(result.attemptId);
      else if (operation !== "request.lookup" || result.status !== "not-found" || Object.hasOwn(result, "attemptId")) fail();
      // confirmed means ONLY the existing synchronous store/anchor call returned
      // in this local model. It is not R5 publication/response delivery proof.
      return outcome(operation === "request.admit" ? "recorded" : "observed", "confirmed", null, result);
    } catch {
      if (!entered) return outcome("rejected", "not-attempted", "ERR_WITNESS_ADMISSION_HOST_REJECTED");
      // Includes permission loss, conflicts, clock poison and both pre/post DB
      // COMMIT failures. Never infer rollback from an error code, retry, reopen,
      // restore state, release a reservation or fall back to another API.
      blocked = true;
      return outcome("unknown", "unknown", "ERR_WITNESS_ADMISSION_OUTCOME_UNKNOWN");
    } finally { active = null; }
  }
  return Object.freeze({ createContext,
    admit: (context, input) => dispatch(context, "request.admit", input),
    lookup: (context, input) => dispatch(context, "request.lookup", input),
    revokeContext(context) { const record = contexts.get(context); if (record) record.revoked = true; },
    close() {
      if (active) fail("ERR_WITNESS_ADMISSION_HOST_UNAVAILABLE");
      if (closed) return;
      closed = true;
      try { store.close(); }
      catch (error) { throw publicFailure(error, "ERR_WITNESS_ADMISSION_HOST_CLOSE", diagnostics); }
    } });
}

module.exports = { createPermitWitnessAdmissionHost, createPermitWitnessAdmissionDiagnostics };
