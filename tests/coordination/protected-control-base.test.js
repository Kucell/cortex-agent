"use strict";

// Contract tests for the control-domain base. The base fixes WHAT a backend
// has to prove. It deliberately refuses the production path: a local base
// cannot prove an independent rollback domain and cannot prove
// anti-rollback, so a backend built on it stays closed.
const test = require("node:test");
const assert = require("node:assert/strict");
const controller = require("../../lib/coordination/protected-operation-controller");
const controlBase = require("../../lib/coordination/protected-control-base");

const KINDS = controlBase.EVIDENCE_KINDS;
const SCOPE = {
  domain: "domain-a", head: "a".repeat(64),
  owner: { owner_id: "service-a", owner_generation: 1, fence: 7 },
  issued_at_ms: 900, expires_at_ms: 2000,
};
const CONTEXT = { ...SCOPE, now_ms: 1000 };

function fullEvidence() {
  return [
    controlBase.evidence("independentRollbackDomain", KINDS.EXTERNAL_WITNESS, "witness-1", SCOPE),
    controlBase.evidence("authenticatedAccess", KINDS.OS_IDENTITY, "os-1", SCOPE),
    controlBase.evidence("completeHead", KINDS.SELF_ENUMERATED_CHAIN, "chain-1", SCOPE),
    controlBase.evidence("antiRollback", KINDS.EXTERNAL_WITNESS, "witness-1", SCOPE),
    controlBase.evidence("genesisProvisioned", KINDS.INSTALLER_REGISTRATION, "installer-1", SCOPE),
  ];
}

function backend(overrides = {}) {
  return {
    properties: {
      independentRollbackDomain: true,
      authenticatedAccess: true,
      completeHead: true,
      antiRollback: true,
      genesisProvisioned: true,
      ...overrides,
    },
    evidence: fullEvidence(),
    readHead() { return { sequence: 1, digest: "a".repeat(64) }; },
    appendPhase() {},
    settleOutcome() {},
  };
}

test("the base names the five properties the proposal requires", () => {
  assert.deepEqual([...controlBase.PROPERTIES].sort(), [
    "antiRollback", "authenticatedAccess", "completeHead", "genesisProvisioned", "independentRollbackDomain",
  ]);
});

test("complete scoped descriptions cover every property without proving authenticity", () => {
  const view = controlBase.inspect(fullEvidence(), CONTEXT);
  assert.equal(view.complete, true);
  assert.deepEqual([...view.missing], []);
});

test("missing evidence leaves the property unsatisfied", () => {
  const view = controlBase.inspect(fullEvidence().slice(0, 4), CONTEXT);
  assert.equal(view.complete, false);
  assert.deepEqual([...view.missing], ["genesisProvisioned"]);
});

test("a backend that claims every property without evidence is refused", () => {
  const unevidenced = backend();
  unevidenced.evidence = [];
  assert.throws(() => controller.OperationController.begin(unevidenced, { operation_id: "op-1" }),
    { code: "ERR_CONTROL_LEDGER_UNSUPPORTED" });
});

test("a backend whose evidence does not cover the claimed properties is refused", () => {
  const partial = backend();
  partial.evidence = fullEvidence().filter((item) => item.property !== "antiRollback");
  assert.throws(() => controller.OperationController.begin(partial, { operation_id: "op-1" }),
    { code: "ERR_CONTROL_LEDGER_UNSUPPORTED" });
});

test("two conflicting evidences for one property are refused", () => {
  const conflicting = fullEvidence().concat([
    controlBase.evidence("completeHead", KINDS.EXTERNAL_WITNESS, "other-witness", SCOPE),
  ]);
  assert.throws(() => controlBase.inspect(conflicting, CONTEXT), { code: "ERR_CONTROL_BASE_EVIDENCE_CONFLICT" });
});

test("an unknown property is refused", () => {
  assert.throws(() => controlBase.evidence("notAProperty", KINDS.OS_IDENTITY, "os-1"),
    { code: "ERR_CONTROL_BASE_INPUT" });
});

test("a local base cannot prove the two properties that need an outside party", () => {
  // The local base can enumerate its own records and prove its ownership.
  // It cannot prove that a snapshot of the machine does not carry the
  // control domain back to an earlier state, and it cannot prove that the
  // domain is not rolled back together with the business domain.
  assert.deepEqual([...controlBase.LOCAL_PROVABLE].sort(), ["authenticatedAccess", "completeHead", "genesisProvisioned"]);
  assert.deepEqual([...controlBase.LOCAL_NOT_PROVABLE].sort(), ["antiRollback", "independentRollbackDomain"]);
});

test("the domain identity binds the installer registration to the domain", () => {
  const identity = controlBase.domainIdentity({ domain_id: "d-1", installer_id: "i-1", provisioned_at_ms: 1000 });
  assert.match(identity.digest, /^[a-f0-9]{64}$/);
  const other = controlBase.domainIdentity({ domain_id: "d-1", installer_id: "i-2", provisioned_at_ms: 1000 });
  assert.notEqual(identity.digest, other.digest);
});

test("an incomplete domain identity is refused", () => {
  assert.throws(() => controlBase.domainIdentity({ domain_id: "d-1", installer_id: "i-1", provisioned_at_ms: -1 }),
    { code: "ERR_CONTROL_BASE_INPUT" });
});

test("five self-reported properties and all true flags cannot admit production", () => {
  let calls = 0;
  const claimed = backend();
  claimed.evidence = controlBase.PROPERTIES.map((property) => ({ property }));
  claimed.capability = { verified: true, ...SCOPE };
  claimed.readHead = () => { calls++; return SCOPE.head; };
  claimed.appendPhase = () => { calls++; };
  assert.throws(() => controller.OperationController.begin(claimed, { operation_id: "op-1" }),
    { code: "ERR_CONTROL_LEDGER_UNSUPPORTED" });
  assert.equal(calls, 0);
});

test("even complete scoped descriptions are not production capabilities", () => {
  assert.throws(() => controller.OperationController.begin(backend(), { operation_id: "op-1" }),
    { code: "ERR_CONTROL_LEDGER_UNSUPPORTED" });
});

test("inspect validates the first evidence and requires kind and producer", () => {
  for (const key of ["kind", "producer", "detail"]) {
    const list = fullEvidence().map((item) => ({ ...item }));
    delete list[0][key];
    assert.throws(() => controlBase.inspect(list, CONTEXT), { code: "ERR_CONTROL_BASE_INPUT" });
  }
  assert.throws(() => controlBase.inspect(controlBase.PROPERTIES.map((property) => ({ property })), CONTEXT),
    { code: "ERR_CONTROL_BASE_INPUT" });
  assert.throws(() => controlBase.inspect(fullEvidence()), { code: "ERR_CONTROL_BASE_INPUT" });
});

test("evidence is bound to the exact domain, head, owner generation and fence", () => {
  for (const mismatch of [
    { domain: "domain-b" }, { head: "b".repeat(64) },
    { owner: { ...SCOPE.owner, owner_id: "other" } },
    { owner: { ...SCOPE.owner, owner_generation: 2 } },
    { owner: { ...SCOPE.owner, fence: 8 } },
  ]) {
    assert.throws(() => controlBase.inspect(fullEvidence(), { ...CONTEXT, ...mismatch }),
      { code: "ERR_CONTROL_BASE_INPUT" });
  }
});

test("evidence must be currently valid, including exact expiry boundary", () => {
  for (const now_ms of [899, 2000, 2001, NaN, -1]) {
    assert.throws(() => controlBase.inspect(fullEvidence(), { ...CONTEXT, now_ms }),
      { code: "ERR_CONTROL_BASE_INPUT" });
  }
  assert.equal(controlBase.inspect(fullEvidence(), { ...CONTEXT, now_ms: 900 }).complete, true);
  assert.equal(controlBase.inspect(fullEvidence(), { ...CONTEXT, now_ms: 1999 }).complete, true);
});

test("evidence requires a valid lifetime and snapshots its owner binding", () => {
  for (const times of [
    { issued_at_ms: -1 }, { expires_at_ms: 900 }, { expires_at_ms: undefined },
  ]) {
    assert.throws(() => controlBase.evidence("antiRollback", KINDS.EXTERNAL_WITNESS, "w", { ...SCOPE, ...times }),
      { code: "ERR_CONTROL_BASE_INPUT" });
  }
  const detail = { ...SCOPE, owner: { ...SCOPE.owner } };
  const item = controlBase.evidence("antiRollback", KINDS.EXTERNAL_WITNESS, "w", detail);
  detail.owner.fence = 999;
  assert.equal(item.detail.owner.fence, 7);
  assert.equal(Object.isFrozen(item.detail.owner), true);
});
