"use strict";

// CANDIDATE operation controller. NOT an authority, NOT production wiring.
//
// The controller enforces the ordering the publication proposal requires: a
// registration exists in the control domain before the first side effect,
// every side effect is declared possible before it is invoked, and the
// outcome of an ambiguous call is never silently turned into a success or a
// cleanup.
//
// The controller is deliberately a *default-refusing* adapter. It has no
// trusted backend yet: the control domain described by proposal section 4.3
// does not exist in this repository. The production entry point therefore fails
// closed with ERR_CONTROL_LEDGER_UNSUPPORTED. Only TEST_ONLY.begin can run
// the offline ordering contract; evidence descriptions are not credentials.
// A production path requires a trusted composition root and opaque verified
// capabilities, neither of which is implemented here. The point of the
// module is to fix the ordering contract and its refusals while the backend
// is still being designed, not to enable a production path.

const ledger = require("./protected-control-ledger");
const controlBase = require("./protected-control-base");

class OperationControllerError extends Error {
  constructor(code, details) {
    super(code);
    this.name = "OperationControllerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, details) { throw new OperationControllerError(code, details); }

const CONSTRUCTION_TOKEN = Symbol("operation-controller-construction");
// Explicit synchronous acknowledgement. Undefined, booleans and thenables
// do not acknowledge persistence. Exposed only through the test harness.
const SYNC_ACK = Object.freeze({});

function synchronous(value) {
  if (value && (typeof value === "object" || typeof value === "function") &&
      typeof value.then === "function") {
    // Observe eventual rejection without treating eventual success as an ack.
    Promise.resolve(value).catch(() => {});
    fail("ERR_CONTROL_LEDGER_ASYNC_BACKEND");
  }
  return value;
}

function persist(backend, method, record) {
  if (synchronous(backend[method](record)) !== SYNC_ACK) {
    fail("ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN", { method });
  }
}

// A backend must be able to say, for the domain it serves, that the
// properties the proposal requires actually hold. A backend that cannot
// answer is not a backend; it is an assumption.
const REQUIRED_BACKEND_PROPERTIES = Object.freeze([
  // The control domain has its own rollback domain, separate from the
  // business DB and from the anchor domain.
  "independentRollbackDomain",
  // The backend authenticates who may extend the domain.
  "authenticatedAccess",
  // The backend exposes a complete, verifiable head.
  "completeHead",
  // The backend detects a rollback of its own head.
  "antiRollback",
  // The domain was installed through a trusted provisioning registration.
  "genesisProvisioned",
]);

function assertTestBackend(backend) {
  if (!backend || typeof backend !== "object") fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
  if (backend.test_only !== true) fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
  const properties = backend.properties;
  if (!properties || typeof properties !== "object") fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
  for (const name of REQUIRED_BACKEND_PROPERTIES) {
    if (properties[name] !== true) fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
  }
  for (const method of ["readHead", "appendPhase", "settleOutcome"]) {
    if (typeof backend[method] !== "function") fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
  }
  return backend;
}

// The controller holds the ledger state for one operation. It never exposes a
// method that could turn an unknown into a success, and it never performs
// the side effect itself: the caller invokes the effect between `begin*` and
// `confirm*`, so the declaration order is visible in the caller's code.
class OperationController {
  #backend;
  #state;
  #closed = false;
  #poisoned = false;
  #persisting = false;
  #uncertainEffect = null;

  constructor(backend, state, token) {
    if (token !== CONSTRUCTION_TOKEN) fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
    this.#backend = backend;
    this.#state = state;
  }

  static #requireOpen(controller) {
    if (controller.#closed || controller.#persisting) fail("ERR_CONTROL_LEDGER_CLOSED");
  }

  static begin(backend, plan) {
    // Never accept caller-minted evidence, booleans or capability-shaped
    // objects as production authority. External verification is unavailable.
    fail("ERR_CONTROL_LEDGER_UNSUPPORTED");
  }

  static #beginTestOnly(backend, plan, nowMs) {
    assertTestBackend(backend);
    const head = synchronous(backend.readHead());
    let state = ledger.createLedger(plan, head);
    let view;
    try {
      view = controlBase.inspect(backend.evidence || [], {
        domain: state.registration.domain, head, owner: state.registration.owner, now_ms: nowMs,
      });
    } catch (error) { fail("ERR_CONTROL_LEDGER_UNSUPPORTED"); }
    if (!view.complete) fail("ERR_CONTROL_LEDGER_UNSUPPORTED", { missing: view.missing });
    // Persist the registration itself. A registration that could not be
    // persisted must not be treated as registered.
    const record = {
      operation_id: state.registration.operation_id,
      phase: ledger.PHASES.REGISTERED,
      side_effect: null,
      expected_head: state.head,
      owner: state.registration.owner,
      at_ms: state.registration.created_at_ms,
      reason: null,
    };
    state = ledger.advance(state, record);
    persist(backend, "appendPhase", record);
    return new OperationController(backend, state, CONSTRUCTION_TOKEN);
  }

  static testOnly = Object.freeze({
    SYNC_ACK,
    begin(backend, plan, nowMs = Date.now()) {
      return OperationController.#beginTestOnly(backend, plan, nowMs);
    },
  });

  // Validate the candidate before I/O, then publish it only after every
  // synchronous ack. Any ambiguous write permanently poisons this handle.
  #persist(nextState, record, outcomeRecord) {
    this.#persisting = true;
    try {
      persist(this.#backend, "appendPhase", record);
      if (outcomeRecord) persist(this.#backend, "settleOutcome", outcomeRecord);
      this.#state = nextState;
    } catch (error) {
      this.#poisoned = true;
      this.#closed = true;
      this.#uncertainEffect = record.side_effect;
      throw error;
    } finally {
      this.#persisting = false;
    }
    return this;
  }

  get operationId() { return this.#state.registration.operation_id; }
  get kind() { return this.#state.registration.kind; }
  get phase() { return this.#poisoned ? ledger.PHASES.CALLED_UNKNOWN : ledger.lastPhase(this.#state); }
  get outcome() { return this.#poisoned ? ledger.OUTCOMES.COMMIT_UNKNOWN : this.#state.outcome; }
  get poisoned() { return this.#poisoned; }
  get testOnly() { return true; }

  // Declare that a named side effect is about to be invoked. The declaration
  // is persisted first; only then does the caller invoke the effect.
  declare(sideEffect, atMs) {
    OperationController.#requireOpen(this);
    const record = {
      operation_id: this.#state.registration.operation_id,
      phase: ledger.PHASES.CALL_POSSIBLE,
      side_effect: sideEffect,
      expected_head: this.#state.head,
      owner: this.#state.registration.owner,
      at_ms: atMs,
      reason: null,
    };
    return this.#persist(ledger.advance(this.#state, record), record);
  }

  // Record that the declared side effect was invoked and its outcome is not
  // known. The scope is frozen: the controller refuses to declare another
  // side effect afterwards.
  markUnknown(sideEffect, atMs, reason) {
    OperationController.#requireOpen(this);
    const record = {
      operation_id: this.#state.registration.operation_id,
      phase: ledger.PHASES.CALLED_UNKNOWN,
      side_effect: sideEffect,
      expected_head: this.#state.head,
      owner: this.#state.registration.owner,
      at_ms: atMs,
      reason: reason === undefined ? null : reason,
    };
    return this.#persist(ledger.advance(this.#state, record), record);
  }

  // Record that the declared side effect succeeded.
  confirm(sideEffect, atMs) {
    OperationController.#requireOpen(this);
    const record = {
      operation_id: this.#state.registration.operation_id,
      phase: ledger.PHASES.CONFIRMED,
      side_effect: sideEffect,
      expected_head: this.#state.head,
      owner: this.#state.registration.owner,
      at_ms: atMs,
      reason: null,
    };
    return this.#persist(ledger.advance(this.#state, record), record);
  }

  // Block the operation permanently. A blocked operation cannot be resumed
  // by this controller and never authorizes a cleanup.
  block(atMs, reason) {
    OperationController.#requireOpen(this);
    const record = {
      operation_id: this.#state.registration.operation_id,
      phase: ledger.PHASES.BLOCKED,
      side_effect: null,
      expected_head: this.#state.head,
      owner: this.#state.registration.owner,
      at_ms: atMs,
      reason: reason === undefined ? null : reason,
    };
    return this.#persist(ledger.advance(this.#state, record), record);
  }

  // Complete the operation and record the terminal business outcome. The
  // outcome and the ledger phase stay separate: a confirmed business commit
  // with an unconfirmed publication is `committed-unpublishable`.
  complete(outcome, atMs) {
    OperationController.#requireOpen(this);
    const record = {
      operation_id: this.#state.registration.operation_id,
      phase: ledger.PHASES.COMPLETED,
      side_effect: null,
      expected_head: this.#state.head,
      owner: this.#state.registration.owner,
      at_ms: atMs,
      reason: null,
    };
    const completed = ledger.advance(this.#state, record);
    const settled = ledger.settle(completed, outcome, completed.head);
    return this.#persist(settled, record, {
      operation_id: this.#state.registration.operation_id,
      outcome,
      expected_head: this.#state.head,
    });
  }

  // The recovery view for this operation. It never authorizes a retry, a
  // cleanup or an abort, and it never reports a proven business commit.
  view() {
    const view = Object.freeze({ ...ledger.recoveryView(this.#state), test_only: true });
    if (!this.#poisoned) return view;
    return Object.freeze({
      ...view,
      phase: this.phase,
      outcome: this.outcome,
      poisoned: true,
      pending_side_effects: Object.freeze([]),
      confirmed_side_effects: Object.freeze([]),
      unknown_side_effects: Object.freeze([...new Set([
        ...view.pending_side_effects, ...view.unknown_side_effects, ...view.confirmed_side_effects,
        ...(this.#uncertainEffect === null ? [] : [this.#uncertainEffect]),
      ])]),
    });
  }

  close() {
    this.#closed = true;
  }
}

// The default backend. There is no trusted control domain in this
// repository yet, so every call fails closed. This exists so that a caller
// cannot accidentally treat a missing control domain as a permissive one.
const UNSUPPORTED_BACKEND = Object.freeze({
  properties: Object.freeze({
    independentRollbackDomain: false,
    authenticatedAccess: false,
    completeHead: false,
    antiRollback: false,
    genesisProvisioned: false,
  }),
  readHead() { fail("ERR_CONTROL_LEDGER_UNSUPPORTED"); },
  appendPhase() { fail("ERR_CONTROL_LEDGER_UNSUPPORTED"); },
  settleOutcome() { fail("ERR_CONTROL_LEDGER_UNSUPPORTED"); },
});

module.exports = {
  OperationController,
  OperationControllerError,
  REQUIRED_BACKEND_PROPERTIES,
  UNSUPPORTED_BACKEND,
  TEST_ONLY: OperationController.testOnly,
};
