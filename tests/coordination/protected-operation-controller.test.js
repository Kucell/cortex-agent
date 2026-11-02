"use strict";

// Contract tests for the candidate operation controller. The controller is a
// default-refusing adapter: there is no trusted control domain in this
// repository yet, so the primary assertion is that it fails closed.
const test = require("node:test");
const assert = require("node:assert");
const controller = require("../../lib/coordination/protected-operation-controller");
const ledger = require("../../lib/coordination/protected-control-ledger");
const controlBase = require("../../lib/coordination/protected-control-base");

const HEAD = "a".repeat(64);

function plan(overrides = {}) {
  const bytes = Buffer.from('{"schema":1}\n');
  return {
    operation_id: "op-1",
    domain: "domain-a",
    kind: "transaction",
    owner: { owner_id: "service-a", owner_generation: 1, fence: 7 },
    slot: { domain: "domain-a", store_id: "store-a", sequence: 1, attempt: 1, record_type: "intent" },
    original_bytes: bytes,
    body_digest: ledger.digestOf(bytes),
    expected_head: HEAD,
    created_at_ms: 1000,
    ...overrides,
  };
}

// A test-only backend that records the phase order it was asked to persist.
// It is NOT a control domain: it has no rollback protection, no
// authentication and no genesis. The tests use it only to observe the
// controller's ordering contract.
function recordingBackend(overrides = {}) {
  const appended = [];
  const settled = [];
  // Scoped descriptions are accepted only through the TEST_ONLY entry point.
  const evidence = controlBase.EVIDENCE_KINDS;
  const scope = {
    domain: "domain-a", head: HEAD, owner: plan().owner,
    issued_at_ms: 900, expires_at_ms: 2000,
  };
  return {
    test_only: true,
    appended,
    settled,
    properties: {
      independentRollbackDomain: true,
      authenticatedAccess: true,
      completeHead: true,
      antiRollback: true,
      genesisProvisioned: true,
      ...overrides,
    },
    evidence: [
      controlBase.evidence("independentRollbackDomain", evidence.EXTERNAL_WITNESS, "test-witness", scope),
      controlBase.evidence("authenticatedAccess", evidence.OS_IDENTITY, "test-os", scope),
      controlBase.evidence("completeHead", evidence.SELF_ENUMERATED_CHAIN, "test-chain", scope),
      controlBase.evidence("antiRollback", evidence.EXTERNAL_WITNESS, "test-witness", scope),
      controlBase.evidence("genesisProvisioned", evidence.INSTALLER_REGISTRATION, "test-installer", scope),
    ],
    readHead() { return HEAD; },
    appendPhase(record) { appended.push(record); return controller.TEST_ONLY.SYNC_ACK; },
    settleOutcome(record) { settled.push(record); return controller.TEST_ONLY.SYNC_ACK; },
  };
}

test("the default backend refuses every call", () => {
  assert.throws(
    () => controller.OperationController.begin(controller.UNSUPPORTED_BACKEND, plan()),
    (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED",
  );
});

test("a backend missing a required property is refused", () => {
  for (const name of controller.REQUIRED_BACKEND_PROPERTIES) {
    const backend = recordingBackend({ [name]: false });
    assert.throws(
      () => controller.TEST_ONLY.begin(backend, plan(), 1000),
      (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED",
      `expected ${name} to be required`,
    );
  }
});

test("a backend missing a method is refused", () => {
  const backend = recordingBackend();
  delete backend.readHead;
  assert.throws(
    () => controller.TEST_ONLY.begin(backend, plan(), 1000),
    (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED",
  );
});

test("the registration is persisted before the caller may act", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  assert.strictEqual(backend.appended.length, 1);
  assert.strictEqual(backend.appended[0].phase, ledger.PHASES.REGISTERED);
  assert.strictEqual(backend.appended[0].side_effect, null);
  assert.strictEqual(op.phase, ledger.PHASES.REGISTERED);
  assert.strictEqual(op.testOnly, true);
  assert.strictEqual(op.view().test_only, true);
  op.close();
});

test("a side effect is declared possible before it may be invoked", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1001);
  assert.strictEqual(backend.appended[1].phase, ledger.PHASES.CALL_POSSIBLE);
  assert.strictEqual(backend.appended[1].side_effect, ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT);
  op.close();
});

test("an unknown call freezes the scope", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1001);
  op.markUnknown(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1002, "audit outcome not observed");
  assert.throws(
    () => op.declare(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1003),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  const view = op.view();
  assert.deepStrictEqual([...view.unknown_side_effects], [ledger.SIDE_EFFECTS.OPERATION_AUDIT]);
  assert.strictEqual(view.proves_business_commit, false);
  op.close();
});

test("late evidence may confirm the same effect but not introduce another", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1001);
  op.markUnknown(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1002, "timeout");
  assert.throws(
    () => op.confirm(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1003),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  op.close();
});

// A declared side effect may only be confirmed or marked unknown as THAT
// effect. Reporting the outcome of a different effect would let the backend
// record a confirmation the declaration never covered, while the declared
// effect stayed pending. The refusal must happen before the backend is asked
// to persist anything, and must not advance the in-memory state.
test("a declaration cannot be confirmed as a different side effect", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1001);
  const persistedBefore = backend.appended.length;
  assert.throws(
    () => op.confirm(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1002),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  // The rejection happened before any persistence and did not change state.
  assert.strictEqual(backend.appended.length, persistedBefore);
  assert.strictEqual(op.phase, ledger.PHASES.CALL_POSSIBLE);
  const view = op.view();
  assert.deepStrictEqual([...view.pending_side_effects], [ledger.SIDE_EFFECTS.OPERATION_AUDIT]);
  assert.deepStrictEqual([...view.confirmed_side_effects], []);
  op.close();
});

test("a declaration cannot be marked unknown as a different side effect", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1001);
  const persistedBefore = backend.appended.length;
  assert.throws(
    () => op.markUnknown(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1002, "wrong effect"),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  assert.strictEqual(backend.appended.length, persistedBefore);
  assert.strictEqual(op.phase, ledger.PHASES.CALL_POSSIBLE);
  op.close();
});

test("a closed controller refuses further transitions", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.close();
  assert.throws(
    () => op.declare(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1001),
    (error) => error.code === "ERR_CONTROL_LEDGER_CLOSED",
  );
});

test("completion records the business outcome separately from the phase", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1001);
  op.confirm(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1002);
  op.complete(ledger.OUTCOMES.COMMITTED_UNPUBLISHABLE, 1003);
  assert.strictEqual(op.phase, ledger.PHASES.COMPLETED);
  assert.strictEqual(op.outcome, ledger.OUTCOMES.COMMITTED_UNPUBLISHABLE);
  assert.strictEqual(backend.settled.length, 1);
  assert.strictEqual(backend.settled[0].outcome, ledger.OUTCOMES.COMMITTED_UNPUBLISHABLE);
  op.close();
});

test("a completed operation cannot be completed again", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1001);
  op.confirm(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1002);
  op.complete(ledger.OUTCOMES.CONFIRMED, 1003);
  assert.throws(
    () => op.complete(ledger.OUTCOMES.CONFIRMED, 1004),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  op.close();
});

test("a blocked operation refuses to complete", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.block(1001, "owner fenced");
  assert.throws(
    () => op.complete(ledger.OUTCOMES.COMMIT_UNKNOWN, 1002),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION",
  );
  op.close();
});

test("the controller never reports a proven business commit", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1001);
  op.confirm(ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT, 1002);
  const view = op.view();
  assert.strictEqual(view.proves_business_commit, false);
  assert.strictEqual(view.authorizes_retry, false);
  assert.strictEqual(view.authorizes_cleanup, false);
  op.close();
});

const EFFECT = ledger.SIDE_EFFECTS.OPERATION_DATABASE_COMMIT;

function assertPoisoned(op) {
  assert.strictEqual(op.poisoned, true);
  assert.strictEqual(op.phase, ledger.PHASES.CALLED_UNKNOWN);
  assert.strictEqual(op.outcome, ledger.OUTCOMES.COMMIT_UNKNOWN);
  const view = op.view();
  assert.strictEqual(view.phase, ledger.PHASES.CALLED_UNKNOWN);
  assert.strictEqual(view.outcome, ledger.OUTCOMES.COMMIT_UNKNOWN);
  assert.strictEqual(view.poisoned, true);
  assert.deepStrictEqual([...view.confirmed_side_effects], []);
  assert.strictEqual(view.proves_business_commit, false);
  assert.strictEqual(view.authorizes_retry, false);
  assert.strictEqual(view.authorizes_cleanup, false);
  for (const mutate of [
    () => op.declare(EFFECT, 1004), () => op.confirm(EFFECT, 1004),
    () => op.markUnknown(EFFECT, 1004, "unknown"), () => op.block(1004, "blocked"),
    () => op.complete(ledger.OUTCOMES.CONFIRMED, 1004),
  ]) assert.throws(mutate, (error) => error.code === "ERR_CONTROL_LEDGER_CLOSED");
}

test("direct construction cannot bypass production admission", () => {
  assert.throws(() => new controller.OperationController(recordingBackend(), ledger.createLedger(plan(), HEAD)),
    (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED");
});

test("the test-only harness requires an explicit marker and never admits production", () => {
  const backend = recordingBackend();
  assert.throws(() => controller.OperationController.begin(backend, plan()),
    (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED");
  delete backend.test_only;
  assert.throws(() => controller.TEST_ONLY.begin(backend, plan(), 1000),
    (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED");
  assert.strictEqual(backend.appended.length, 0);
});

test("test-only admission rejects stale or mismatched evidence before registration", () => {
  for (const [registration, now] of [
    [plan(), 2000], [plan({ domain: "other" }), 1000],
    [plan({ owner: { ...plan().owner, fence: 8 } }), 1000],
  ]) {
    const backend = recordingBackend();
    assert.throws(() => controller.TEST_ONLY.begin(backend, registration, now),
      (error) => error.code === "ERR_CONTROL_LEDGER_UNSUPPORTED");
    assert.strictEqual(backend.appended.length, 0);
  }
});

test("appendPhase throwing during confirm poisons the handle and hides confirmation", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(EFFECT, 1001);
  const failure = new Error("append failed after possible write");
  backend.appendPhase = () => { throw failure; };
  assert.throws(() => op.confirm(EFFECT, 1002), (error) => error === failure);
  assertPoisoned(op);
  assert.deepStrictEqual([...op.view().unknown_side_effects], [EFFECT]);
});

for (const method of ["appendPhase", "settleOutcome"]) {
  test(`${method} throwing during completion cannot expose completed or confirmed`, () => {
    const backend = recordingBackend();
    const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
    op.declare(EFFECT, 1001).confirm(EFFECT, 1002);
    backend[method] = () => { throw new Error("write failed"); };
    assert.throws(() => op.complete(ledger.OUTCOMES.CONFIRMED, 1003), /write failed/);
    assertPoisoned(op);
  });
}

for (const transition of ["declare", "markUnknown", "block"]) {
  test(`persistence failure during ${transition} poisons the handle`, () => {
    const backend = recordingBackend();
    const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
    if (transition === "markUnknown") op.declare(EFFECT, 1001);
    backend.appendPhase = () => { throw new Error("write failed"); };
    assert.throws(() => transition === "block" ? op.block(1002, "blocked") : op[transition](EFFECT, 1002), /write failed/);
    assertPoisoned(op);
  });
}

for (const method of ["appendPhase", "settleOutcome"]) {
  for (const [name, response, code] of [
    ["resolved Promise", () => Promise.resolve(controller.TEST_ONLY.SYNC_ACK), "ERR_CONTROL_LEDGER_ASYNC_BACKEND"],
    ["rejected Promise", () => Promise.reject(new Error("async failure")), "ERR_CONTROL_LEDGER_ASYNC_BACKEND"],
    ["thenable", () => ({ then(resolve) { resolve(controller.TEST_ONLY.SYNC_ACK); } }), "ERR_CONTROL_LEDGER_ASYNC_BACKEND"],
    ["undefined", () => undefined, "ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN"],
    ["null", () => null, "ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN"],
    ["false", () => false, "ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN"],
    ["true", () => true, "ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN"],
    ["unknown object", () => ({ outcome: "unknown" }), "ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN"],
  ]) {
    test(`${method} returning ${name} is rejected and poisons the handle`, async () => {
      const backend = recordingBackend();
      const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
      op.declare(EFFECT, 1001);
      if (method === "settleOutcome") op.confirm(EFFECT, 1002);
      backend[method] = response;
      assert.throws(() => method === "appendPhase" ? op.confirm(EFFECT, 1002) :
        op.complete(ledger.OUTCOMES.CONFIRMED, 1003), (error) => error.code === code);
      assertPoisoned(op);
      await new Promise((resolve) => setImmediate(resolve));
      assertPoisoned(op);
    });
  }
}

test("registration requires synchronous head and append acknowledgement", async () => {
  for (const method of ["readHead", "appendPhase"]) {
    const backend = recordingBackend();
    backend[method] = () => Promise.reject(new Error("async registration"));
    assert.throws(() => controller.TEST_ONLY.begin(backend, plan(), 1000),
      (error) => error.code === "ERR_CONTROL_LEDGER_ASYNC_BACKEND");
  }
  for (const result of [undefined, true, { confirmed: true }]) {
    const backend = recordingBackend();
    backend.appendPhase = () => result;
    assert.throws(() => controller.TEST_ONLY.begin(backend, plan(), 1000),
      (error) => error.code === "ERR_CONTROL_LEDGER_PERSISTENCE_UNKNOWN");
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("invalid completion is validated before any write and does not poison", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1001).confirm(ledger.SIDE_EFFECTS.OPERATION_AUDIT, 1002);
  const count = backend.appended.length;
  assert.throws(() => op.complete(ledger.OUTCOMES.CONFIRMED, 1003),
    (error) => error.code === "ERR_CONTROL_LEDGER_TRANSITION");
  assert.strictEqual(backend.appended.length, count);
  assert.strictEqual(backend.settled.length, 0);
  assert.strictEqual(op.poisoned, false);
});

test("completion stays unpublished until both acknowledgements and refuses reentry", () => {
  const backend = recordingBackend();
  const op = controller.TEST_ONLY.begin(backend, plan(), 1000);
  op.declare(EFFECT, 1001).confirm(EFFECT, 1002);
  backend.settleOutcome = () => {
    assert.strictEqual(op.phase, ledger.PHASES.CONFIRMED);
    assert.strictEqual(op.outcome, null);
    assert.throws(() => op.block(1004, "reentry"), (error) => error.code === "ERR_CONTROL_LEDGER_CLOSED");
    return controller.TEST_ONLY.SYNC_ACK;
  };
  op.complete(ledger.OUTCOMES.CONFIRMED, 1003);
  assert.strictEqual(op.phase, ledger.PHASES.COMPLETED);
  assert.strictEqual(op.outcome, ledger.OUTCOMES.CONFIRMED);
});
