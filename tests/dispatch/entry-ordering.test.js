"use strict";

// Offline regression tests of existing MANUAL entry owners. The fixture
// approval is not a strict Owner/Waitpoint/lease authorization.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const { executeDispatch } = require("../../lib/dispatch/execute");
const { resolveRuntimePaths } = require("../../lib/runtime-layout");
const { CoordinationApplicationService } = require("../../lib/coordination/application-service");
const { createEvent, STATES } = require("../../lib/coordination/contract");
const { createManualClock } = require("../../lib/coordination/lease");

function contents(root) {
  const files = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else files[path.relative(root, file)] = fs.readFileSync(file, "utf8");
    }
  }
  walk(root); return files;
}
function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function manualFixture(t, legacy = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-entry-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const decisions = path.join(root, ".agent", "decisions");
  fs.mkdirSync(decisions, { recursive: true });
  const args = { taskId: "T-SYNTHETIC", idempotencyKey: "fixture-key", host: "pi", gate: "user", projectRoot: root };
  const approval = { decision_id: "D-SYNTHETIC", status: "approved", relations: { task_ids: [args.taskId] } };
  const approvalFile = path.join(decisions, "D-SYNTHETIC.json");
  const cacheDir = path.join(resolveRuntimePaths(root).dispatch.new, "idempotency");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, args.idempotencyKey + ".json");
  const canonical = { projectRoot: root, taskId: args.taskId, idempotencyKey: args.idempotencyKey, gate: args.gate, host: args.host };
  const record = { schema_version: 1, idempotency_key: args.idempotencyKey, task_id: args.taskId,
    status: "accepted", request_digest: digest(legacy ? args : canonical),
    execution: { decision_id: approval.decision_id, host_profile_ref: "H-pi" } };
  const save = () => {
    fs.writeFileSync(approvalFile, JSON.stringify(approval));
    fs.writeFileSync(cacheFile, JSON.stringify(record));
  };
  save();
  return { root, args, approval, approvalFile, cacheFile, record, save };
}

test("manual duplicate retains exact historical digest compatibility", (t) => {
  const f = manualFixture(t, true), before = contents(f.root);
  assert.equal(executeDispatch(f.args).idempotent, true);
  assert.deepEqual(contents(f.root), before);
});
test("new normalized digest permits equivalent argument property order", (t) => {
  const f = manualFixture(t), before = contents(f.root);
  const reordered = { projectRoot: f.args.projectRoot, host: f.args.host, gate: f.args.gate,
    idempotencyKey: f.args.idempotencyKey, taskId: f.args.taskId };
  assert.equal(executeDispatch(reordered).idempotent, true);
  assert.deepEqual(contents(f.root), before);
});
test("revoked manual approval blocks cached success without mutation", (t) => {
  const f = manualFixture(t);
  f.approval.status = "rejected"; f.save();
  const before = contents(f.root);
  assert.throws(() => executeDispatch(f.args), { code: "ERR_TASK_NOT_APPROVED" });
  assert.deepEqual(contents(f.root), before);
});
for (const [name, field, value] of [["Host", "host", "codex"], ["gate", "gate", "owner"]]) {
  test("changed " + name + " cannot reuse an accepted cache", (t) => {
    const f = manualFixture(t, true), before = contents(f.root);
    assert.throws(() => executeDispatch({ ...f.args, [field]: value }), { code: "ERR_IDEMPOTENCY_SCOPE_MISMATCH" });
    assert.deepEqual(contents(f.root), before);
  });
}
test("another approved Task cannot reuse an accepted cache key", (t) => {
  const f = manualFixture(t);
  f.approval.relations.task_ids.push("T-OTHER"); f.save();
  const before = contents(f.root);
  assert.throws(() => executeDispatch({ ...f.args, taskId: "T-OTHER" }), { code: "ERR_IDEMPOTENCY_SCOPE_MISMATCH" });
  assert.deepEqual(contents(f.root), before);
});
test("current Decision replacement invalidates cached acceptance", (t) => {
  const f = manualFixture(t);
  f.approval.decision_id = "D-REPLACEMENT"; f.save();
  const before = contents(f.root);
  assert.throws(() => executeDispatch(f.args), { code: "ERR_IDEMPOTENCY_SCOPE_MISMATCH" });
  assert.deepEqual(contents(f.root), before);
});

function coordinationFixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-submit-order-"));
  const service = CoordinationApplicationService.open(dir, { journal: { lock: false }, ...extra });
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = createEvent({
    eventId: "CE-synthetic-create", projectId: "P-SYNTHETIC", taskId: "T-SYNTHETIC",
    correlationId: "CORR-SYNTHETIC",
    producer: { actorId: "coordinator", kind: "coordinator", sessionId: "session-coordinator" },
    targets: [], eventType: "task.created", previousState: null, currentState: STATES.CREATED,
    timestamp: "2026-10-16T09:00:00.000Z", sequence: 1,
    repository: { repositoryId: "R-SYNTHETIC" },
    notification: { policy: "journal_only", dedupeKey: "synthetic" },
  });
  service.submit(first);
  const snapshot = path.join(dir, "tasks", "T-SYNTHETIC.json");
  return { dir, service, first, snapshot };
}
const COORDINATOR = { actorId: "coordinator", kind: "coordinator", sessionId: "session-coordinator" };

test("unauthorized duplicate cannot repair missing snapshot or return success", (t) => {
  const f = coordinationFixture(t);
  fs.unlinkSync(f.snapshot);
  const before = contents(f.dir);
  assert.throws(() => f.service.submit(f.first, { ...COORDINATOR, actorId: "other" }), { key: "ERR_ACTOR_MISMATCH" });
  assert.equal(fs.existsSync(f.snapshot), false);
  assert.deepEqual(contents(f.dir), before);
});
test("authorized duplicate still repairs its snapshot and remains idempotent", (t) => {
  const f = coordinationFixture(t);
  fs.unlinkSync(f.snapshot);
  const result = f.service.submit({ ...f.first, sequence: null }, COORDINATOR);
  assert.equal(result.duplicate, true);
  assert.equal(result.task.revision, 1);
  assert.equal(f.service.listEvents().length, 1);
  assert.equal(fs.existsSync(f.snapshot), true);
});
test("same eventId with changed event content is a typed conflict before repair", (t) => {
  const f = coordinationFixture(t);
  fs.unlinkSync(f.snapshot);
  const before = contents(f.dir);
  assert.throws(() => f.service.submit({ ...f.first, message: "different" }, COORDINATOR), { key: "ERR_INVALID_EVENT" });
  assert.deepEqual(contents(f.dir), before);
});
test("unauthorized new event cannot repair the current task projection", (t) => {
  const f = coordinationFixture(t);
  fs.unlinkSync(f.snapshot);
  const next = { ...f.first, eventId: "CE-synthetic-cancel", sequence: 2,
    eventType: "task.cancel_requested", previousState: STATES.CREATED, currentState: STATES.CANCEL_REQUESTED };
  const before = contents(f.dir);
  assert.throws(() => f.service.submit(next, COORDINATOR), { key: "ERR_ACTOR_MISMATCH" });
  assert.deepEqual(contents(f.dir), before);
});
test("invalid duplicate envelope cannot bypass validation or repair", (t) => {
  const f = coordinationFixture(t);
  fs.unlinkSync(f.snapshot);
  const before = contents(f.dir);
  assert.throws(() => f.service.submit({ ...f.first, callerApproval: true }, COORDINATOR), { key: "ERR_INVALID_EVENT" });
  assert.deepEqual(contents(f.dir), before);
});
test("expired current ownership blocks duplicate acceptance before repair", (t) => {
  const clock = createManualClock(Date.parse("2026-10-16T09:00:00.000Z"));
  const f = coordinationFixture(t, { clock });
  const lease = f.service.acquireOwnership("src/**", "worker", { actorId: "session-worker", ttl: 100 });
  f.service.submit({ ...f.first, eventId: "CE-synthetic-assign", sequence: 2,
    eventType: "task.assigned", previousState: STATES.CREATED, currentState: STATES.ASSIGNED,
    targets: [{ actorId: "worker", kind: "agent" }],
    fileOwnership: [{ leaseId: lease.leaseId, scope: lease.scope, owner: lease.owner,
      fencingToken: lease.fencingToken, expiresAt: lease.expiresAt }] }, COORDINATOR);
  const accepted = { ...f.first, eventId: "CE-synthetic-accept", sequence: 1,
    eventType: "task.accepted", previousState: STATES.ASSIGNED, currentState: STATES.ACCEPTED,
    producer: { actorId: "worker", kind: "agent", sessionId: "session-worker" } };
  const auth = { actorId: "worker", kind: "agent", sessionId: "session-worker" };
  f.service.submit(accepted, auth);
  clock.advance(101);
  fs.unlinkSync(f.snapshot);
  const before = contents(f.dir);
  assert.throws(() => f.service.submit(accepted, auth), { key: "ERR_LEASE_CONFLICT" });
  assert.deepEqual(contents(f.dir), before);
});

test("missing cache status cannot masquerade as accepted success", (t) => {
  const f = manualFixture(t);
  delete f.record.status; f.save();
  const before = contents(f.root);
  assert.throws(() => executeDispatch(f.args), { code: "ERR_IDEMPOTENCY_SCOPE_MISMATCH" });
  assert.deepEqual(contents(f.root), before);
});
test("pending and unknown cache states do not succeed or silently re-execute", (t) => {
  const f = manualFixture(t);
  for (const status of ["pending", "unknown"]) {
    f.record.status = status; f.save();
    const before = contents(f.root);
    assert.throws(() => executeDispatch(f.args), { code: "ERR_IDEMPOTENCY_SCOPE_MISMATCH" });
    assert.deepEqual(contents(f.root), before);
  }
});
