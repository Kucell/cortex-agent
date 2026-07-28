"use strict";

// ─── T-ACN-005: Ownership Lease & Stale ───────────────────────────────────
// 确定性测试：注入手动时钟；零第三方依赖。
// 覆盖 acquire/renew/release、owner/fencing/TTL、冲突保护、过期转 STALE、
// TAKEOVER_REQUESTED 超时回 STALE、审计证据，及与 contract.js 词汇表一致性。

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  LeaseManager,
  createManualClock,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_TAKEOVER_TIMEOUT_MS,
  AUDIT_EVENT_TYPES,
} = require("../lib/coordination/lease");
const { CODES, CoordinationError } = require("../lib/coordination/errors");
const { STATES, EVENT_TYPES } = require("../lib/coordination/contract");

// ─── Helpers ───────────────────────────────────────────────────────────────

function mk(clock) {
  return new LeaseManager({ clock: clock || createManualClock(0) });
}

// ─── 1. Module shape & vocabulary consistency ──────────────────────────────

test("exports expected members", () => {
  assert.equal(typeof LeaseManager, "function");
  assert.equal(typeof createManualClock, "function");
  assert.equal(DEFAULT_LEASE_TTL_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_TAKEOVER_TIMEOUT_MS, 10 * 60 * 1000);
  assert.ok(Array.isArray(AUDIT_EVENT_TYPES));
});

test("AUDIT_EVENT_TYPES is a subset of contract EVENT_TYPES", () => {
  const vocab = new Set(EVENT_TYPES);
  for (const t of AUDIT_EVENT_TYPES) {
    assert.ok(vocab.has(t), `audit event type ${t} must be in contract vocabulary`);
  }
});

test("lease module never imports contract (independent)", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../lib/coordination/lease.js"), "utf8");
  assert.ok(!/require\(['"]\.\/contract['"]\)/.test(src), "lease.js must not depend on contract.js");
});

test("no Math.random / Date.now in lease.js (deterministic)", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../lib/coordination/lease.js"), "utf8");
  // 匹配实际调用（带括号），排除注释中的文字提及
  assert.equal((src.match(/Math\.random\(/g) || []).length, 0, "must not call Math.random");
  // Date.now() 只允许出现在 defaultClock 中（恰好 1 处）
  assert.equal((src.match(/Date\.now\(\)/g) || []).length, 1, "Date.now() only allowed in defaultClock");
});

// ─── 2. Clock injection & determinism ──────────────────────────────────────

test("injected clock controls timestamps", () => {
  const clock = createManualClock(1_000_000);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 60000 });
  assert.equal(lease.acquiredAt, "1970-01-01T00:16:40.000Z");
  assert.equal(lease.expiresAt, "1970-01-01T00:17:40.000Z");
});

test("IDs are counter-based and deterministic", () => {
  const lm = mk(createManualClock(0));
  const a = lm.acquire("src/", "agent-a");
  const b = lm.acquire("docs/", "agent-b");
  assert.equal(a.leaseId, "LEASE-1");
  assert.equal(b.leaseId, "LEASE-2");
  const audits = lm.getAuditLog();
  assert.equal(audits[0].auditId, "AUDIT-1");
  assert.equal(audits[1].auditId, "AUDIT-2");
});

test("frozen clock yields identical timestamps across managers", () => {
  const t = 5_000_000;
  const l1 = mk(createManualClock(t));
  const l2 = mk(createManualClock(t));
  assert.equal(l1.acquire("src/", "a").acquiredAt, l2.acquire("src/", "a").acquiredAt);
});

// ─── 3. acquire basics ─────────────────────────────────────────────────────

test("acquire creates active lease with fencing token 1", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.equal(lease.scope, "src/");
  assert.equal(lease.owner, "agent-a");
  assert.equal(lease.actorId, "agent-a");
  assert.equal(lease.fencingToken, 1);
  assert.equal(lease.releasedAt, null);
  assert.equal(lease.staleAt, null);
  assert.equal(lease.takeover, false);
  assert.equal(lease.recoveredFrom, null);
  assert.ok(lm.isActive(lease.leaseId));
  assert.ok(!lm.isExpired(lease.leaseId));
});

test("acquire without ttl uses DEFAULT_LEASE_TTL_MS", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a");
  assert.equal(toMs(lease.expiresAt), DEFAULT_LEASE_TTL_MS);
});

function toMs(v) { return typeof v === "number" ? v : new Date(v).getTime(); }

test("acquire requires scope and owner", () => {
  const lm = mk();
  assert.throws(() => lm.acquire("", "agent-a"), { key: "ERR_INVALID_STATE" });
  assert.throws(() => lm.acquire("src/", ""), { key: "ERR_INVALID_ACTOR" });
});

// ─── 4. Fencing token monotonic per scope ──────────────────────────────────

test("fencing token is monotonic per scope and independent across scopes", () => {
  const lm = mk(createManualClock(0));
  const a = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(a.leaseId);
  const b = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.equal(a.fencingToken, 1);
  assert.equal(b.fencingToken, 2);
  assert.equal(lm.getFencingToken("src/"), 2);
  // 不同 scope 独立计数
  const c = lm.acquire("docs/", "agent-c", { ttl: 1000 });
  assert.equal(c.fencingToken, 1);
  assert.equal(lm.getFencingToken("docs/"), 1);
});

test("renew keeps the same fencing token", () => {
  const lm = mk(createManualClock(0));
  const a = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const renewed = lm.renew(a.leaseId, { ttl: 2000 });
  assert.equal(renewed.fencingToken, a.fencingToken);
  assert.equal(renewed.leaseId, a.leaseId);
});

// ─── 5. TTL & expiry ───────────────────────────────────────────────────────

test("TTL expiry: active before, expired after", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(999);
  assert.ok(lm.isActive(lease.leaseId));
  assert.ok(!lm.isExpired(lease.leaseId));
  clock.advance(2); // total 1001
  assert.ok(!lm.isActive(lease.leaseId));
  assert.ok(lm.isExpired(lease.leaseId));
});

test("listActiveLeases only returns active leases", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.acquire("docs/", "agent-b", { ttl: 1000 });
  clock.advance(1001);
  lm.acquire("tests/", "agent-c", { ttl: 1000 });
  const active = lm.listActiveLeases();
  assert.equal(active.length, 1);
  assert.equal(active[0].scope, "tests/");
});

// ─── 6. acquire same-owner renews ──────────────────────────────────────────

test("acquire same scope same owner renews (extends TTL, same leaseId)", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(100);
  const second = lm.acquire("src/", "agent-a", { ttl: 2000 });
  assert.equal(second.leaseId, first.leaseId);
  assert.ok(toMs(second.expiresAt) > toMs(first.expiresAt));
  // 续期写 ownership.acquired (renewed=true) 审计
  const renewed = lm.getAuditLog({ eventType: "ownership.acquired" }).filter((e) => e.details.renewed);
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].reason, "renewed");
});

// ─── 7. acquire different active owner -> conflict + audit ─────────────────

test("acquire same scope different active owner throws CONFLICT with audit", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  let err;
  try { lm.acquire("src/", "agent-b", { ttl: 1000 }); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.key, "ERR_LEASE_CONFLICT");
  assert.equal(err.details.currentOwner, "agent-a");
  assert.equal(err.details.requestedOwner, "agent-b");
  assert.equal(err.details.active, true);
  assert.ok(err.lease);
  const conflicts = lm.getAuditLog({ eventType: "ownership.conflict" });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "active_lease_held");
  assert.equal(conflicts[0].details.takeoverRequired, true);
});

// ─── 8. Concurrent acquire: only one succeeds ──────────────────────────────

test("concurrent acquire on free scope: only one succeeds, other conflicts", () => {
  const lm = mk(createManualClock(0));
  const a = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.ok(a.leaseId);
  assert.throws(() => lm.acquire("src/", "agent-b", { ttl: 1000 }), { key: "ERR_LEASE_CONFLICT" });
  // 仅一个活跃租约
  assert.equal(lm.listActiveLeases().length, 1);
});

// ─── 9. Expired lease: different owner cannot acquire without audit ────────

test("expired lease: different owner cannot acquire directly (conflict + takeoverRequired)", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001); // 过期
  let err;
  try { lm.acquire("src/", "agent-b", { ttl: 1000 }); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(err.key, "ERR_LEASE_CONFLICT");
  assert.equal(err.details.expired, true);
  assert.equal(err.details.takeoverRequired, true);
  assert.equal(err.details.currentOwner, "agent-a");
  const conflicts = lm.getAuditLog({ eventType: "ownership.conflict" });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, "expired_lease_contested");
  assert.equal(conflicts[0].details.expired, true);
});

test("expired lease: same owner can re-acquire (continuity)", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001); // 过期
  const second = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.notEqual(second.leaseId, first.leaseId);
  assert.equal(second.fencingToken, 2);
  assert.equal(second.takeover, false);
  assert.equal(second.recoveredFrom, first.leaseId);
  const acquired = lm.getAuditLog({ eventType: "ownership.acquired" });
  const continuity = acquired.find((e) => e.reason === "continuity_reacquire");
  assert.ok(continuity);
  assert.equal(continuity.details.continuity, true);
});

test("released lease: different owner can acquire fresh (post-release)", () => {
  const lm = mk(createManualClock(0));
  const first = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(first.leaseId);
  const second = lm.acquire("src/", "agent-b", { ttl: 1000 });
  assert.equal(second.owner, "agent-b");
  assert.equal(second.fencingToken, 2);
  const acquired = lm.getAuditLog({ eventType: "ownership.acquired" });
  assert.equal(acquired[acquired.length - 1].reason, "initial_acquire");
});

// ─── 10. renew ─────────────────────────────────────────────────────────────

test("renew extends expiry", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(100);
  const renewed = lm.renew(lease.leaseId, { ttl: 5000 });
  assert.equal(toMs(renewed.expiresAt), 5100);
});

test("renew owner mismatch throws", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { actorId: "sess-1", ttl: 5000 });
  assert.throws(() => lm.renew(lease.leaseId, { actorId: "sess-2" }), { key: "ERR_LEASE_OWNER_MISMATCH" });
});

test("renew nonexistent throws NOT_FOUND", () => {
  const lm = mk();
  assert.throws(() => lm.renew("LEASE-x"), { key: "ERR_LEASE_NOT_FOUND" });
});

test("renew expired lease throws EXPIRED", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001);
  assert.throws(() => lm.renew(lease.leaseId, { ttl: 5000 }), { key: "ERR_LEASE_EXPIRED" });
});

test("renew released lease throws EXPIRED", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 5000 });
  lm.release(lease.leaseId);
  assert.throws(() => lm.renew(lease.leaseId, { ttl: 5000 }), { key: "ERR_LEASE_EXPIRED" });
});

// ─── 11. release ───────────────────────────────────────────────────────────

test("release marks releasedAt and writes audit", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const released = lm.release(lease.leaseId, { evidence: ["./exit-evidence.json"] });
  assert.ok(released.releasedAt);
  assert.ok(lm.isExpired(lease.leaseId));
  const audits = lm.getAuditLog({ eventType: "ownership.released" });
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0].evidence, ["./exit-evidence.json"]);
});

test("release is idempotent", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const first = lm.release(lease.leaseId);
  const second = lm.release(lease.leaseId);
  assert.equal(first.releasedAt, second.releasedAt);
  // 幂等不再写第二条 release 审计
  assert.equal(lm.getAuditLog({ eventType: "ownership.released" }).length, 1);
});

test("release owner mismatch throws", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { actorId: "sess-1", ttl: 1000 });
  assert.throws(() => lm.release(lease.leaseId, { actorId: "sess-2" }), { key: "ERR_LEASE_OWNER_MISMATCH" });
});

test("release nonexistent throws NOT_FOUND", () => {
  const lm = mk();
  assert.throws(() => lm.release("LEASE-x"), { key: "ERR_LEASE_NOT_FOUND" });
});

// ─── 12. findConflicts ─────────────────────────────────────────────────────

test("findConflicts returns active leases by other owners", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.equal(lm.findConflicts("src/", "agent-b").length, 1);
  assert.equal(lm.findConflicts("src/", "agent-a").length, 0);
  clock.advance(1001);
  assert.equal(lm.findConflicts("src/", "agent-b").length, 0); // expired -> not a conflict
});

// ─── 13. Stale candidate (read-only) ───────────────────────────────────────

test("detectStaleCandidate: no lease", () => {
  const lm = mk(createManualClock(0));
  const c = lm.detectStaleCandidate("src/");
  assert.equal(c.stale, false);
  assert.deepEqual(c.reasons, ["no_lease"]);
});

test("detectStaleCandidate: active lease not stale", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  const c = lm.detectStaleCandidate("src/");
  assert.equal(c.stale, false);
  assert.equal(c.recommendation, "none");
});

test("detectStaleCandidate: expired lease -> lease_expired + confirm_stale", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001);
  const c = lm.detectStaleCandidate("src/");
  assert.equal(c.stale, true);
  assert.ok(c.reasons.includes("lease_expired"));
  assert.equal(c.recommendation, "confirm_stale");
});

test("detectStaleCandidate: heartbeat timeout before lease expiry", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 10000 });
  clock.advance(500); // lease still active
  const c = lm.detectStaleCandidate("src/", { heartbeatDueAt: 400 }); // heartbeat 400ms 已超期
  assert.equal(c.stale, true);
  assert.ok(c.reasons.includes("heartbeat_timeout"));
});

test("detectStaleCandidate: released lease -> released", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(lease.leaseId);
  const c = lm.detectStaleCandidate(lease.leaseId);
  assert.equal(c.stale, false);
  assert.deepEqual(c.reasons, ["released"]);
});

test("detectStaleCandidate does not mutate state", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001);
  lm.detectStaleCandidate("src/");
  // 派生不写 STALE：租约仍无 staleAt
  assert.equal(lm.getLease(lease.leaseId).staleAt, null);
  assert.equal(lm.getAuditLog({ eventType: "task.stale" }).length, 0);
});

// ─── 14. markStale (expiry -> STALE) ───────────────────────────────────────

test("markStale on expired lease sets staleAt + task.stale audit", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001);
  const stale = lm.markStale(lease.leaseId);
  assert.ok(stale.staleAt);
  const audits = lm.getAuditLog({ eventType: "task.stale" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].reason, "lease_expired");
  assert.equal(audits[0].details.state, "STALE");
  assert.equal(audits[0].details.expiredByTime, true);
});

test("markStale on active lease without evidence throws MISSING_EVIDENCE", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.throws(() => lm.markStale(lease.leaseId), { key: "ERR_MISSING_EVIDENCE" });
});

test("markStale on active lease with evidence succeeds", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  const stale = lm.markStale(lease.leaseId, { evidence: ["./proc-exit.json"], reason: "process_exit" });
  assert.ok(stale.staleAt);
  const audits = lm.getAuditLog({ eventType: "task.stale" });
  assert.equal(audits[0].reason, "process_exit");
  assert.deepEqual(audits[0].evidence, ["./proc-exit.json"]);
});

test("markStale is idempotent", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  clock.advance(1001);
  const first = lm.markStale(lease.leaseId);
  const second = lm.markStale(lease.leaseId);
  assert.equal(first.staleAt, second.staleAt);
  assert.equal(lm.getAuditLog({ eventType: "task.stale" }).length, 1);
});

test("markStale on released lease throws INVALID_STATE", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.release(lease.leaseId);
  assert.throws(() => lm.markStale(lease.leaseId), { key: "ERR_INVALID_STATE" });
});

test("markStale nonexistent throws NOT_FOUND", () => {
  const lm = mk();
  assert.throws(() => lm.markStale("LEASE-x"), { key: "ERR_LEASE_NOT_FOUND" });
});

// ─── 15. requestTakeover ───────────────────────────────────────────────────

test("requestTakeover creates pending request + task.takeover_requested audit", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 10000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  assert.equal(req.status, "pending");
  assert.equal(req.requester, "agent-b");
  assert.equal(req.previousOwner, "agent-a");
  assert.equal(req.deadline, "1970-01-01T00:00:05.000Z");
  assert.equal(req.completedAt, null);
  const audits = lm.getAuditLog({ eventType: "task.takeover_requested" });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].details.state, "TAKEOVER_REQUESTED");
});

test("requestTakeover idempotent for same requester", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 10000 });
  const first = lm.requestTakeover("src/", "agent-b");
  const second = lm.requestTakeover("src/", "agent-b");
  assert.equal(first.requestId, second.requestId);
});

test("requestTakeover conflict for different requester while pending", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 10000 });
  lm.requestTakeover("src/", "agent-b");
  assert.throws(() => lm.requestTakeover("src/", "agent-c"), { key: "ERR_LEASE_CONFLICT" });
});

test("requestTakeover with no lease throws NOT_FOUND", () => {
  const lm = mk(createManualClock(0));
  assert.throws(() => lm.requestTakeover("src/", "agent-b"), { key: "ERR_LEASE_NOT_FOUND" });
});

test("requestTakeover own lease throws OWNER_MISMATCH", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 10000 });
  assert.throws(() => lm.requestTakeover("src/", "agent-a"), { key: "ERR_LEASE_OWNER_MISMATCH" });
});

test("requestTakeover on released scope throws INVALID_STATE", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 10000 });
  lm.release(lease.leaseId);
  assert.throws(() => lm.requestTakeover("src/", "agent-b"), { key: "ERR_INVALID_STATE" });
});

// ─── 16. completeTakeover ──────────────────────────────────────────────────

test("completeTakeover within deadline + evidence -> TAKEN_OVER with higher fencing token", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 10000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  clock.advance(1000); // within deadline
  const { request, lease } = lm.completeTakeover(req.requestId, {
    recoveryEvidence: ["./worktree-check.json"],
  });
  assert.equal(request.status, "completed");
  assert.equal(request.newLeaseId, lease.leaseId);
  assert.equal(lease.owner, "agent-b");
  assert.equal(lease.fencingToken, 2); // higher than first (1)
  assert.equal(lease.takeover, true);
  assert.equal(lease.recoveredFrom, first.leaseId);
  // 旧租约被释放
  assert.ok(lm.getLease(first.leaseId).releasedAt);
  // 审计：ownership.released (takeover_recovery) + ownership.acquired (takeover) + task.taken_over
  assert.equal(lm.getAuditLog({ eventType: "ownership.released" }).length, 1);
  const taken = lm.getAuditLog({ eventType: "task.taken_over" });
  assert.equal(taken.length, 1);
  assert.equal(taken[0].details.state, "TAKEN_OVER");
  assert.equal(taken[0].details.previousOwner, "agent-a");
  assert.equal(taken[0].details.newOwner, "agent-b");
});

test("completeTakeover binds the successor lease to its authenticated session", () => {
  const lm = new LeaseManager({ clock: createManualClock(0) });
  const previous = lm.acquire("src/**", "agent-a", {
    actorId: "session-a",
    ttl: 1,
  });
  lm.markStale(previous.leaseId, { evidence: "RUN-stale" });
  const request = lm.requestTakeover("src/**", "agent-b", {
    actorId: "coordinator",
  });
  const completed = lm.completeTakeover(request.requestId, {
    actorId: "coordinator",
    sessionId: "session-b",
    recoveryEvidence: "RUN-recovered",
  });
  assert.equal(completed.lease.owner, "agent-b");
  assert.equal(completed.lease.actorId, "session-b");
});

test("completeTakeover past deadline throws TAKEOVER_REQUEST_TIMEOUT", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  clock.advance(5001);
  assert.throws(
    () => lm.completeTakeover(req.requestId, { recoveryEvidence: ["./x.json"] }),
    { key: "ERR_TAKEOVER_REQUEST_TIMEOUT" }
  );
});

test("completeTakeover missing recovery evidence throws MISSING_EVIDENCE (active prev)", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  assert.throws(() => lm.completeTakeover(req.requestId), { key: "ERR_MISSING_EVIDENCE" });
});

test("completeTakeover no evidence needed when previous owner released", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  // 原 owner 确认退出，释放租约
  lm.release(first.leaseId);
  const { request, lease } = lm.completeTakeover(req.requestId);
  assert.equal(request.status, "completed");
  assert.equal(lease.owner, "agent-b");
  assert.equal(lease.fencingToken, 2);
});

test("completeTakeover non-pending throws INVALID_STATE", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  lm.completeTakeover(req.requestId, { recoveryEvidence: ["./x.json"] });
  assert.throws(
    () => lm.completeTakeover(req.requestId, { recoveryEvidence: ["./x.json"] }),
    { key: "ERR_INVALID_STATE" }
  );
});

test("completeTakeover nonexistent throws NOT_FOUND", () => {
  const lm = mk();
  assert.throws(() => lm.completeTakeover("TKO-x"), { key: "ERR_LEASE_NOT_FOUND" });
});

// ─── 17. expireTakeover (timeout -> STALE) ─────────────────────────────────

test("isTakeoverExpired false before deadline, true after", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  assert.equal(lm.isTakeoverExpired(req.requestId), false);
  clock.advance(5001);
  assert.equal(lm.isTakeoverExpired(req.requestId), true);
});

test("expireTakeover before deadline is no-op", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  const result = lm.expireTakeover(req.requestId);
  assert.equal(result.expired, false);
  assert.equal(result.request.status, "pending");
  assert.equal(lm.getAuditLog({ eventType: "task.stale" }).length, 0);
});

test("expireTakeover past deadline -> STALE audit with ERR_TAKEOVER_REQUEST_TIMEOUT", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  clock.advance(5001);
  const result = lm.expireTakeover(req.requestId, { evidence: ["./timeout-evidence.json"] });
  assert.equal(result.expired, true);
  assert.equal(result.request.status, "expired");
  assert.ok(result.auditEntry);
  assert.equal(result.auditEntry.eventType, "task.stale");
  assert.equal(result.auditEntry.reason, "takeover_timeout");
  assert.equal(result.auditEntry.details.errorCode, "ERR_TAKEOVER_REQUEST_TIMEOUT");
  assert.equal(result.auditEntry.details.code, CODES.ERR_TAKEOVER_REQUEST_TIMEOUT.code);
  assert.equal(result.auditEntry.details.state, "STALE");
  // 旧活跃租约被标记 stale
  assert.ok(lm.getLease(first.leaseId).staleAt);
  assert.ok(result.staleRecord);
});

test("expireTakeover non-pending throws INVALID_STATE", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  clock.advance(5001);
  lm.expireTakeover(req.requestId);
  assert.throws(() => lm.expireTakeover(req.requestId), { key: "ERR_INVALID_STATE" });
});

// ─── 18. Takeover blocks acquire/renew ─────────────────────────────────────

test("pending takeover blocks acquire (takeover_in_progress)", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  let err;
  try { lm.acquire("src/", "agent-c", { ttl: 1000 }); } catch (e) { err = e; }
  assert.equal(err.key, "ERR_LEASE_CONFLICT");
  assert.equal(err.details.takeoverRequestId, req.requestId);
  const conflicts = lm.getAuditLog({ eventType: "ownership.conflict" });
  assert.equal(conflicts[conflicts.length - 1].reason, "takeover_in_progress");
});

test("pending takeover blocks renew by original owner", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 100000 });
  lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  assert.throws(() => lm.renew(lease.leaseId, { ttl: 1000 }), { key: "ERR_LEASE_CONFLICT" });
});

test("release is still allowed during pending takeover (owner confirms stop)", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 100000 });
  lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  const released = lm.release(lease.leaseId);
  assert.ok(released.releasedAt);
});

// ─── 19. Full lifecycle: takeover completed ────────────────────────────────

test("lifecycle: acquire -> requestTakeover -> completeTakeover; new owner active, old blocked", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  const { lease } = lm.completeTakeover(req.requestId, { recoveryEvidence: ["./rec.json"] });
  assert.equal(lm.listActiveLeases().length, 1);
  assert.equal(lm.listActiveLeases()[0].leaseId, lease.leaseId);
  // 新 owner 可续期
  assert.doesNotThrow(() => lm.renew(lease.leaseId, { ttl: 1000 }));
  // 旧 owner 不能直接 acquire 回来（新 owner 活跃租约冲突）
  assert.throws(() => lm.acquire("src/", "agent-a", { ttl: 1000 }), { key: "ERR_LEASE_CONFLICT" });
});

// ─── 20. Full lifecycle: takeover timeout -> STALE -> continuity ───────────

test("lifecycle: acquire -> requestTakeover -> timeout -> STALE; original owner continuity re-acquire", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const first = lm.acquire("src/", "agent-a", { ttl: 100000 });
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  clock.advance(5001);
  const result = lm.expireTakeover(req.requestId);
  assert.equal(result.expired, true);
  // 超时后 takeover 不再 pending -> 原 owner 可重新 acquire（连续性）
  const reclaimed = lm.acquire("src/", "agent-a", { ttl: 1000 });
  assert.equal(reclaimed.owner, "agent-a");
  assert.ok(reclaimed.fencingToken > first.fencingToken);
  // 新 owner b 仍不能直接 acquire（stale 租约需 takeover 流程）
  assert.throws(() => lm.acquire("src/", "agent-b", { ttl: 1000 }), { key: "ERR_LEASE_CONFLICT" });
});

// ─── 21. Audit log ─────────────────────────────────────────────────────────

test("audit log preserves ordering and supports filtering", () => {
  const clock = createManualClock(0);
  const lm = mk(clock);
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.renew(lease.leaseId, { ttl: 2000 });
  lm.release(lease.leaseId);
  const all = lm.getAuditLog();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.eventType), ["ownership.acquired", "ownership.acquired", "ownership.released"]);
  // 过滤
  assert.equal(lm.getAuditLog({ eventType: "ownership.released" }).length, 1);
  assert.equal(lm.getAuditLog({ scope: "src/" }).length, 3);
  assert.equal(lm.getAuditLog({ leaseId: lease.leaseId }).length, 3);
});

test("audit entries carry evidence and details copies (no mutation leak)", () => {
  const lm = mk(createManualClock(0));
  const lease = lm.acquire("src/", "agent-a", { ttl: 1000, evidence: ["./a.json"] });
  lm.release(lease.leaseId, { evidence: ["./b.json"] });
  const acquired = lm.getAuditLog({ eventType: "ownership.acquired" })[0];
  const released = lm.getAuditLog({ eventType: "ownership.released" })[0];
  assert.deepEqual(acquired.evidence, ["./a.json"]);
  assert.deepEqual(released.evidence, ["./b.json"]);
  // 突变快照不应影响内部记录
  acquired.evidence.push("MUTATED");
  acquired.details.x = 1;
  const reacquired = lm.getAuditLog({ eventType: "ownership.acquired" })[0];
  assert.deepEqual(reacquired.evidence, ["./a.json"]);
  assert.equal(reacquired.details.x, undefined);
});

test("clearAuditLog empties the audit trail", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  lm.clearAuditLog();
  assert.equal(lm.getAuditLog().length, 0);
});

// ─── 22. Error code consistency with errors.js ─────────────────────────────

test("error keys match errors.js CODES", () => {
  assert.equal(CODES.ERR_LEASE_CONFLICT.code, 1003);
  assert.equal(CODES.ERR_LEASE_EXPIRED.code, 1004);
  assert.equal(CODES.ERR_LEASE_NOT_FOUND.code, 1022);
  assert.equal(CODES.ERR_LEASE_OWNER_MISMATCH.code, 1023);
  assert.equal(CODES.ERR_TAKEOVER_REQUEST_TIMEOUT.code, 1024);
  assert.equal(CODES.ERR_MISSING_EVIDENCE.code, 1017);
  assert.equal(CODES.ERR_INVALID_STATE.code, 1009);
  assert.equal(CODES.ERR_INVALID_ACTOR.code, 1016);
  assert.equal(CODES.ERR_EVIDENCE_REF_INVALID.code, 1021);
});

test("thrown errors are CoordinationError instances with stable codes", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 1000 });
  let err;
  try { lm.acquire("src/", "agent-b", { ttl: 1000 }); } catch (e) { err = e; }
  assert.ok(err instanceof CoordinationError);
  assert.equal(err.name, "CoordinationError");
  assert.equal(err.code, 1003);
});

// ─── 23. Evidence validation ───────────────────────────────────────────────

test("malformed evidence throws EVIDENCE_REF_INVALID", () => {
  const lm = mk(createManualClock(0));
  assert.throws(() => lm.acquire("src/", "agent-a", { ttl: 1000, evidence: [123] }), { key: "ERR_EVIDENCE_REF_INVALID" });
  assert.throws(() => lm.acquire("src/", "agent-a", { ttl: 1000, evidence: {} }), { key: "ERR_EVIDENCE_REF_INVALID" });
});

test("evidence accepts string and {ref} forms", () => {
  const lm = mk(createManualClock(0));
  lm.acquire("src/", "agent-a", { ttl: 1000, evidence: "./single.json" });
  let audits = lm.getAuditLog({ eventType: "ownership.acquired" });
  assert.deepEqual(audits[0].evidence, ["./single.json"]);
  lm.release("LEASE-1", { evidence: { ref: "RUN-001" } });
  audits = lm.getAuditLog({ eventType: "ownership.released" });
  assert.deepEqual(audits[0].evidence, ["RUN-001"]);
});

// ─── 24. State strings match contract STATES ───────────────────────────────

test("state strings used in audit details match contract STATES", () => {
  assert.equal(STATES.STALE, "STALE");
  assert.equal(STATES.TAKEOVER_REQUESTED, "TAKEOVER_REQUESTED");
  assert.equal(STATES.TAKEN_OVER, "TAKEN_OVER");
});

// ─── 25. Determinism: full lifecycle stable with frozen clock ──────────────

test("determinism: frozen clock full lifecycle produces stable IDs/timestamps", () => {
  const clock = createManualClock(1_000_000);
  const lm = mk(clock);
  const lease1 = lm.acquire("src/", "agent-a", { ttl: 60000 });
  assert.equal(lease1.leaseId, "LEASE-1");
  assert.equal(lease1.fencingToken, 1);
  clock.advance(1000);
  const req = lm.requestTakeover("src/", "agent-b", { takeoverTtl: 5000 });
  assert.equal(req.requestId, "TKO-1");
  clock.advance(2000); // within deadline (t=3000, deadline=6000)
  const { lease: lease2 } = lm.completeTakeover(req.requestId, { recoveryEvidence: ["./rec.json"] });
  assert.equal(lease2.leaseId, "LEASE-2");
  assert.equal(lease2.fencingToken, 2);
  assert.equal(lease2.acquiredAt, "1970-01-01T00:16:43.000Z"); // t=3_000_000 ms
  // 审计 ID 顺序稳定
  const ids = lm.getAuditLog().map((e) => e.auditId);
  assert.deepEqual(ids, ["AUDIT-1", "AUDIT-2", "AUDIT-3", "AUDIT-4", "AUDIT-5"]);
});
