"use strict";

const crypto = require("node:crypto");
const { startManagedCallerSession } = require("../governed/managed-caller-supervisor");
const { createPermitWitnessHost, validatePermitWitnessAssignment } = require("./permit-witness-host");
const { canonicalBytes, normalizeTargetState } = require("./permit-witness-contract");
const delivery = require("./permit-delivery");

const OPERATIONS = Object.freeze({
  "permit.witness.register": "register",
  "permit.witness.issue": "issue",
  "permit.witness.consume": "consume",
});
const HISTORY_OPERATION = "permit.witness.history";

function fail(code = "ERR_WITNESS_MANAGED_HOST_INPUT") {
  throw Object.assign(new Error(code), { code });
}
function exact(value, required, optional = []) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) ||
      keys.some(key => ![...required, ...optional].includes(key))) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail();
  }
}

// Static grant validation must precede spawn/open: opening an existing store
// can itself persist clock poison. Persisted history and live identity are still
// validated by createHistoryContext/queryHistory, never inferred here.
function validateHistoryQuery(query, config) {
  const leaseFields = ["owner", "sessionId", "hostId", "workerId", "runId", "generation", "desktopKey", "ownedAppId"];
  const permitFields = ["operation", "targetDigest", "paramsDigest"];
  const pinFields = ["decision_id", "instance_id", "fingerprint", "public_key_pem", "source_digest", "deployment_digest",
    "run_id", "generation", "valid_from", "valid_until"];
  const requests = { register: ["targetId", "requestId", "checkpoint", "pin"],
    issue: ["targetId", "checkpoint", "lease", "permit", "batchFingerprint"],
    consume: ["targetId", "checkpoint", "message", "signature"] };
  const text = value => { if (typeof value !== "string" || !value) fail(); };
  const positive = value => { if (!Number.isSafeInteger(value) || value <= 0) fail(); };
  const digest = value => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) fail(); return value.toLowerCase(); };
  function mapKey(value) {
    text(value);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) fail();
  }
  exact(query, ["operation", "decisionId", "authorityId", "issuerStoreId", "targetGeneration", "resources", "request"]);
  if (!Object.hasOwn(requests, query.operation) || query.decisionId !== config.storeOptions.decisionId ||
      query.authorityId !== config.authorityId) fail();
  text(query.decisionId); text(query.authorityId); text(query.issuerStoreId);
  if (query.targetGeneration !== null) text(query.targetGeneration);
  const r = query.request, resources = query.resources;
  exact(r, requests[query.operation]); mapKey(r.targetId);
  exact(resources, ["fingerprint", "lease", "permit"]);
  if (digest(resources.fingerprint) !== resources.fingerprint) fail();
  if (query.targetGeneration === null && (query.operation !== "register" || r.checkpoint !== null)) fail();
  if (r.checkpoint !== null) {
    const cp = r.checkpoint;
    exact(cp, ["format_version", "authority_id", "target_id", "store_generation", "revision", "full_state_digest"]);
    if (cp.format_version !== 1 || cp.authority_id !== query.authorityId || cp.target_id !== r.targetId ||
        cp.store_generation !== query.targetGeneration || digest(cp.full_state_digest) !== cp.full_state_digest) fail();
    text(cp.store_generation); positive(cp.revision);
  } else if (query.operation !== "register") fail();
  if (query.operation === "register") {
    if (resources.lease !== null || resources.permit !== null) fail();
    mapKey(r.requestId); exact(r.pin, pinFields);
    normalizeTargetState({ schema_version: 3, pins: [{ ...r.pin, registered_at_ms: 0 }], revoked_fingerprints: [],
      applied_revocation_sequence: 0, highest_seen_revocation_sequence: 0,
      highest_accepted_permit_sequence: 0, last_observed_clock_ms: 0, clock_poisoned: false });
    if (r.pin.decision_id !== query.decisionId || r.pin.instance_id !== r.targetId ||
        crypto.createPublicKey(r.pin.public_key_pem).asymmetricKeyType !== "ed25519" ||
        delivery.publicKeyFingerprint(r.pin.public_key_pem) !== r.pin.fingerprint ||
        r.pin.fingerprint !== resources.fingerprint) fail();
    return;
  }
  exact(resources.lease, leaseFields); leaseFields.forEach(field => text(resources.lease[field]));
  exact(resources.permit, permitFields); text(resources.permit.operation);
  digest(resources.permit.targetDigest); digest(resources.permit.paramsDigest);
  if (query.operation === "issue") {
    exact(r.lease, [...leaseFields, "idempotencyKey", "ttlMs"]);
    exact(r.permit, [...permitFields, "idempotencyKey", "ttlMs"]);
    for (const fields of [r.lease, r.permit]) { mapKey(fields.idempotencyKey); positive(fields.ttlMs); }
    if (r.batchFingerprint !== resources.fingerprint ||
        leaseFields.some(field => r.lease[field] !== resources.lease[field]) ||
        permitFields.some(field => r.permit[field] !== resources.permit[field])) fail();
    return;
  }
  const message = r.message;
  exact(message, [...delivery.BINDING_FIELD_MAP.map(([, name]) => name), "issued_at_ms", "deadline_ms", "permit_id"]);
  for (const [field, value] of Object.entries(message)) {
    if (["service_epoch", "fencing", "sequence"].includes(field)) positive(value);
    else if (["issued_at_ms", "deadline_ms"].includes(field)) {
      if (!Number.isSafeInteger(value) || value < 0) fail();
    } else if (["target_digest", "params_digest"].includes(field)) { if (digest(value) !== value) fail(); }
    else text(value);
  }
  mapKey(message.permit_id);
  text(r.signature);
  const signature = Buffer.from(r.signature, "base64");
  if (message.deadline_ms <= message.issued_at_ms || signature.length !== 64 || signature.toString("base64") !== r.signature) fail();
  for (const [storage, signed] of delivery.BINDING_FIELD_MAP) {
    const expected = Object.hasOwn(resources.lease, storage) ? resources.lease : resources.permit;
    if (Object.hasOwn(expected, storage) && message[signed] !==
        (["targetDigest", "paramsDigest"].includes(storage) ? digest(expected[storage]) : expected[storage])) fail();
  }
}

// Trusted LOCAL host composition, never a request handler or a remote identity
// adapter. The host chooses the executable, business session, principal, actions
// and resources. No caller identity, factSource, injected session, alternate host
// or legacy backend is accepted. Providers must use development keys/effects.
// Unsigned development labels do not isolate signed permits from production.
//
// The witness identity is an empty, private reference, NOT the public OS facts
// object. Its only binding is to the exact session/child this factory starts.
// Transport sessionId is deliberately NOT substituted for businessSessionId;
// hostId/workerId/etc. are explicit resource assignments, not remote identity.
async function startPermitWitnessManagedHost(input) {
  exact(input, ["modulePath", "witness"], ["assignment", "historyAssignment", "args", "handshakeTimeoutMs", "requestTimeoutMs"]);
  input = { ...input };
  exact(input, ["modulePath", "witness"], ["assignment", "historyAssignment", "args", "handshakeTimeoutMs", "requestTimeoutMs"]);
  const { modulePath } = input;
  if (typeof modulePath !== "string" || !modulePath) fail();
  const args = JSON.parse(canonicalBytes(input.args === undefined ? [] : input.args).toString("utf8"));
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) fail();
  for (const key of ["handshakeTimeoutMs", "requestTimeoutMs"]) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] <= 0)) fail();
  }
  const assignment = input.assignment === undefined ? null : JSON.parse(canonicalBytes(input.assignment).toString("utf8"));
  if (assignment) {
    exact(assignment, ["businessSessionId", "principal", "actions", "resources"]);
    if (typeof assignment.businessSessionId !== "string" || !assignment.businessSessionId ||
        typeof assignment.principal !== "string" || !assignment.principal ||
        assignment.resources?.lease?.sessionId !== assignment.businessSessionId ||
        assignment.resources.lease.owner !== assignment.principal ||
        !Array.isArray(assignment.actions) || !assignment.actions.length ||
        new Set(assignment.actions).size !== assignment.actions.length ||
        assignment.actions.some(action => !Object.values(OPERATIONS).includes(action))) fail();
  } else if (input.assignment !== undefined) fail();
  const historyAssignment = input.historyAssignment === undefined ? null
    : JSON.parse(canonicalBytes(input.historyAssignment).toString("utf8"));
  if (historyAssignment) {
    exact(historyAssignment, ["principal", "queries"]);
    if (typeof historyAssignment.principal !== "string" || !historyAssignment.principal ||
        !Array.isArray(historyAssignment.queries) || !historyAssignment.queries.length) fail();
    const keys = historyAssignment.queries.map(query => canonicalBytes(query).toString("utf8"));
    if (new Set(keys).size !== keys.length) fail();
  } else if (input.historyAssignment !== undefined) fail();
  if (!assignment && !historyAssignment) fail();

  // Snapshot host configuration before awaiting spawn/handshake. Functions stay
  // host-owned; accessors and unrecognized injection points are refused.
  exact(input.witness, ["backend", "mode", "access", "file", "authorityId", "storeOptions", "providers"], ["clock"]);
  const config = { ...input.witness };
  exact(config, ["backend", "mode", "access", "file", "authorityId", "storeOptions", "providers"], ["clock"]);
  if (config.backend !== "development-witness" || config.mode !== "development-only" ||
      !["initialize", "open"].includes(config.access)) fail("ERR_WITNESS_AUTHORITY_DISABLED");
  // An observer can only open existing authority, never provision or recover it.
  if (historyAssignment && config.access !== "open") fail("ERR_WITNESS_AUTHORITY_DISABLED");
  // Mirror the host's complete pure configuration contract before executing an
  // executable or opening authority. Do not sample clocks or invoke providers;
  // filesystem, OS identity and persisted-state checks still belong to the host.
  const text = value => typeof value === "string" && value.length > 0;
  const positive = value => Number.isSafeInteger(value) && value > 0;
  if (!text(config.file) || config.file.includes("\0") || !text(config.authorityId)) fail("ERR_WITNESS_HOST_INPUT");
  exact(config.storeOptions, ["decisionId", "anchorDir", "anchorMode"], ["serviceIdentity", "minimumEpoch"]);
  config.storeOptions = JSON.parse(canonicalBytes(config.storeOptions).toString("utf8"));
  const options = config.storeOptions;
  exact(options, ["decisionId", "anchorDir", "anchorMode"], ["serviceIdentity", "minimumEpoch"]);
  if (!text(options.decisionId) || !text(options.anchorDir) || options.anchorDir.includes("\0") ||
      !["strict", "permissive"].includes(options.anchorMode) ||
      (options.serviceIdentity !== undefined && !text(options.serviceIdentity)) ||
      (config.access === "open" && !positive(options.minimumEpoch)) ||
      (options.minimumEpoch !== undefined && !positive(options.minimumEpoch)) ||
      (config.clock !== undefined && typeof config.clock !== "function")) fail("ERR_WITNESS_HOST_INPUT");
  exact(config.providers, ["observeTarget", "signPermit", "pullRevocation"]);
  config.providers = { ...config.providers };
  // Validate what will actually reach the host, not just a mutable/proxy source.
  exact(config.providers, ["observeTarget", "signPermit", "pullRevocation"]);
  if (Object.values(config.providers).some(provider => typeof provider !== "function")) fail("ERR_WITNESS_HOST_INPUT");
  // Reuse the complete context grant validation before spawn or persistence.
  if (assignment) validatePermitWitnessAssignment({ principal: assignment.principal, actions: assignment.actions,
    resources: assignment.resources }, config.storeOptions.decisionId);
  if (historyAssignment) historyAssignment.queries.forEach(query => validateHistoryQuery(query, config));

  const identity = Object.freeze(Object.create(null));
  // Explicit, exact-query capabilities. These are unrelated to the writer's
  // action grant or historical lease owner, but bound to this same live child.
  const historyContexts = new Map();
  let runtime, expectedIdentity, host, context, ready = false, lost = false, closing;
  function invalidate() {
    lost = true;
    if (context) host.revokeContext(context);
    for (const reader of historyContexts.values()) host.revokeContext(reader);
  }
  function isCurrent(actual) {
    if (actual !== identity || lost || !runtime) return false;
    const { session, child } = runtime;
    try {
      if (!session.established || session.childIdentity !== expectedIdentity ||
          !(process.platform === "win32" ? session.connected : child.connected) || child.exitCode !== null || child.signalCode !== null ||
          session.auditChannelHolders().ok !== true || session.auditProcessContinuity().ok !== true) {
        invalidate();
        return false;
      }
      // No async gap and no user-supplied liveness predicate.
      return !lost && session.established && (process.platform === "win32" ? session.connected : child.connected) && session.childIdentity === expectedIdentity;
    } catch {
      invalidate();
      return false;
    }
  }
  function close() {
    if (closing) return closing;
    invalidate();
    closing = (async () => {
      try {
        if (runtime) {
          const { child, session } = runtime;
          // Reap only our child. Wait for OS exit rather than IPC close:
          // Node may omit 'close' after an explicit in-flight disconnect.
          const exited = new Promise((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
            const timer = setTimeout(() => {
              child.removeListener("exit", onExit);
              reject(Object.assign(new Error("ERR_WITNESS_MANAGED_CHILD_CLEANUP"), { code: "ERR_WITNESS_MANAGED_CHILD_CLEANUP" }));
            }, 3000);
            function onExit() { clearTimeout(timer); resolve(); }
            child.once("exit", onExit);
          });
          await session.close("witness_managed_host_closed");
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await exited;
          for (const stream of child.stdio) if (stream) stream.destroy();
        }
      } finally {
        if (host) host.close();
      }
    })();
    return closing;
  }

  try {
    runtime = await startManagedCallerSession({
      modulePath, args, owner: assignment ? assignment.principal : historyAssignment.principal,
      handshakeTimeoutMs: input.handshakeTimeoutMs, requestTimeoutMs: input.requestTimeoutMs,
      allowedOperations: [...Object.keys(OPERATIONS).filter(operation => assignment?.actions.includes(OPERATIONS[operation])),
        ...(historyAssignment ? [HISTORY_OPERATION] : [])],
      onIdentityUnavailable: invalidate,
      onAuthorizedRequest: ({ identity: actual, operation, payload }) => {
        if (!ready || actual !== expectedIdentity || !isCurrent(identity)) {
          fail("ERR_WITNESS_MANAGED_IDENTITY_UNAVAILABLE");
        }
        if (operation === HISTORY_OPERATION) {
          const reader = historyContexts.get(canonicalBytes(payload).toString("utf8"));
          if (!reader) fail("ERR_WITNESS_MANAGED_HISTORY_NOT_AUTHORIZED");
          // This observes an independent fact, never fixes the old request's
          // outcome or clears a blocked/lost latch. No retry/reopen/fallback.
          return host.queryHistory(reader, payload);
        }
        if (!Object.hasOwn(OPERATIONS, operation)) fail();
        return host.dispatch(context, OPERATIONS[operation], payload);
      },
    });
    runtime.child.stdout.resume();
    runtime.child.stderr.resume();
    expectedIdentity = runtime.session.childIdentity;
    runtime.session.onClose(invalidate);
    (process.platform === "win32" ? runtime.transport : runtime.child).once("disconnect", invalidate);
    runtime.child.once("exit", invalidate);
    if (!isCurrent(identity)) fail("ERR_WITNESS_MANAGED_IDENTITY_UNAVAILABLE");
    // An unverifiable process must never provision a witness store.
    host = createPermitWitnessHost(config);
    if (assignment) context = host.createContext({ identity, principal: assignment.principal, actions: assignment.actions,
      resources: assignment.resources, isCurrent });
    if (historyAssignment) for (const query of historyAssignment.queries) {
      const reader = host.createHistoryContext({ identity, principal: historyAssignment.principal, query, isCurrent });
      historyContexts.set(canonicalBytes(query).toString("utf8"), reader);
    }
    ready = true;
    // Host control surface only: do not expose this result through request
    // routing. Neither the opaque identity nor the witness context escapes.
    return Object.freeze({ session: runtime.session, child: runtime.child,
      mode: "development-only", executionAuthorized: false, close });
  } catch (error) {
    try { await close(); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

module.exports = { OPERATIONS, HISTORY_OPERATION, startPermitWitnessManagedHost };
