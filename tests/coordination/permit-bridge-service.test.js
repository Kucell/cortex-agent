"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startPermitBridgeService } = require("../../lib/coordination/permit-bridge-service");
const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const { canonicalize } = require("../../lib/coordination/permit-delivery");

const EXECUTOR = path.join(__dirname, "../../lib/commands/permit-bridge-executor.js");

const LEASE_TTL_MS = 60_000;
const PERMIT_TTL_MS = 5_000;

function productRequest(overrides = {}) {
  return {
    operation: "read",
    targetDigest: "a".repeat(64),
    paramsDigest: "b".repeat(64),
    desktopKey: "desk",
    sessionId: "sess",
    workerIdentity: "worker",
    runId: "run",
    generation: "gen",
    hostIdentity: "host",
    ownedAppId: "app",
    correlationId: "corr",
    ...overrides,
  };
}

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permit-bridge-service-"));
  const dbDir = path.join(root, "db");
  const anchorDir = path.join(root, "anchor");
  fs.mkdirSync(dbDir);
  fs.mkdirSync(anchorDir);
  return { root, dbDir, anchorDir, storePath: path.join(dbDir, "state.sqlite") };
}

async function startService(dirs, extra = {}) {
  return startPermitBridgeService({
    storePath: dirs.storePath,
    anchorDir: dirs.anchorDir,
    decisionId: "test-decision",
    executorPath: EXECUTOR,
    create: true,
    leaseTtlMs: LEASE_TTL_MS,
    permitTtlMs: PERMIT_TTL_MS,
    anchorMode: "permissive",
    ...extra,
  });
}

test("the bridge service signs a permit for a product request", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const dirs = tempDirs();
  let service;
  try {
    service = await startService(dirs);
    const ticket = service.issueTicket();
    const response = await fetch("http://127.0.0.1:" + service.address.port + "/permit", {
      method: "POST",
      headers: { "x-permit-bridge-ticket": ticket },
      body: JSON.stringify(productRequest()),
    });
    assert.equal(response.status, 200);
    const grant = await response.json();

    // The grant carries a real signature over the real binding, and the
    // message text canonicalizes to the signer's own form — which is what
    // the product side recomputes before verifying.
    assert.equal(grant.operation, "read");
    assert.equal(grant.targetDigest, "a".repeat(64));
    assert.equal(grant.sessionId, "sess");
    assert.ok(grant.fingerprint && /^[a-f0-9]{64}$/.test(grant.fingerprint));
    assert.ok(grant.signatureBase64);
    assert.ok(grant.messageJson);
    const message = JSON.parse(grant.messageJson);
    assert.equal(canonicalize(message), grant.messageJson);
    assert.equal(message.target_digest, "a".repeat(64));
  } finally {
    if (service) await service.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the bridge service refuses a client without a ticket", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const dirs = tempDirs();
  let service;
  try {
    service = await startService(dirs);
    const response = await fetch("http://127.0.0.1:" + service.address.port + "/permit", {
      method: "POST",
      body: JSON.stringify(productRequest()),
    });
    assert.equal(response.status, 401);
  } finally {
    if (service) await service.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the bridge service refuses to start without a store, a decision or an executor", async () => {
  const dirs = tempDirs();
  try {
    const base = {
      storePath: dirs.storePath,
      anchorDir: dirs.anchorDir,
      decisionId: "test-decision",
      executorPath: EXECUTOR,
      create: true,
      leaseTtlMs: LEASE_TTL_MS,
      permitTtlMs: PERMIT_TTL_MS,
    };
    await assert.rejects(startPermitBridgeService({ ...base, storePath: undefined }),
      { key: "ERR_PERMIT_INPUT_INVALID" });
    await assert.rejects(startPermitBridgeService({ ...base, anchorDir: undefined }),
      { key: "ERR_PERMIT_INPUT_INVALID" });
    await assert.rejects(startPermitBridgeService({ ...base, decisionId: undefined }),
      { key: "ERR_PERMIT_INPUT_INVALID" });
    await assert.rejects(startPermitBridgeService({ ...base, executorPath: undefined }),
      { key: "ERR_PERMIT_INPUT_INVALID" });
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the bridge service refuses to open a store that does not exist", async () => {
  // A long-running service must not create the store as a side effect of
  // starting: the store's existence has to be an explicit decision, and a
  // restart must never carry that side effect.
  const dirs = tempDirs();
  try {
    await assert.rejects(startPermitBridgeService({
      storePath: dirs.storePath,
      anchorDir: dirs.anchorDir,
      decisionId: "test-decision",
      executorPath: EXECUTOR,
      create: false,
      leaseTtlMs: LEASE_TTL_MS,
      permitTtlMs: PERMIT_TTL_MS,
      anchorMode: "permissive",
    }));
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the bridge service opens a provisioned store bound to its decision", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const dirs = tempDirs();
  let service;
  try {
    const provisioned = ProtectedPermitStore.initialize(dirs.storePath, {
      anchorDir: dirs.anchorDir,
      anchorMode: "permissive",
      decisionId: "test-decision",
    });
    provisioned.close();
    service = await startService(dirs, { create: false });
    assert.ok(service.address.port > 0);
    assert.ok(service.revocationAddress.port > 0);
  } finally {
    if (service) await service.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the bridge service refuses a provisioned store bound to another decision", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const dirs = tempDirs();
  try {
    const provisioned = ProtectedPermitStore.initialize(dirs.storePath, {
      anchorDir: dirs.anchorDir,
      anchorMode: "permissive",
      decisionId: "different-decision",
    });
    provisioned.close();
    await assert.rejects(startService(dirs, { create: false }),
      { code: "ERR_DECISION_MISMATCH" });
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("the bridge service close is idempotent", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const dirs = tempDirs();
  let service;
  try {
    service = await startService(dirs);
    const first = service.close();
    const second = service.close();
    assert.equal(first, second, "concurrent close must share one promise");
    await first;
    await service.close();
  } finally {
    if (service) await service.close().catch(() => {});
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("a bridge start failure releases the store it opened", {
  skip: process.platform === "win32" || Number(process.versions.node.split(".")[0]) < 24,
  timeout: 60000,
}, async () => {
  const dirs = tempDirs();
  try {
    await assert.rejects(startService(dirs, {
      executorPath: path.join(dirs.root, "missing-executor.js"),
    }));
    // If the failed start leaked the store's lock this open would fail.
    const reopened = ProtectedPermitStore.open(dirs.storePath, {
      decisionId: "test-decision",
      anchorDir: dirs.anchorDir,
      anchorMode: "permissive",
      expectedDecisionId: "test-decision",
      minimumEpoch: 1,
    });
    reopened.close();
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
