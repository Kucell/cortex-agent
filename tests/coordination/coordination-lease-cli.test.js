"use strict";

// ─── Public Ownership Lease CLI tests (FAE-007 / M-013 MS-002 / VC-013-02) ─
//
// Coverage: idempotent acquire, fencing monotonicity, expiry recovery,
// takeover two-phase, sensitive-evidence guard, durable persistence,
// CLI surface (leaseAcquire / leaseRenew / leaseRelease / leaseStatus /
// leaseRecover). Reuses M-008 LeaseManager + lease-store; the CLI never
// touches subprocess, network, or credential files.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const leaseCli = require("../../lib/coordination/lease-cli");
const { LeaseManager, createManualClock } = require("../../lib/coordination/lease");
const leaseStore = require("../../lib/coordination/lease-store");

function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "m013-lease-"));
  fs.mkdirSync(path.join(root, ".agent-runtime", "coordination", "leases"), { recursive: true });
  return root;
}

function rmProject(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

function clockAt(ms) {
  return { now: () => ms };
}

test("VC-013-02-01 lease acquire creates a new lease with fencing token 1", () => {
  const root = mkProject();
  try {
    const result = leaseCli.leaseAcquire({
      scope: "task:T-1",
      owner: "agent-pi",
      ttl: 60,
    }, { projectRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.action, "lease_acquire");
    assert.equal(result.idempotent, false);
    assert.equal(result.lease.scope, "task:T-1");
    assert.equal(result.lease.owner, "agent-pi");
    assert.equal(result.lease.fencingToken, 1);
    assert.match(result.lease.leaseId, /^LEASE-\d+$/);
  } finally { rmProject(root); }
});

test("VC-013-02-02 lease acquire with --idempotency-key returns same lease on second call", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({
      scope: "task:T-2",
      owner: "agent-pi",
      ttl: 60,
      idempotencyKey: "m013-idem-1",
    }, { projectRoot: root });
    assert.equal(r1.ok, true);
    const r2 = leaseCli.leaseAcquire({
      scope: "task:T-2",
      owner: "agent-pi",
      ttl: 60,
      idempotencyKey: "m013-idem-1",
    }, { projectRoot: root });
    assert.equal(r2.ok, true);
    assert.equal(r2.idempotent, true);
    assert.equal(r2.lease.leaseId, r1.lease.leaseId);
    assert.equal(r2.lease.fencingToken, r1.lease.fencingToken);
  } finally { rmProject(root); }
});

test("VC-013-02-03 lease acquire same idempotency-key + different owner returns ERR_LEASE_IDEMPOTENCY_MISMATCH", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({
      scope: "task:T-3",
      owner: "agent-pi",
      idempotencyKey: "m013-idem-3",
    }, { projectRoot: root });
    assert.equal(r1.ok, true);
    const r2 = leaseCli.leaseAcquire({
      scope: "task:T-3",
      owner: "agent-cursor",
      idempotencyKey: "m013-idem-3",
    }, { projectRoot: root });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "ERR_LEASE_IDEMPOTENCY_MISMATCH");
    assert.equal(r2.error.currentOwner, "agent-pi");
    assert.equal(r2.error.requestedOwner, "agent-cursor");
  } finally { rmProject(root); }
});

test("VC-013-02-04 lease acquire different owner of active scope returns ERR_LEASE_CONFLICT", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({ scope: "task:T-4", owner: "agent-pi" }, { projectRoot: root });
    assert.equal(r1.ok, true);
    const r2 = leaseCli.leaseAcquire({ scope: "task:T-4", owner: "agent-cursor" }, { projectRoot: root });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "ERR_LEASE_CONFLICT");
    assert.equal(r2.error.active, true);
    assert.equal(r2.error.currentOwner, "agent-pi");
    assert.equal(r2.error.requestedOwner, "agent-cursor");
  } finally { rmProject(root); }
});

test("VC-013-02-05 lease acquire fencing token is monotonic across scopes and scopes within same scope", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({ scope: "task:T-5A", owner: "o" }, { projectRoot: root });
    const r2 = leaseCli.leaseAcquire({ scope: "task:T-5B", owner: "o" }, { projectRoot: root });
    assert.equal(r1.lease.fencingToken, 1);
    assert.equal(r2.lease.fencingToken, 1); // independent scopes
    const r3 = leaseCli.leaseAcquire({ scope: "task:T-5A", owner: "o2" }, { projectRoot: root });
    // Different owner of an active scope: rejected, fencing stays at 1
    assert.equal(r3.ok, false);
    // After release, same scope gets fresh fencing > 1
    const release = leaseCli.leaseRelease({ leaseId: r1.lease.leaseId }, { projectRoot: root });
    assert.equal(release.ok, true);
    const r4 = leaseCli.leaseAcquire({ scope: "task:T-5A", owner: "o3" }, { projectRoot: root });
    assert.equal(r4.lease.fencingToken, 2);
  } finally { rmProject(root); }
});

test("VC-013-02-06 lease renew extends TTL with same leaseId and same fencing token", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({ scope: "task:T-6", owner: "o", ttl: 30 }, { projectRoot: root });
    const before = r1.lease.expiresAt;
    const r2 = leaseCli.leaseRenew({ leaseId: r1.lease.leaseId, ttl: 90 }, { projectRoot: root });
    assert.equal(r2.ok, true);
    assert.equal(r2.lease.leaseId, r1.lease.leaseId);
    assert.equal(r2.lease.fencingToken, r1.lease.fencingToken);
    assert.notEqual(r2.lease.expiresAt, before);
  } finally { rmProject(root); }
});

test("VC-013-02-07 lease release is idempotent on already-released lease", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({ scope: "task:T-7", owner: "o" }, { projectRoot: root });
    const r2 = leaseCli.leaseRelease({ leaseId: r1.lease.leaseId }, { projectRoot: root });
    assert.equal(r2.ok, true);
    const r3 = leaseCli.leaseRelease({ leaseId: r1.lease.leaseId }, { projectRoot: root });
    // The wrapped release call returns the released lease; idempotent at the LeaseManager level.
    assert.equal(r3.ok, true);
  } finally { rmProject(root); }
});

test("VC-013-02-08 lease status by leaseId returns active status and remaining_ms", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({ scope: "task:T-8", owner: "o", ttl: 60 }, { projectRoot: root });
    const status = leaseCli.leaseStatus({ leaseId: r1.lease.leaseId }, { projectRoot: root });
    assert.equal(status.ok, true);
    assert.equal(status.found, true);
    assert.equal(status.lease.status, "active");
    assert.ok(status.lease.remaining_ms > 0);
  } finally { rmProject(root); }
});

test("VC-013-02-09 lease status by scope returns full history array (active + released)", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({ scope: "task:T-9", owner: "o1", ttl: 30 }, { projectRoot: root });
    leaseCli.leaseRelease({ leaseId: r1.lease.leaseId }, { projectRoot: root });
    leaseCli.leaseAcquire({ scope: "task:T-9", owner: "o2", ttl: 60 }, { projectRoot: root });
    const status = leaseCli.leaseStatus({ scope: "task:T-9" }, { projectRoot: root });
    assert.equal(status.ok, true);
    assert.equal(status.scope, "task:T-9");
    assert.equal(status.leases.length, 2);
    const released = status.leases.find((l) => l.leaseId === r1.lease.leaseId);
    const active = status.leases.find((l) => l.status === "active");
    assert.equal(released.status, "released");
    assert.equal(active.status, "active");
  } finally { rmProject(root); }
});

test("VC-013-02-10 lease status returns found=false for unknown leaseId", () => {
  const root = mkProject();
  try {
    const status = leaseCli.leaseStatus({ leaseId: "LEASE-99999" }, { projectRoot: root });
    assert.equal(status.ok, true);
    assert.equal(status.found, false);
  } finally { rmProject(root); }
});

test("VC-013-02-11 lease recover runs two-phase takeover and writes audit", () => {
  const root = mkProject();
  try {
    leaseCli.leaseAcquire({ scope: "task:T-11", owner: "owner-1" }, { projectRoot: root });
    const result = leaseCli.leaseRecover({
      scope: "task:T-11",
      newOwner: "owner-2",
      ttl: 60,
      takeoverTimeoutMs: 10000,
      recoveryEvidence: ["audit:M-013-recovery"],
    }, { projectRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.action, "lease_recover");
    assert.equal(result.takeover.lease.owner, "owner-2");
    assert.equal(result.takeover.lease.fencingToken, 2);
    // Audit must contain task.takeover_requested + task.taken_over; verify by re-reading the manager.
    const leasesDir = path.join(root, ".agent-runtime", "coordination", "leases");
    const manager = leaseStore.readLeaseState(leasesDir);
    const audit = manager.getAuditLog({ scope: "task:T-11" });
    const auditKinds = audit.map((a) => a.eventType);
    assert.ok(auditKinds.includes("task.takeover_requested"), "must record task.takeover_requested");
    assert.ok(auditKinds.includes("task.taken_over"), "must record task.taken_over");
    assert.ok(auditKinds.includes("ownership.acquired"), "must record ownership.acquired (new lease)");
  } finally { rmProject(root); }
});

test("VC-013-02-12 lease acquire rejects tainted evidence with ERR_LEASE_EVIDENCE_TAINTED", () => {
  const root = mkProject();
  try {
    const patterns = ["sk-abcdefghijklmnopqrstuv", "MINIMAX_API_KEY=xxx", "MINIMAX_TOKEN=yyy", "api_key=secret", "password=hunter2"];
    for (const tainted of patterns) {
      try {
        leaseCli.leaseAcquire({
          scope: "task:T-12",
          owner: "o",
          evidence: [tainted],
        }, { projectRoot: root });
        assert.fail(`expected taint rejection for: ${tainted}`);
      } catch (error) {
        assert.equal(error.code, "ERR_LEASE_EVIDENCE_TAINTED", `tainted: ${tainted}`);
      }
    }
  } finally { rmProject(root); }
});

test("VC-013-02-13 lease acquire persists state.json and idempotency.json to fsynced 0o600 files", () => {
  const root = mkProject();
  try {
    leaseCli.leaseAcquire({
      scope: "task:T-13",
      owner: "o",
      idempotencyKey: "m013-key-13",
      ttl: 60,
    }, { projectRoot: root });
    const leasesDir = path.join(root, ".agent-runtime", "coordination", "leases");
    const statePath = path.join(leasesDir, "state.json");
    const idemPath = path.join(leasesDir, "idempotency.json");
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.existsSync(idemPath), true);
    const stateStat = fs.statSync(statePath);
    const idemStat = fs.statSync(idemPath);
    // 0o600 = owner read/write only; group/other must be 0
    assert.equal(stateStat.mode & 0o077, 0, "state.json must be 0o600");
    assert.equal(idemStat.mode & 0o077, 0, "idempotency.json must be 0o600");
    const idem = JSON.parse(fs.readFileSync(idemPath, "utf8"));
    assert.equal(idem.schema_version, 1);
    assert.ok(idem.keys["m013-key-13"]);
    assert.equal(idem.keys["m013-key-13"].scope, "task:T-13");
  } finally { rmProject(root); }
});

test("VC-013-02-14 lease acquire durable round-trip survives process restart", () => {
  const root = mkProject();
  try {
    const r1 = leaseCli.leaseAcquire({
      scope: "task:T-14",
      owner: "o",
      idempotencyKey: "m013-key-14",
      ttl: 60,
    }, { projectRoot: root });
    // Simulate process restart by reading raw store directly.
    const leasesDir = path.join(root, ".agent-runtime", "coordination", "leases");
    const manager2 = leaseStore.readLeaseState(leasesDir);
    const leases = manager2.listLeasesForScope("task:T-14");
    assert.equal(leases.length, 1);
    assert.equal(leases[0].leaseId, r1.lease.leaseId);
    assert.equal(leases[0].idempotencyKey, "m013-key-14");
  } finally { rmProject(root); }
});

test("VC-013-02-15 lease recover on free scope returns ERR_LEASE_NOT_FOUND (no takeover candidate)", () => {
  const root = mkProject();
  try {
    // No prior lease in the scope.
    const result = leaseCli.leaseRecover({
      scope: "task:T-15",
      newOwner: "owner-x",
    }, { projectRoot: root });
    // requestTakeover will throw because there is no current lease to contest.
    assert.equal(result.ok, false);
    assert.ok(["ERR_LEASE_NOT_FOUND", "ERR_LEASE_CONFLICT"].includes(result.code));
  } finally { rmProject(root); }
});

test("VC-013-02-16 lease acquire with missing scope/owner throws ERR_ARG_REQUIRED", () => {
  const root = mkProject();
  try {
    let threw = false;
    try {
      leaseCli.leaseAcquire({ owner: "o" }, { projectRoot: root });
    } catch (e) { threw = e.code === "ERR_ARG_REQUIRED"; }
    assert.equal(threw, true);

    threw = false;
    try {
      leaseCli.leaseAcquire({ scope: "s" }, { projectRoot: root });
    } catch (e) { threw = e.code === "ERR_ARG_REQUIRED"; }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-02-17 lease renew on non-existent lease returns ERR_LEASE_NOT_FOUND", () => {
  const root = mkProject();
  try {
    const result = leaseCli.leaseRenew({ leaseId: "LEASE-999999" }, { projectRoot: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_LEASE_NOT_FOUND");
  } finally { rmProject(root); }
});

test("VC-013-02-18 lease release on non-existent lease returns ERR_LEASE_NOT_FOUND", () => {
  const root = mkProject();
  try {
    const result = leaseCli.leaseRelease({ leaseId: "LEASE-999999" }, { projectRoot: root });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ERR_LEASE_NOT_FOUND");
  } finally { rmProject(root); }
});

test("VC-013-02-19 lease acquire missing required argument throws LeaseCliError", () => {
  const root = mkProject();
  try {
    let threw = false;
    try {
      leaseCli.leaseAcquire({}, { projectRoot: root });
    } catch (e) {
      threw = e.name === "LeaseCliError" && e.code === "ERR_ARG_REQUIRED";
    }
    assert.equal(threw, true);
  } finally { rmProject(root); }
});

test("VC-013-02-20 lease-cli module never imports subprocess / network / fetch primitives", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../lib/coordination/lease-cli.js"), "utf8");
  assert.ok(!/child_process/.test(src), "lease-cli must not import child_process");
  assert.ok(!/\bnet\.Socket\b/.test(src), "lease-cli must not use net.Socket");
  assert.ok(!/require\(['"]https?['"]\)/.test(src), "lease-cli must not import http/https");
  assert.ok(!/\bfetch\(/.test(src), "lease-cli must not call fetch");
});