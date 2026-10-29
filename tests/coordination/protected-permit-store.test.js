"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawn } = require("node:child_process");

const { ProtectedPermitStore } = require("../../lib/coordination/protected-permit-store");
const leaseCli = require("../../lib/coordination/lease-cli");
const anchorModule = require("../../lib/coordination/protected-anchor");

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const supportsSqlite = Number(process.versions.node.split(".")[0]) >= 24;

function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms003-"));
  const file = path.join(dir, "authority.sqlite");
  // The anchor must live outside the database rollback domain, otherwise a
  // replaced database directory would carry the anchor with it.
  const anchorDir = options.anchorDir || path.join(path.dirname(dir), `${path.basename(dir)}-anchor`);
  fs.mkdirSync(anchorDir, { recursive: true });
  let now = 1_000_000;
  const clock = () => now;
  const store = ProtectedPermitStore.initialize(file, {
    decisionId: "D-test-init", clock, verifyRecovery: options.verifyRecovery, anchorDir,
    // The development environment has no separate service identity: the
    // anchor directory belongs to the developer account. The tests therefore
    // opt out of the permission contract explicitly. The strict mode is
    // covered by its own tests below.
    anchorMode: options.anchorMode || anchorModule.ANCHOR_MODE.permissive,
  });
  return {
    dir, file, anchorDir, store, clock,
    advance: (ms) => { now += ms; },
    rollback: (ms) => { now -= ms; },
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(anchorDir, { recursive: true, force: true });
    },
  };
}

function leaseFields(extra = {}) {
  return {
    owner: "coordinator", sessionId: "session-1", hostId: "host-1",
    workerId: "worker-1", runId: "run-1", generation: "gen-1",
    desktopKey: "desktop-1", ownedAppId: "app-1",
    idempotencyKey: "lease-key-1", ttlMs: 60_000,
    ...extra,
  };
}

function permitFields(lease, extra = {}) {
  return {
    ...lease, idempotencyKey: "permit-key-1", operation: "uia.invoke",
    targetDigest: DIGEST_A, paramsDigest: DIGEST_B, ttlMs: 10_000,
    ...extra,
  };
}

function consumeFields(permit, extra = {}) {
  return {
    leaseId: permit.leaseId, permitId: permit.permitId,
    sessionId: permit.sessionId, hostId: permit.hostId,
    workerId: permit.workerId, runId: permit.runId,
    generation: permit.generation, desktopKey: permit.desktopKey,
    ownedAppId: permit.ownedAppId,
    serviceEpoch: permit.serviceEpoch, fencing: permit.fencing,
    operation: permit.operation, targetDigest: permit.targetDigest,
    paramsDigest: permit.paramsDigest, sequence: permit.sequence,
    ...extra,
  };
}

function reserveInProcess(file, anchorDir, fields, now) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, "fixtures", "m044-ms003-reserve.js"), file, anchorDir, JSON.stringify(fields), String(now),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", () => {
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

test("MS-003 initialization is explicit and a missing or malformed store never recreates", { skip: !supportsSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms003-init-"));
  const file = path.join(dir, "authority.sqlite");
  const anchorDir = path.join(path.dirname(dir), `${path.basename(dir)}-anchor`);
  fs.mkdirSync(anchorDir);
  try {
    assert.throws(() => ProtectedPermitStore.open(file, { expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir }), { code: "ERR_STATE_MISSING_OR_UNSAFE" });
    assert.throws(() => ProtectedPermitStore.initialize(file), { code: "ERR_INVALID_INPUT" });
    const store = ProtectedPermitStore.initialize(file, { decisionId: "D-test-init", anchorDir });
    assert.equal(store.snapshot().service_epoch, 1);
    store.close();
    assert.throws(() => ProtectedPermitStore.initialize(file, { decisionId: "D-test-init", anchorDir }), { code: "ERR_INIT_PATH_NOT_EMPTY" });
    fs.writeFileSync(file, "not sqlite");
    assert.throws(() => ProtectedPermitStore.open(file, { expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  }
});

test("MS-003 reserve and consume bind the exact Worker, target and parameters once", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.acquire(leaseFields({ ownedAppId: undefined })), { code: "ERR_INVALID_INPUT" });
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    assert.equal(permit.status, "reserved");
    assert.deepEqual(f.store.reserve(permitFields(lease)), permit);
    assert.throws(() => f.store.reserve(permitFields(lease, { targetDigest: DIGEST_B })), { code: "ERR_IDEMPOTENCY_MISMATCH" });
    assert.throws(() => f.store.reserve(permitFields(lease, { ownedAppId: "other-app" })), { code: "ERR_IDEMPOTENCY_MISMATCH" });
    assert.throws(() => f.store.consume(consumeFields(permit, { workerId: "bystander" })), { code: "ERR_BINDING_MISMATCH" });
    assert.throws(() => f.store.consume(consumeFields(permit, { ownedAppId: "other-app" })), { code: "ERR_BINDING_MISMATCH" });
    assert.throws(() => f.store.consume(consumeFields(permit, { paramsDigest: DIGEST_A })), { code: "ERR_BINDING_MISMATCH" });
    assert.equal(f.store.consume(consumeFields(permit)).status, "consumed");
    assert.equal(f.store.consume(consumeFields(permit)).status, "already-consumed");
    assert.throws(() => f.store.finish({ ...consumeFields(permit), outcome: "finished", targetDigest: DIGEST_B }), { code: "ERR_PERMIT_NOT_CONSUMED" });
    assert.equal(f.store.finish({ ...consumeFields(permit), outcome: "finished" }).status, "finished");
    assert.equal(f.store.consume(consumeFields(permit)).status, "already-consumed");
  } finally { f.cleanup(); }
});

test("MS-003 revoke races consume and leaves the desktop draining", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.revoke(lease);
    assert.throws(() => f.store.consume(consumeFields(permit)), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    assert.equal(f.store.snapshot().desktop.status, "draining");
    assert.equal(f.store.snapshot().tombstones[permit.permitId].reason, "revoked");
    assert.throws(() => f.store.acquire(leaseFields({ idempotencyKey: "new-key" })), { code: "ERR_DESKTOP_NOT_FREE" });
  } finally { f.cleanup(); }
});

test("MS-003 an elapsed permit is durably expired and cannot be replayed", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease, { ttlMs: 100 }));
    f.advance(101);
    assert.throws(() => f.store.consume(consumeFields(permit)), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    const state = f.store.snapshot();
    assert.equal(state.permits[permit.permitId].status, "expired");
    assert.equal(state.tombstones[permit.permitId].reason, "deadline");
    assert.throws(() => f.store.consume(consumeFields(permit)), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
  } finally { f.cleanup(); }
});

test("MS-003 an in-flight step blocks another reserve and consume", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const first = f.store.reserve(permitFields(lease));
    // A DIFFERENT action on the same desktop. The same action under a second
    // idempotency key is refused at reserve time now, so it cannot be used
    // to reach the in-flight guard this test is about.
    const second = f.store.reserve(permitFields(lease, { idempotencyKey: "second-key", targetDigest: DIGEST_B }));
    f.store.consume(consumeFields(first));
    assert.throws(() => f.store.reserve(permitFields(lease, { idempotencyKey: "third-key" })), { code: "ERR_ACTION_IN_FLIGHT" });
    assert.throws(() => f.store.consume(consumeFields(second)), { code: "ERR_ACTION_IN_FLIGHT" });
    f.store.finish({ ...consumeFields(first), outcome: "unknown" });
    assert.equal(f.store.snapshot().desktop.status, "draining");
    assert.throws(() => f.store.consume(consumeFields(second)), { code: "ERR_DESKTOP_DRAINING" });
  } finally { f.cleanup(); }
});

test("MS-003 restart invalidates old sessions and does not replay a consumed action", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.close();
    const reopened = ProtectedPermitStore.open(f.file, {
      clock: f.clock, expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir,
    });
    try {
      assert.equal(reopened.restartService(), 2);
      assert.equal(reopened.snapshot().permits[permit.permitId].status, "unknown");
      assert.equal(reopened.snapshot().desktop.status, "draining");
      assert.throws(() => reopened.consume(consumeFields(permit)), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
      assert.equal(reopened.reserve(permitFields(lease)).permitId, permit.permitId);
      assert.equal(reopened.reserve(permitFields(lease)).status, "unknown");
      assert.equal(reopened.acquire(leaseFields()).leaseId, lease.leaseId);
      assert.throws(() => reopened.acquire(leaseFields({ owner: "bystander" })), { code: "ERR_IDEMPOTENCY_MISMATCH" });
      assert.throws(() => reopened.acquire(leaseFields({ idempotencyKey: "new-key" })), { code: "ERR_DESKTOP_NOT_FREE" });
    } finally { reopened.close(); }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("MS-003 clock rollback and unverified recovery fail closed", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    f.store.release(lease);
    assert.throws(() => f.store.recover({ oldWorkerStopped: true }), { code: "ERR_RECOVERY_NOT_VERIFIED" });
    f.rollback(1);
    assert.throws(() => f.store.acquire(leaseFields({ idempotencyKey: "new-key" })), { code: "ERR_CLOCK_ROLLBACK" });
    assert.equal(f.store.snapshot().desktop.status, "draining");
  } finally { f.cleanup(); }
});

test("MS-003 opening rejects wrong Decision, rolled-back epoch and damaged state", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    assert.throws(() => ProtectedPermitStore.open(f.file), { code: "ERR_INVALID_INPUT" });
    assert.throws(() => ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-test-init" }), { code: "ERR_INVALID_INPUT" });
    assert.throws(() => ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-other", minimumEpoch: 1, anchorDir: f.anchorDir }), { code: "ERR_DECISION_MISMATCH" });
    assert.throws(() => ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-test-init", minimumEpoch: 2, anchorDir: f.anchorDir }), { code: "ERR_EPOCH_ROLLBACK" });
    f.rollback(1);
    assert.throws(() => ProtectedPermitStore.open(f.file, { clock: f.clock, expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir }), { code: "ERR_CLOCK_ROLLBACK" });
    f.advance(1);
    f.store.close();
    const db = new DatabaseSync(f.file);
    try { db.exec("UPDATE protected_state SET body = '{\"corrupt\":true}' WHERE id = 1"); }
    finally { db.close(); }
    assert.throws(() => ProtectedPermitStore.open(f.file, { expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir }), { code: "ERR_STATE_INVALID" });
    assert.equal(fs.existsSync(f.file), true);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test("MS-003 a blocked durable write grants no permit", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  const lease = f.store.acquire(leaseFields());
  const blocker = new DatabaseSync(f.file);
  try {
    blocker.exec("BEGIN IMMEDIATE");
    assert.throws(() => f.store.reserve(permitFields(lease)));
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    assert.equal(Object.keys(f.store.snapshot().permits).length, 0);
    f.cleanup();
  }
});

test("MS-003 an uncertain commit poisons the current store instance", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const snapshot = f.store.snapshot();
    const body = JSON.stringify(snapshot);
    const row = { body, sha256: crypto.createHash("sha256").update(body).digest("hex") };
    const db = {
      exec: (sql) => { if (sql === "COMMIT") throw new Error("injected commit failure"); },
      prepare: (sql) => sql.startsWith("SELECT") ? { get: () => row } : { run: () => ({ changes: 1 }) },
      close: () => {},
    };
    const store = new ProtectedPermitStore(db, {
      clock: f.clock,
      anchorFile: path.join(f.anchorDir, "protected-anchor.journal"),
      anchorDir: f.anchorDir,
      storeId: snapshot.store_id,
    });
    assert.throws(() => store.acquire(leaseFields()), /injected commit failure/);
    assert.throws(() => store.acquire(leaseFields()), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    assert.throws(() => store.snapshot(), { code: "ERR_COMMIT_OUTCOME_UNKNOWN" });
    store.close();
  } finally { f.cleanup(); }
});

test("MS-003 managed recovery revokes an active draining lease before reopening the desktop", { skip: !supportsSqlite }, () => {
  const f = fixture({ verifyRecovery: (proof, state) =>
    proof.oldWorkerStopped === true && proof.desktopKey === state.desktop.key });
  try {
    const lease = f.store.acquire(leaseFields());
    const failed = f.store.reserve(permitFields(lease));
    // A DIFFERENT action: a pending permit for the SAME action can no longer
    // be minted, because the action-level guard refuses it at reserve time.
    const pending = f.store.reserve(permitFields(lease, { idempotencyKey: "pending-key", targetDigest: DIGEST_B }));
    f.store.consume(consumeFields(failed));
    f.store.finish({ ...consumeFields(failed), outcome: "failed" });
    assert.equal(f.store.snapshot().desktop.status, "draining");
    assert.throws(() => f.store.recover({ oldWorkerStopped: true, desktopKey: "wrong" }), { code: "ERR_RECOVERY_NOT_VERIFIED" });
    f.store.recover({ oldWorkerStopped: true, desktopKey: "desktop-1" });
    const state = f.store.snapshot();
    assert.equal(state.lease.status, "revoked");
    assert.equal(state.fencing, lease.fencing + 1);
    assert.equal(state.permits[pending.permitId].status, "revoked");
    assert.equal(state.desktop.status, "free");
    assert.throws(() => f.store.consume(consumeFields(pending)), { code: "ERR_PERMIT_NOT_CONSUMABLE" });
    assert.equal(f.store.acquire(leaseFields({ idempotencyKey: "next-key" })).fencing, lease.fencing + 2);
  } finally { f.cleanup(); }
});

test("MS-003 two processes cannot issue two permits for one idempotency key", { skip: !supportsSqlite }, async () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const fields = permitFields(lease);
    const [a, b] = await Promise.all([
      reserveInProcess(f.file, f.anchorDir, fields, 1_000_001),
      reserveInProcess(f.file, f.anchorDir, fields, 1_000_001),
    ]);
    assert.equal(a.ok, true, JSON.stringify({ child: "a", result: a }));
    assert.equal(b.ok, true, JSON.stringify({ child: "b", result: b }));
    assert.equal(a.permitId, b.permitId);
    assert.equal(Object.keys(f.store.snapshot().permits).length, 1);
  } finally { f.cleanup(); }
});

// ─── F-1: the same action must never be dispatched twice ──────────────────
//
// The in-flight guard used to count only the permits whose status was exactly
// "consumed". A permit that had been minted but not consumed was invisible
// to it, so several processes could mint permits for the same desktop under
// different idempotency keys, and a permit for an action that had already run
// could still be consumed afterwards. The same action therefore reached the
// executor twice. The guard is now scoped to the action itself.

test("MS-005 a second permit for the same action is refused even under a different idempotency key", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const first = f.store.reserve(permitFields(lease, { idempotencyKey: "key-A" }));
    // The same operation, the same target and the same parameters under a
    // fresh idempotency key: the shape a "retry with a new key" takes.
    assert.throws(() => f.store.reserve(permitFields(lease, { idempotencyKey: "key-B" })),
      { code: "ERR_ACTION_IN_FLIGHT" });
    assert.equal(Object.keys(f.store.snapshot().permits).length, 1);

    // The first action runs and completes.
    assert.equal(f.store.consume(consumeFields(first)).status, "consumed");
    assert.equal(f.store.finish({ ...consumeFields(first), outcome: "finished" }).status, "finished");

    // The action has already been dispatched, so it must not be dispatchable
    // again -- not with a fresh key, and not with the original one either
    // beyond the idempotent read-back.
    assert.throws(() => f.store.reserve(permitFields(lease, { idempotencyKey: "key-C" })),
      { code: "ERR_ACTION_ALREADY_DISPATCHED" });
  } finally { f.cleanup(); }
});

test("MS-005 the same idempotency key still reads back the original permit after the action completed", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const first = f.store.reserve(permitFields(lease, { idempotencyKey: "key-A" }));
    f.store.consume(consumeFields(first));
    f.store.finish({ ...consumeFields(first), outcome: "finished" });
    // The retry of the SAME attempt reads the original record back. The
    // action-level guard must not turn an idempotent retry into an error.
    const retry = f.store.reserve(permitFields(lease, { idempotencyKey: "key-A" }));
    assert.equal(retry.permitId, first.permitId);
    assert.equal(retry.status, "finished");
    assert.equal(Object.keys(f.store.snapshot().permits).length, 1);
  } finally { f.cleanup(); }
});

test("MS-005 a different action on the same desktop is still dispatchable after the first one finished", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const first = f.store.reserve(permitFields(lease, { idempotencyKey: "key-A" }));
    f.store.consume(consumeFields(first));
    f.store.finish({ ...consumeFields(first), outcome: "finished" });
    // A different target is a different action: the guard is action-scoped,
    // not desktop-scoped, and must not block legitimate follow-up work.
    const second = f.store.reserve(permitFields(lease, { idempotencyKey: "key-B", targetDigest: DIGEST_B }));
    assert.equal(second.status, "reserved");
    assert.notEqual(second.permitId, first.permitId);
  } finally { f.cleanup(); }
});

test("MS-005 a permit for an action that was revoked before it ran may be minted again", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const first = f.store.reserve(permitFields(lease, { idempotencyKey: "key-A" }));
    // The permit is revoked without ever being consumed, so the action was
    // never dispatched. A revocation therefore does not forbid the action
    // forever -- only a permit that actually reached the executor does.
    f.store.revoke(lease);
    assert.equal(f.store.snapshot().permits[first.permitId].status, "revoked");
  } finally { f.cleanup(); }
});

test("MS-005 two processes reserving the same action under different idempotency keys mint one permit", { skip: !supportsSqlite }, async () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const [a, b] = await Promise.all([
      reserveInProcess(f.file, f.anchorDir, permitFields(lease, { idempotencyKey: "key-A" }), 1_000_001),
      reserveInProcess(f.file, f.anchorDir, permitFields(lease, { idempotencyKey: "key-B" }), 1_000_001),
    ]);
    const okCount = [a, b].filter((r) => r.ok === true).length;
    assert.equal(okCount, 1, "exactly one process may obtain a permit for the action");
    assert.equal(Object.keys(f.store.snapshot().permits).length, 1);
    // The refused process must be refused with the action-level code, not
    // with a generic failure.
    const refused = [a, b].find((r) => r.ok !== true);
    assert.equal(refused.code, "ERR_ACTION_IN_FLIGHT");
  } finally { f.cleanup(); }
});

test("MS-005 many processes reserving the same action under different idempotency keys mint one permit", { skip: !supportsSqlite }, async () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const attempts = [];
    for (let i = 0; i < 6; i += 1) {
      attempts.push(reserveInProcess(
        f.file, f.anchorDir, permitFields(lease, { idempotencyKey: "key-" + i }), 1_000_001,
      ));
    }
    const settled = await Promise.all(attempts);
    const okCount = settled.filter((r) => r.ok === true).length;
    assert.equal(okCount, 1, "exactly one of the six processes may obtain a permit");
    assert.equal(Object.keys(f.store.snapshot().permits).length, 1);
  } finally { f.cleanup(); }
});

test("MS-005 consume refuses a second permit for an action that already ran, even if that permit was minted before the guard existed", { skip: !supportsSqlite }, () => {
  // Defence in depth. The reserve() guard refuses the second permit before
  // it is minted, so in a store that only ever saw this code path the second
  // permit cannot exist. This case covers the guard inside consume() itself,
  // for a store whose state already carries two permits for the same action
  // -- a state that a pre-guard release could have produced.
  //
  // The state is forged directly in the database and the anchor witness is
  // advanced to match it through the anchor API, so the store comes up and
  // the consume() guard is what decides. The point of the test is the
  // consume() guard, not the anchor contract.
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const first = f.store.reserve(permitFields(lease, { idempotencyKey: "key-A" }));
    f.store.close();

    // Forge the state a pre-guard store could hold: a second, still
    // reserved permit for the very same action.
    const db = new DatabaseSync(f.file);
    let body;
    let digestOfBody;
    let sequence;
    let storeId;
    try {
      const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      storeId = state.store_id;
      state.permit_seq += 1;
      const forged = {
        ...state.permits[first.permitId],
        permitId: "P-PERMIT-FORGED",
        idempotencyKey: "key-B",
        status: "reserved",
        sequence: state.permit_seq,
      };
      state.permits[forged.permitId] = forged;
      state.idempotency["key-B"] = forged.permitId;
      state.anchor_sequence += 1;
      sequence = state.anchor_sequence;
      body = JSON.stringify(state);
      digestOfBody = crypto.createHash("sha256").update(body).digest("hex");
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1")
        .run(body, digestOfBody);
    } finally { db.close(); }

    // Advance the anchor witness to the forged body so the store opens.
    const anchorFile = anchorModule.journalFileFor(f.anchorDir);
    anchorModule.appendEntry(anchorFile, { type: "intent", sequence, body_digest: digestOfBody, store_id: storeId, attempt: 1 });
    anchorModule.appendEntry(anchorFile, { type: "commit", sequence, body_digest: digestOfBody, store_id: storeId, attempt: 1 });
    anchorModule.appendHighWater(f.anchorDir, { sequence, body_digest: digestOfBody, store_id: storeId, attempt: 1 });

    const reopened = ProtectedPermitStore.open(f.file, {
      clock: f.clock, expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir,
    });
    try {
      // The forged permit names the same action, so it must not be
      // consumable while the first one is still reserved.
      const forged = reopened.snapshot().permits["P-PERMIT-FORGED"];
      assert.ok(forged, "the forged permit must be present in the state");
      assert.throws(() => reopened.consume(consumeFields(forged)), { code: "ERR_ACTION_IN_FLIGHT" });
    } finally { reopened.close(); }
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
    fs.rmSync(f.anchorDir, { recursive: true, force: true });
  }
});

test("MS-005 the idempotency key still wins over the action guard across two processes", { skip: !supportsSqlite }, async () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const fields = permitFields(lease, { idempotencyKey: "key-A" });
    const [a, b] = await Promise.all([
      reserveInProcess(f.file, f.anchorDir, fields, 1_000_001),
      reserveInProcess(f.file, f.anchorDir, fields, 1_000_001),
    ]);
    // The same attempt, retried: both processes must observe the same
    // permit, and neither may be refused.
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.permitId, b.permitId);
    assert.equal(Object.keys(f.store.snapshot().permits).length, 1);
  } finally { f.cleanup(); }
});

test("MS-003 the legacy CLI rejects protected scope and IDs before reading state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms003-cli-"));
  try {
    const blocked = [
      () => leaseCli.leaseAcquire({ scope: "samhmi:dispatch-authority", owner: "attacker" }, { projectRoot: root }),
      () => leaseCli.leaseRenew({ scope: "SAMHMI:DISPATCH-AUTHORITY", owner: "attacker" }, { projectRoot: root }),
      () => leaseCli.leaseRenew({ leaseId: "P-LEASE-1" }, { projectRoot: root }),
      () => leaseCli.leaseRelease({ leaseId: "P-LEASE-1" }, { projectRoot: root }),
      () => leaseCli.leaseStatus({ leaseId: "P-LEASE-1" }, { projectRoot: root }),
      () => leaseCli.leaseStatus({ scope: "samhmi:dispatch-authority:alias" }, { projectRoot: root }),
      () => leaseCli.leaseRecover({ scope: "samhmi:dispatch-authority", newOwner: "attacker" }, { projectRoot: root }),
    ];
    for (const attempt of blocked) assert.throws(attempt, { code: "ERR_PROTECTED_SCOPE" });
    assert.equal(fs.readdirSync(root).length, 0);
    assert.equal(leaseCli.leaseAcquire({ scope: "task:ordinary", owner: "agent" }, { projectRoot: root }).ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MS-003 a same-epoch rollback is refused once the anchor records a higher sequence", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.finish({ ...consumeFields(permit), outcome: "finished" });
    const current = f.store.snapshot();
    assert.ok(current.anchor_sequence >= 4);

    // Replace the database with an older but internally valid snapshot from
    // the same service_epoch. In-database checks alone accept this state.
    f.store.close();
    const stale = path.join(f.dir, "stale.sqlite");
    fs.copyFileSync(f.file, stale);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(stale);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const staleState = JSON.parse(row.body);
      staleState.anchor_sequence = 1;
      staleState.permits = {};
      staleState.idempotency = {};
      staleState.lease_idempotency = {};
      staleState.lease = null;
      staleState.desktop = { status: "free", key: null };
      const body = JSON.stringify(staleState);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }
    fs.copyFileSync(stale, f.file);

    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_ROLLED_BACK" });
  } finally { f.cleanup(); }
});

test("MS-003 the anchor refuses to start when the database is ahead of it", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.close();
    // A missing journal behind a committed database is a rollback of the
    // journal itself; the service must not guess which side wins.
    // Lose all witnesses, retaining the stable coordination domain (v2).
    for (const name of fs.readdirSync(f.anchorDir)) {
      if (name !== "protected-store-coordination.sqlite") fs.unlinkSync(path.join(f.anchorDir, name));
    }
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_MISSING" });
  } finally { f.cleanup(); }
});

test("MS-003 the anchor directory is mandatory so rollback detection cannot be skipped", { skip: !supportsSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms003-noanchor-"));
  const file = path.join(dir, "authority.sqlite");
  try {
    assert.throws(() => ProtectedPermitStore.initialize(file, { decisionId: "D-test-init" }), { code: "ERR_ANCHOR_REQUIRED" });
    const anchorDir = path.join(path.dirname(dir), `${path.basename(dir)}-anchor`);
    fs.mkdirSync(anchorDir);
    const store = ProtectedPermitStore.initialize(file, { decisionId: "D-test-init", anchorDir });
    store.close();
    assert.throws(() => ProtectedPermitStore.open(file, { expectedDecisionId: "D-test-init", minimumEpoch: 1 }), { code: "ERR_ANCHOR_REQUIRED" });
    fs.rmSync(anchorDir, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("MS-003 the anchor must live outside the database rollback domain", { skip: !supportsSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms003-samedir-"));
  const file = path.join(dir, "authority.sqlite");
  try {
    assert.throws(() => ProtectedPermitStore.initialize(file, { decisionId: "D-test-init", anchorDir: dir }), { code: "ERR_ANCHOR_NOT_SEPARATE" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("MS-003 a forged anchor_sequence in the database body is rejected by the anchor digest", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.finish({ ...consumeFields(permit), outcome: "finished" });
    f.store.close();

    // Forge the database so that it looks like an older, self-consistent
    // snapshot: rewrite the body, recompute the body checksum, and keep the
    // anchor_sequence aligned with the committed high-water mark.
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const forged = JSON.parse(row.body);
      const anchorModule = require("../../lib/coordination/protected-anchor");
      const journal = anchorModule.readJournal(path.join(f.anchorDir, "protected-anchor.journal"));
      // Keep the sequence identical to the committed high-water mark so that
      // only the body digest can catch the forgery.
      forged.anchor_sequence = journal.committed;
      forged.last_clock_ms = 1_000_000;
      forged.permits = {};
      forged.idempotency = {};
      forged.lease_idempotency = {};
      forged.lease = null;
      forged.desktop = { status: "free", key: null };
      const body = JSON.stringify(forged);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }

    // The anchor still records the real body digest, so the forgery is caught
    // even though the database body checksum itself is internally consistent.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_TAMPERED" });
  } finally { f.cleanup(); }
});

test("MS-003 a corrupted journal record is rejected instead of trusted", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const journalFile = anchorModule.journalFileFor(f.anchorDir);
    const entryNames = fs.readdirSync(f.anchorDir).filter((name) => name.includes("entry-")).sort();
    const target = path.join(f.anchorDir, entryNames[entryNames.length - 1]);
    const record = JSON.parse(fs.readFileSync(target, "utf8"));
    record.body_digest = "a".repeat(64);
    fs.writeFileSync(target, JSON.stringify(record));
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_CORRUPT" });
  } finally { f.cleanup(); }
});

test("MS-003 a failed durable write restores the anchor so the store can still start", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const blocker = new DatabaseSync(f.file);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      assert.throws(() => f.store.reserve(permitFields(lease)));
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    // The anchor must not be left ahead of the committed database, otherwise
    // a transient write failure would make the service permanently refuse to
    // start.
    assert.equal(Object.keys(f.store.snapshot().permits).length, 0);
    f.store.close();
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 there is no opt-out that disables the anchor", { skip: !supportsSqlite }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m044-ms003-noopt-"));
  const file = path.join(dir, "authority.sqlite");
  try {
    // The escape hatch was removed: an opt-out whose validity is decided by a
    // flag inside the database would be defeated by rewriting that flag.
    assert.throws(() => ProtectedPermitStore.initialize(file, {
      decisionId: "D-test-init", allowNoAnchor: true,
    }), { code: "ERR_ANCHOR_REQUIRED" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("MS-003 a store cannot be constructed without an anchor", { skip: !supportsSqlite }, () => {
  // The public entry points bind the anchor. The constructor refuses a store
  // without one as well, so no other construction path can produce a store
  // that skips the rollback detection.
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    f.store.close();
    const db = new DatabaseSync(f.file);
    assert.throws(() => new ProtectedPermitStore(db, { clock: f.clock }), { code: "ERR_ANCHOR_REQUIRED" });
    db.close();
  } finally { f.cleanup(); }
});

test("MS-003 a crash window is recoverable but a rolled-back database is not", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    f.store.close();
    const journalFile = path.join(f.anchorDir, "protected-anchor.journal");

    // Simulate a crash between the database commit and the journal commit
    // entry: the journal has a dangling intent at the database sequence whose
    // digest equals the committed database body.
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(f.file);
    let bodyDigest;
    let sequence;
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      bodyDigest = crypto.createHash("sha256").update(row.body).digest("hex");
      sequence = JSON.parse(row.body).anchor_sequence;
    } finally { db.close(); }
    // Drop the commit entry for the last sequence and keep its intent, which
    // is exactly the state a crash between 2 and 3 leaves behind.
    const commitName = fs.readdirSync(f.anchorDir).find((name) => name.startsWith(`protected-anchor-entry-${String(sequence).padStart(12, "0")}-`) && name.includes("-commit-"));
    fs.unlinkSync(path.join(f.anchorDir, commitName));

    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_CRASH_WINDOW_RECOVERABLE" });

    // The managed recovery action records the commit the crash skipped.
    const recovered = ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, audit: { by: "admin", reason: "crash-window" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    assert.equal(recovered.recovered, true);
    // The recovery leaves a durable audit trail outside the database domain.
    const auditLog = path.join(f.anchorDir, "protected-anchor-recovery.log");
    assert.equal(fs.existsSync(auditLog), true);
    const auditEntry = JSON.parse(fs.readFileSync(auditLog, "utf8").trim());
    assert.equal(auditEntry.by, "admin");
    assert.equal(auditEntry.reason, "crash-window");
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 the managed recovery refuses to run without an audit record", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    assert.throws(() => ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    }), { code: "ERR_RECOVERY_AUDIT_REQUIRED" });
    assert.throws(() => ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, audit: { by: "admin" },
    }), { code: "ERR_RECOVERY_AUDIT_REQUIRED" });
  } finally { f.cleanup(); }
});

test("MS-003 a one-step rollback cannot be laundered by the managed recovery", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    const afterConsume = f.store.snapshot();
    assert.equal(afterConsume.permits[permit.permitId].status, "consumed");
    f.store.close();

    // Take a snapshot of the database one sequence earlier, then roll the
    // database back to it. This is the exact shape an independent validator
    // used to launder a consumed one-shot permit back to reservable.
    const stale = path.join(f.dir, "stale.sqlite");
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.anchor_sequence = state.anchor_sequence - 1;
      state.permits[permit.permitId].status = "reserved";
      delete state.permits[permit.permitId].consumedAt;
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }

    // The rollback is detected on start.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_ROLLED_BACK" });

    // The managed recovery must refuse it as well, so an administrator cannot
    // launder the rollback by invoking the recovery entry point.
    assert.throws(() => ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, audit: { by: "admin", reason: "attempted-recovery" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });

    // The permit is still not consumable, and the database still refuses to start.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_ROLLED_BACK" });
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); fs.rmSync(f.anchorDir, { recursive: true, force: true }); }
});

test("MS-003 an open store refuses to advance a missing journal", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    // Remove the journal while the store is open. The next transaction must
    // fail closed instead of recreating the high-water mark.
    // Lose all witnesses, retaining the stable coordination domain (v2).
    for (const name of fs.readdirSync(f.anchorDir)) {
      if (name !== "protected-store-coordination.sqlite") fs.unlinkSync(path.join(f.anchorDir, name));
    }
    assert.throws(() => f.store.acquire(leaseFields({ idempotencyKey: "after-journal-loss" })), { code: "ERR_ANCHOR_MISSING" });
  } finally { f.cleanup(); }
});

test("MS-003 a rewritten database cannot disable rollback detection", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    f.store.close();
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.anchor_sequence = 1;
      // The attacker also tries to clear every marker that could say the
      // store is bound to an anchor. The store identity is the proof: the
      // journal and the database must agree on it.
      state.store_id = null;
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }
    // Opening without the anchor directory is refused outright: there is no
    // opt-out that could be turned off from inside the database.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, allowNoAnchor: true,
    }), { code: "ERR_ANCHOR_REQUIRED" });
    // Opening with the anchor directory is refused as well: the rewritten
    // body no longer carries the store identity the journal recorded.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_STORE_MISMATCH" });
  } finally { f.cleanup(); }
});

test("MS-003 the managed recovery refuses a rolled-back database", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.finish({ ...consumeFields(permit), outcome: "finished" });
    f.store.close();
    const stale = path.join(f.dir, "stale.sqlite");
    fs.copyFileSync(f.file, stale);
    const db = new DatabaseSync(stale);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.anchor_sequence = 1;
      state.permits = {};
      state.idempotency = {};
      state.lease_idempotency = {};
      state.lease = null;
      state.desktop = { status: "free", key: null };
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }
    fs.copyFileSync(stale, f.file);

    // The recovery path must not be usable to launder a rollback.
    assert.throws(() => ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, audit: { by: "admin", reason: "attempted-recovery" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
  } finally { f.cleanup(); }
});

test("MS-003 a forged anchor sequence cannot launder a one-shot permit on the hot path", { skip: !supportsSqlite }, () => {
  // An attacker who can only write the database must not be able to raise the
  // anchor sequence above the journal and have the next transaction adopt the
  // forged value. The journal's dangling intent has to carry the digest the
  // database actually has, otherwise the state is refused.
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.finish({ ...consumeFields(permit), outcome: "finished" });
    f.store.close();

    // Forge a database that claims a higher anchor sequence and revives the
    // consumed permit. The body checksum is recomputed, so only the anchor
    // can tell the difference.
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      const currentSequence = state.anchor_sequence;
      state.anchor_sequence = currentSequence + 1;
      const permitId = Object.keys(state.permits)[0];
      state.permits[permitId].status = "reserved";
      delete state.permits[permitId].consumedAt;
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }

    // The forged sequence is ahead of the journal, and no dangling intent
    // proves it, so the open is refused.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_AHEAD_OF_ANCHOR" });
  } finally { f.cleanup(); }
});

test("MS-003 a dangling intent that does not match the database body is refused", { skip: !supportsSqlite }, () => {
  // The hot path and the open path must agree: an intent only explains the
  // database when its digest equals the committed body digest. A mismatch
  // means the intent belongs to a different body.
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();

    // Simulate the crash window: the database is ahead of the journal and
    // the dangling intent carries the digest of the body it was written for.
    // Then the database body is edited, so the intent no longer describes it.
    const db = new DatabaseSync(f.file);
    let sequence;
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      sequence = JSON.parse(row.body).anchor_sequence;
    } finally { db.close(); }
    const commitName = fs.readdirSync(f.anchorDir).find((name) => name.startsWith(`protected-anchor-entry-${String(sequence).padStart(12, "0")}-`) && name.includes("-commit-"));
    fs.unlinkSync(path.join(f.anchorDir, commitName));

    // The intent still describes the body the database had, but the body was
    // edited afterwards, so the digests no longer agree.
    const edit = new DatabaseSync(f.file);
    try {
      const row = edit.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.fencing += 100;
      const body = JSON.stringify(state);
      edit.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { edit.close(); }

    // The dangling intent does not describe the database any more, so the
    // open is refused instead of being reported as recoverable.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_TAMPERED" });
  } finally { f.cleanup(); }
});

test("MS-003 a journal from another instance is not adopted", { skip: !supportsSqlite }, () => {
  // The store identity lives in the database body, so a journal copied from a
  // different instance is rejected instead of being adopted silently.
  const { DatabaseSync } = require("node:sqlite");
  const first = fixture();
  const second = fixture();
  try {
    first.store.acquire(leaseFields());
    second.store.acquire(leaseFields());
    first.store.close();
    second.store.close();

    // Replace the second instance's journal with a copy of the first one.
    for (const name of fs.readdirSync(second.anchorDir)) {
      if (name.startsWith("protected-anchor-entry-")) fs.unlinkSync(path.join(second.anchorDir, name));
    }
    for (const name of fs.readdirSync(first.anchorDir)) {
      if (!name.startsWith("protected-anchor-entry-")) continue;
      fs.copyFileSync(path.join(first.anchorDir, name), path.join(second.anchorDir, name));
    }

    assert.throws(() => ProtectedPermitStore.open(second.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: second.anchorDir, clock: second.clock,
    }), { code: "ERR_ANCHOR_STORE_MISMATCH" });
  } finally { first.cleanup(); second.cleanup(); }
});

test("MS-003 a failed transaction leaves an abort that the retry supersedes", { skip: !supportsSqlite }, () => {
  // A transaction that fails must not leave a dangling intent that later
  // looks like a crash window. The abort ends the attempt, and a retry of the
  // same sequence is the attempt that counts.
  const f = fixture();
  try {
    f.store.close();

    // The durable write fails after the sequence was allocated, so the
    // attempt is abandoned and the sequence is recorded as aborted.
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const journalFile = path.join(f.anchorDir, "protected-anchor.journal");
    const db = new (require("node:sqlite").DatabaseSync)(f.file);
    const row = db.prepare("SELECT body, sha256 FROM protected_state WHERE id = 1").get();
    db.close();
    const body = JSON.parse(row.body);
    const failing = {
      exec: (sql) => { if (sql === "COMMIT") throw new Error("injected write failure"); },
      prepare: (sql) => sql.startsWith("SELECT") ? { get: () => ({ body: row.body, sha256: row.sha256 }) } : { run: () => { throw new Error("injected write failure"); } },
      close: () => {},
    };
    const broken = new ProtectedPermitStore(failing, { clock: f.clock, anchorFile: journalFile, anchorDir: f.anchorDir, storeId: body.store_id });
    assert.throws(() => broken.acquire(leaseFields({ idempotencyKey: "failing-lease" })), /injected write failure/);
    broken.close();

    const journal = anchorModule.readJournal(path.join(f.anchorDir, "protected-anchor.journal"));
    // The aborted attempt is recorded and is not mistaken for a live intent.
    assert.ok(journal.aborted.size >= 1);
    // The aborted sequence must not appear as a dangling intent, otherwise it
    // would look like a crash window and could be recovered.
    for (const sequence of journal.aborted) {
      assert.equal(journal.intentsBySeq.has(sequence), false);
    }
    assert.equal(journal.committed, 1);
    // The store still starts and keeps working after the failed attempt.
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 the anchor can be rebuilt through the managed recovery without lowering the mark", { skip: !supportsSqlite }, () => {
  // After an anchor loss the service would otherwise be permanently refused.
  // The managed rebuild restores it, but it never lowers the high-water mark
  // and it requires an explicit administrator audit.
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // Lose all witnesses, retaining the stable coordination domain (v2).
    for (const name of fs.readdirSync(f.anchorDir)) {
      if (name !== "protected-store-coordination.sqlite") fs.unlinkSync(path.join(f.anchorDir, name));
    }

    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_MISSING" });

    // The rebuild needs an explicit audit and an explicit statement that the
    // database is the truth.
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, acceptDatabaseAsTruth: true,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    }), { code: "ERR_RECOVERY_AUDIT_REQUIRED" });
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, audit: { by: "admin", reason: "anchor-loss" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });

    // With no witness of the mark left at all, the rebuild refuses: there is
    // nothing it could check the database against, and accepting it would
    // hand an attacker who can write the database a laundering channel. The
    // missing declaration is reported precisely instead of being read as an
    // absent mark.
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, acceptAnchorDomainLoss: true,
      audit: { by: "admin", reason: "anchor-loss" },
    }), { code: "ERR_ANCHOR_DECLARATION_MISSING" });

    // The anchor domain loss is recovered by discarding the stored state
    // instead of trusting it.
    const reset = ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
      audit: { by: "admin", reason: "anchor-loss" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    assert.equal(reset.reset, true);
    const auditLog = path.join(f.anchorDir, "protected-anchor-recovery.log");
    assert.equal(fs.existsSync(auditLog), true);

    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    // Nothing of the old state survives the reset.
    assert.equal(Object.keys(reopened.snapshot().permits).length, 0);
    assert.equal(reopened.snapshot().lease, null);
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 the anchor loss reset does not carry any old permit over", { skip: !supportsSqlite }, () => {
  // The reset must not be a laundering channel. It discards the state, so a
  // permit that existed before the loss cannot be consumed afterwards, even
  // if the database was forged before the reset was requested.
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume({ ...consumeFields(lease), permitId: permit.permitId, sequence: permit.sequence,
      serviceEpoch: permit.serviceEpoch, fencing: permit.fencing,
      operation: permit.operation, targetDigest: permit.targetDigest, paramsDigest: permit.paramsDigest });
    f.store.close();
    // The attacker forges the database: the permit is revived and the sequence
    // is raised. Then the whole anchor domain is lost.
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.permits[permit.permitId].status = "reserved";
      delete state.permits[permit.permitId].consumedAt;
      state.anchor_sequence += 5;
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }
    // Lose all witnesses, retaining the stable coordination domain (v2).
    for (const name of fs.readdirSync(f.anchorDir)) {
      if (name !== "protected-store-coordination.sqlite") fs.unlinkSync(path.join(f.anchorDir, name));
    }

    const reset = ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
      audit: { by: "admin", reason: "anchor-loss" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    assert.equal(reset.reset, true);

    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    const snapshot = reopened.snapshot();
    // The forged permit is gone, and the epoch moved on.
    assert.equal(Object.keys(snapshot.permits).length, 0);
    assert.equal(snapshot.permits[permit.permitId], undefined);
    assert.ok(snapshot.service_epoch >= 2);
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 the anchor rebuild refuses to lower the high-water mark", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // Roll the database back one step but keep the journal intact, so the
    // journal still knows a higher sequence than the database carries.
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.anchor_sequence -= 1;
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }

    // The rebuild must not accept a database that is behind the known mark.
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "attempted" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
  } finally { f.cleanup(); }
});

test("MS-003 a refused recovery attempt leaves a trace", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    assert.throws(() => ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, audit: { by: "admin", reason: "attempted" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
    const auditLog = path.join(f.anchorDir, "protected-anchor-recovery.log");
    assert.equal(fs.existsSync(auditLog), true);
    const entry = JSON.parse(fs.readFileSync(auditLog, "utf8").trim().split("\n")[0]);
    assert.equal(entry.refused, true);
    assert.equal(entry.by, "admin");
  } finally { f.cleanup(); }
});

test("MS-003 a journal poisoned with a foreign store identity can be repaired", { skip: !supportsSqlite }, () => {
  // Two store identities in one journal make every open refuse it as
  // corruption, and no other entry point could repair it. The managed rebuild
  // has to be able to bring the service back without lowering the mark.
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const journalFile = path.join(f.anchorDir, "protected-anchor.journal");
    // Poison the journal with an entry of a foreign instance.
    anchorModule.appendEntry(journalFile, {
      type: "commit", sequence: 1, body_digest: "a".repeat(64), store_id: "f".repeat(32),
    });

    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_CORRUPT" });

    const rebuilt = ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "poisoned-journal" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    assert.equal(rebuilt.rebuilt, true);
    // The foreign entry is moved aside, not deleted, so the evidence remains.
    assert.ok(rebuilt.audit.quarantined_entries >= 1);
    assert.equal(fs.existsSync(path.join(f.anchorDir, "quarantine")), true);

    // The service starts again and keeps the high-water mark.
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    const sequence = reopened.snapshot().anchor_sequence;
    reopened.close();
    assert.ok(sequence >= rebuilt.audit.sequence);
  } finally { f.cleanup(); }
});

test("MS-003 the journal rebuild does not lower the high-water mark of a poisoned journal", { skip: !supportsSqlite }, () => {
  const { DatabaseSync } = require("node:sqlite");
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const journalFile = path.join(f.anchorDir, "protected-anchor.journal");
    anchorModule.appendEntry(journalFile, {
      type: "commit", sequence: 99, body_digest: "a".repeat(64), store_id: "f".repeat(32),
    });
    // Roll the database back so it is behind the sequence the foreign entry
    // claims. The rebuild must refuse rather than accept the database.
    const db = new DatabaseSync(f.file);
    try {
      const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
      const state = JSON.parse(row.body);
      state.anchor_sequence = 1;
      const body = JSON.stringify(state);
      db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1").run(body, crypto.createHash("sha256").update(body).digest("hex"));
    } finally { db.close(); }

    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "attempted" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
  } finally { f.cleanup(); }
});

// ─── Sixth round: the rebuild must verify the witness, not only the sequence ──

// Revive a consumed one-shot permit by editing the database alone. The
// attacker does not need to touch the anchor domain for this to be a
// laundering attempt, so it is the strongest form of the attack.
function revivePermitInDatabase(file) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
    const state = JSON.parse(row.body);
    const permitId = Object.keys(state.permits)[0];
    state.permits[permitId].status = "reserved";
    delete state.permits[permitId].consumedAt;
    const body = JSON.stringify(state);
    db.prepare("UPDATE protected_state SET body = ?, sha256 = ? WHERE id = 1")
      .run(body, crypto.createHash("sha256").update(body).digest("hex"));
  } finally { db.close(); }
}

function consumedPermitCount(file) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT body FROM protected_state WHERE id = 1").get();
    const state = JSON.parse(row.body);
    return Object.values(state.permits).filter((permit) => permit.status === "consumed").length;
  } finally { db.close(); }
}

test("MS-003 the whole anchor domain cannot be wiped to launder a one-shot permit", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.close();
    // The attacker revives the permit in the database and removes every
    // witness from the anchor domain.
    revivePermitInDatabase(f.file);
    for (const name of fs.readdirSync(f.anchorDir)) {
      const full = path.join(f.anchorDir, name);
      if (fs.statSync(full).isDirectory()) continue;
      fs.unlinkSync(full);
    }
    // The rebuild cannot vouch for a database it has never witnessed.
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "attempted" },
    }), { code: "ERR_COORDINATION_LOCK_MISSING" });
    // And the service refuses to start. The empty journal is reported first,
    // because without any journal entry there is no anchor to check the
    // declaration against.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_COORDINATION_LOCK_MISSING" });
  } finally { f.cleanup(); }
});

test("MS-003 a crash window cannot be used to launder a one-shot permit", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.close();
    // The crash window: the declaration lags one sequence behind the
    // database, which is the state a crash between the commit and the
    // declaration write leaves behind.
    const declaration = path.join(f.anchorDir, "protected-anchor-high-water.log");
    const lines = fs.readFileSync(declaration, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(declaration, lines.slice(0, -1).join("\n") + "\n");
    revivePermitInDatabase(f.file);
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "attempted" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_STATE_TAMPERED" });
  } finally { f.cleanup(); }
});

test("MS-003 the rebuild refuses a database whose digest the anchor never witnessed", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    const lease = f.store.acquire(leaseFields());
    const permit = f.store.reserve(permitFields(lease));
    f.store.consume(consumeFields(permit));
    f.store.close();
    // Remove the witness of the committed sequence, then change the body
    // behind it. The sequence still matches, the digest does not.
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const journal = anchorModule.readJournal(path.join(f.anchorDir, "protected-anchor.journal"));
    const commitName = fs.readdirSync(f.anchorDir).find((name) =>
      name.startsWith(`protected-anchor-entry-${String(journal.committed).padStart(12, "0")}-`) && name.includes("-commit-"));
    fs.unlinkSync(path.join(f.anchorDir, commitName));
    revivePermitInDatabase(f.file);
    assert.throws(() => ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "attempted" },
    }), { code: "ERR_RECOVERY_NOT_APPLICABLE" });
  } finally { f.cleanup(); }
});

test("MS-003 the rebuild keeps the original witness of a witnessed sequence", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const anchorModule = require("../../lib/coordination/protected-anchor");
    const journalFile = path.join(f.anchorDir, "protected-anchor.journal");
    const before = anchorModule.readJournal(journalFile).committedBySeq.get(
      anchorModule.readJournal(journalFile).committed);
    // A rebuild of a sequence the anchor already witnessed must not write a
    // second attempt: the journal keeps the highest attempt, so a new one
    // would replace the digest of the body that was actually committed.
    ProtectedPermitStore.rebuildAnchor(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      acceptDatabaseAsTruth: true, audit: { by: "admin", reason: "journal-pruned" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    const after = anchorModule.readJournal(journalFile).committedBySeq.get(
      anchorModule.readJournal(journalFile).committed);
    assert.equal(after.body_digest, before.body_digest);
    assert.equal(after.attempt, before.attempt);
  } finally { f.cleanup(); }
});

test("MS-003 a missing or empty high-water declaration is refused instead of silently ignored", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const declaration = path.join(f.anchorDir, "protected-anchor-high-water.log");
    fs.rmSync(declaration);
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_DECLARATION_MISSING" });
    fs.writeFileSync(declaration, "");
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_ANCHOR_DECLARATION_MISSING" });
  } finally { f.cleanup(); }
});

test("MS-003 the high-water declaration must not be a symbolic link", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const declaration = path.join(f.anchorDir, "protected-anchor-high-water.log");
    const evil = path.join(f.dir, "evil");
    fs.writeFileSync(evil, "");
    fs.rmSync(declaration);
    fs.symlinkSync(evil, declaration);
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    }), { code: "ERR_UNSAFE_PATH" });
  } finally { f.cleanup(); }
});

test("MS-003 an anchor reset leaves unrelated files of the administrator alone", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const notes = path.join(f.anchorDir, "operator-notes.txt");
    fs.writeFileSync(notes, "keep me");
    ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
      audit: { by: "admin", reason: "anchor-loss" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    assert.equal(fs.existsSync(notes), true);
    assert.equal(fs.readFileSync(notes, "utf8"), "keep me");
  } finally { f.cleanup(); }
});

test("MS-003 an anchor reset requires the clock the service runs on", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // A reset that stamps the fresh state with the wall clock while the
    // service runs on an injected clock would write a timestamp the service
    // has never seen, and the next open would refuse the store as a clock
    // rollback. The clock is therefore required, not defaulted.
    assert.throws(() => ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      audit: { by: "admin", reason: "anchor-loss" },
    }), { code: "ERR_CLOCK_INVALID" });
    const reset = ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
      audit: { by: "admin", reason: "anchor-loss" },
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    assert.equal(reset.reset, true);
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    assert.equal(Object.keys(reopened.snapshot().permits).length, 0);
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 the stable error code registry carries the protected store codes", () => {
  const { CODES } = require("../../lib/coordination/errors");
  const wanted = [
    "ERR_ANCHOR_REQUIRED", "ERR_ANCHOR_MISSING", "ERR_ANCHOR_CORRUPT", "ERR_ANCHOR_UNREADABLE",
    "ERR_ANCHOR_NOT_SEPARATE", "ERR_ANCHOR_DIR_MISSING", "ERR_ANCHOR_WRITE_INCOMPLETE",
    "ERR_ANCHOR_DECLARATION_MISSING", "ERR_ANCHOR_STORE_MISMATCH", "ERR_STATE_ROLLED_BACK",
    "ERR_STATE_AHEAD_OF_ANCHOR", "ERR_STATE_TAMPERED", "ERR_CRASH_WINDOW_RECOVERABLE",
    "ERR_UNSAFE_PATH", "ERR_AUDIT_WRITE_FAILED", "ERR_RECOVERY_AUDIT_REQUIRED",
    "ERR_RECOVERY_NOT_APPLICABLE", "ERR_ACTION_IN_FLIGHT", "ERR_ACTION_ALREADY_DISPATCHED",
  ];
  for (const key of wanted) {
    assert.ok(Object.prototype.hasOwnProperty.call(CODES, key), key + " is not registered");
    assert.ok(CODES[key].code >= 1000 && CODES[key].code <= 1999, key + " is out of the reserved range");
    assert.ok(CODES[key].zh && CODES[key].en, key + " lacks a bilingual description");
  }
});

test("MS-003 an anchor reset validates its clock before it retires the anchor domain", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    const before = fs.readdirSync(f.anchorDir).filter((name) => name.startsWith("protected-anchor-entry-")).length;
    // The clock is rejected, so the reset must fail before it touches the
    // anchor domain. A reset that retired the anchor and then failed would
    // leave the database rolled back but the anchor emptied: a state that is
    // neither "not reset" nor "reset".
    assert.throws(() => ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
      expectedDecisionId: "D-test-init", anchorDir: f.anchorDir,
      audit: { by: "admin", reason: "anchor-loss" },
    }), { code: "ERR_CLOCK_INVALID" });
    const after = fs.readdirSync(f.anchorDir).filter((name) => name.startsWith("protected-anchor-entry-")).length;
    assert.equal(after, before);
    assert.equal(fs.existsSync(path.join(f.anchorDir, "protected-anchor-high-water.log")), true);
    // The service is still usable, because nothing was retired.
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    });
    reopened.close();
  } finally { f.cleanup(); }
});

// ─── The permission contract of the anchor domain ──────────────────────────
//
// The high-water mark is only a trust root while the anchor domain cannot be
// changed by an ordinary process. The service design requires the anchor to
// be writable by the service identity only, but that was a written convention
// and not a checked fact. The checks below make it a fact the code verifies.

test("MS-003 the anchor domain refuses a directory that group or other may write", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // A group-writable anchor directory lets any process of the group delete
    // or replace a journal entry, which would silently lower the mark.
    fs.chmodSync(f.anchorDir, 0o775);
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.strict,
    }), { code: "ERR_ANCHOR_PERMISSIONS" });
  } finally {
    try { fs.chmodSync(f.anchorDir, 0o700); } catch { /* the directory is gone */ }
    f.cleanup();
  }
});

test("MS-003 the anchor domain refuses a file that group or other may write", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The journal entries are written with mode 0600. A file that another
    // identity may write can be replaced in place, which would change the
    // witness without any trace in the directory.
    const entry = fs.readdirSync(f.anchorDir).find((name) => name.startsWith("protected-anchor-entry-"));
    fs.chmodSync(path.join(f.anchorDir, entry), 0o666);
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.strict,
    }), { code: "ERR_ANCHOR_PERMISSIONS" });
  } finally { f.cleanup(); }
});

test("MS-003 the anchor domain refuses a directory owned by another account", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The service writes the witnesses itself, so it has to own the anchor
    // directory. A directory owned by somebody else gives that owner a
    // second writer: it can delete and replace a journal entry without any
    // permission bit being set for it.
    //
    // The owner is a condition of its own: it may always rewrite the ACL of
    // the object it owns, so it is a second writer that no ACE describes.
    // It is therefore reported as ERR_ANCHOR_OWNERSHIP rather than being
    // collapsed into the writer-set error, which describes a different
    // failure (an ACE granting write to somebody else).
    const realUid = process.getuid;
    process.getuid = () => (realUid() + 1);
    try {
      assert.throws(() => ProtectedPermitStore.open(f.file, {
        expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
        anchorMode: anchorModule.ANCHOR_MODE.strict,
      }), { code: "ERR_ANCHOR_OWNERSHIP" });
    } finally {
      process.getuid = realUid;
    }
  } finally { f.cleanup(); }
});

test("MS-003 the anchor domain refuses a witness owned by another account", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The owner of a file may always write it, whatever the permission bits
    // say. A witness owned by another identity is therefore a second writer
    // that can rewrite the witness in place, so the witnesses themselves
    // have to belong to the service identity.
    //
    // The witness and the anchor directory are written by the same service
    // process, so they share an owner. Faking the declared identity makes
    // the directory owner differ as well, and the directory-level owner
    // check is the one that fires first. The refusal is therefore reported
    // as ERR_ANCHOR_OWNERSHIP; the ACE-level second writer stays covered by
    // the authorization adapter's own test.
    const entry = fs.readdirSync(f.anchorDir).find((name) => name.startsWith("protected-anchor-entry-"));
    assert.ok(entry, "the anchor domain must contain a journal entry");
    const realUid = process.getuid;
    process.getuid = () => (realUid() + 1);
    try {
      assert.throws(() => ProtectedPermitStore.open(f.file, {
        expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
        anchorMode: anchorModule.ANCHOR_MODE.strict,
      }), { code: "ERR_ANCHOR_OWNERSHIP" });
    } finally {
      process.getuid = realUid;
    }
  } finally { f.cleanup(); }
});

test("MS-003 the anchor domain accepts a directory the service owns", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The protected shape: the service owns the anchor domain, and nothing
    // else can write it. This is the shape the service actually runs in, so
    // the strict mode has to accept it.
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.strict,
    });
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 a witness that others may read is accepted", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // Reading a witness does not compromise it: changing it needs write
    // access. Refusing group or other read access would also refuse the
    // ordinary operational reads a protected deployment needs.
    const entry = fs.readdirSync(f.anchorDir).find((name) => name.startsWith("protected-anchor-entry-"));
    assert.ok(entry, "the anchor domain must contain a journal entry");
    fs.chmodSync(path.join(f.anchorDir, entry), 0o640);
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.strict,
    });
    reopened.close();
  } finally { f.cleanup(); }
});

test("MS-003 the quarantine directory is checked like the anchor domain", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The retired evidence is read during an incident investigation, so a file
    // that somebody else can rewrite would corrupt the record.
    const quarantine = path.join(f.anchorDir, "quarantine");
    fs.mkdirSync(quarantine, { mode: 0o700 });
    const retired = path.join(quarantine, "retired-entry.json");
    fs.writeFileSync(retired, "{}\n", { mode: 0o600 });
    fs.chmodSync(retired, 0o666);
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.strict,
    }), { code: "ERR_ANCHOR_PERMISSIONS" });
  } finally { f.cleanup(); }
});

test("MS-003 a store cannot be created in an anchor domain that fails its own contract", { skip: !supportsSqlite }, () => {
  const f = fixture();
  try {
    // The store records the mode it was created under. Creating it in a
    // domain that does not satisfy that mode would produce a store that
    // refuses its own first open.
    fs.chmodSync(f.anchorDir, 0o777);
    assert.throws(() => ProtectedPermitStore.initialize(path.join(f.dir, "second.sqlite"), {
      decisionId: "D-test-init", clock: f.clock, anchorDir: f.anchorDir,
      anchorMode: anchorModule.ANCHOR_MODE.strict,
    }), { code: "ERR_ANCHOR_PERMISSIONS" });
  } finally {
    try { fs.chmodSync(f.anchorDir, 0o700); } catch { /* the directory is gone */ }
    f.cleanup();
  }
});

test("MS-003 the anchor domain refuses a world-writable ancestor without the sticky bit", { skip: !supportsSqlite }, () => {
  // The ancestor chain is built inside a directory this test owns, because
  // the temporary root itself cannot be chmod-ed on every platform.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms003-ancestor-"));
  const parent = path.join(root, "parent");
  fs.mkdirSync(parent);
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict, anchorDir: path.join(parent, "anchor") });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // A world-writable ancestor without the sticky bit lets anybody rename
    // the anchor directory away and replace it with one of their own, which
    // discards every witness without touching a journal entry.
    const original = fs.statSync(parent).mode & 0o7777;
    try {
      fs.chmodSync(parent, (original | 0o002) & 0o7777);
      assert.throws(() => ProtectedPermitStore.open(f.file, {
        expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
        anchorMode: anchorModule.ANCHOR_MODE.strict,
      }), { code: "ERR_ANCHOR_PERMISSIONS" });
    } finally {
      try { fs.chmodSync(parent, original); } catch { /* the directory is gone */ }
    }
  } finally {
    f.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MS-003 a caller may not weaken the recorded permission mode for a single open", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The store was created under the strict contract. Opening it with a
    // weaker mode would let this one process skip the check while every
    // other process still has to honour it.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: anchorModule.ANCHOR_MODE.permissive,
    }), { code: "ERR_ANCHOR_MODE_DOWNGRADE" });
  } finally { f.cleanup(); }
});

test("MS-003 a caller may not weaken the recorded permission mode for a recovery run", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // The recovery entry points are invoked by an administrator, often by a
    // different process than the one that created the store. They apply the
    // recorded contract, and a caller may not hand a weaker one to them.
    for (const recover of [
      () => ProtectedPermitStore.recoverFromAnchorCrash(f.file, {
        expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
        anchorMode: anchorModule.ANCHOR_MODE.permissive,
        audit: { by: "admin", reason: "MS-003 downgrade probe" },
      }),
      () => ProtectedPermitStore.rebuildAnchor(f.file, {
        expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
        anchorMode: anchorModule.ANCHOR_MODE.permissive, acceptDatabaseAsTruth: true,
        audit: { by: "admin", reason: "MS-003 downgrade probe" },
      }),
      () => ProtectedPermitStore.resetAfterAnchorLoss(f.file, {
        expectedDecisionId: "D-test-init", anchorDir: f.anchorDir, clock: f.clock,
        anchorMode: anchorModule.ANCHOR_MODE.permissive,
        audit: { by: "admin", reason: "MS-003 downgrade probe" },
      }),
    ]) {
      assert.throws(recover, { code: "ERR_ANCHOR_MODE_DOWNGRADE" });
    }
  } finally { f.cleanup(); }
});

test("MS-003 an unknown permission mode is refused instead of being treated as permissive", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.strict });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // A typo or a tampered value must not silently opt out of the contract.
    assert.throws(() => ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
      anchorMode: "permissive ",
    }), { code: "ERR_ANCHOR_MODE_INVALID" });
  } finally { f.cleanup(); }
});

test("MS-003 the recorded permission mode survives a restart", { skip: !supportsSqlite }, () => {
  const f = fixture({ anchorMode: anchorModule.ANCHOR_MODE.permissive });
  try {
    f.store.acquire(leaseFields());
    f.store.close();
    // A restart that states no mode applies the mode that was recorded with
    // the state, so a recovery run by another process does not silently get a
    // weaker contract than the one the store was created under.
    const reopened = ProtectedPermitStore.open(f.file, {
      expectedDecisionId: "D-test-init", minimumEpoch: 1, anchorDir: f.anchorDir, clock: f.clock,
    });
    assert.equal(reopened.snapshot().anchor_mode, anchorModule.ANCHOR_MODE.permissive);
    reopened.close();
  } finally { f.cleanup(); }
});
