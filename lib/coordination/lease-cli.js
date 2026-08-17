"use strict";

// ─── Public Ownership Lease CLI (FAE-007 / M-013 MS-002) ───────────────────
//
// Thin wrapper around the audited M-008 / T-ACN-005 LeaseManager. The CLI
// owns NO state machine: every acquire/renew/release/status/recover call
// composes LeaseManager methods and the existing fsync'd lease-store
// persistence. No subprocess, no network, no clock mutation, no credential
// read. Idempotency-key support is layered on top of LeaseManager's
// in-memory index and a derived idempotency.json index, mirroring the
// state.json fsync/atomic-rename/0o600 pattern.
//
// Sensitive evidence strings (`sk-…`, `MINIMAX_API<KEY>`, `MINIMAX<TOKEN>`,
// `api[-_]?key`, `password`) are rejected at the argument boundary before
// any audit row is written.

const path = require("node:path");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths, portableRuntimePath } = require("../runtime-layout");
const { LeaseManager } = require("./lease");
const { CoordinationError, CODES } = require("./errors");
const leaseStore = require("./lease-store");

// Sensitive-string patterns reused from M-011 / M-008 boundary-event scanner.
const TAINT_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bMINIMAX[-_]?API[-_]?KEY\b/i,
  /\bMINIMAX[-_]?TOKEN\b/i,
  /\bapi[-_]?key\b/i,
  /\bpassword\b/i,
];

class LeaseCliError extends Error {
  constructor(code, details) {
    super(`[lease-cli:${code}] ${JSON.stringify(details || {})}`);
    this.name = "LeaseCliError";
    this.code = code;
    this.details = details || {};
  }
}

function requireString(value, where) {
  if (typeof value !== "string" || value.length === 0) {
    throw new LeaseCliError("ERR_ARG_REQUIRED", { where, received: typeof value });
  }
  return value;
}

function requireNonNegativeInteger(value, where) {
  if (value === undefined || value === null) return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0) {
    throw new LeaseCliError("ERR_ARG_INVALID", { where, received: value });
  }
  return num;
}

function scanTainted(values) {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const pattern of TAINT_PATTERNS) {
      if (pattern.test(value)) {
        return { pattern: pattern.source, value };
      }
    }
  }
  return null;
}

// MS-003: Get leases directory using shared runtime-layout API (VC-011)
// New-first/legacy-fallback per VC-012 compatibility window
function leasesDirFor(projectRoot) {
  const paths = resolveRuntimePaths(projectRoot);
  // During compat window: return legacy path if exists, else new path
  // After activation: always return new path
  if (paths.legacyExists && !paths.activated) {
    return path.join(paths.legacyRuntimeDir, "coordination", "leases");
  }
  return path.join(paths.coordination.new, "leases");
}

function loadManager(leasesDir, options = {}) {
  return leaseStore.readLeaseState(leasesDir, options);
}

function persist(leasesDir, manager, options = {}) {
  leaseStore.writeLeaseState(leasesDir, manager);
  // Mirror idempotencyKey from active leases into idempotency.json.
  const index = leaseStore.readIdempotency(leasesDir);
  const clockNow = options.now ? new Date(options.now).getTime() : Date.now();
  const expiresAtCutoff = clockNow;
  for (const lease of manager.listActiveLeases({ clock: { now: () => clockNow } })) {
    if (lease.idempotencyKey) {
      index.keys[lease.idempotencyKey] = {
        scope: lease.scope,
        lease_id: lease.leaseId,
        owner: lease.owner,
        created_at: lease.acquiredAt,
        expires_at: lease.expiresAt,
      };
    }
  }
  // Drop expired idempotency entries (best-effort GC).
  for (const key of Object.keys(index.keys)) {
    if (new Date(index.keys[key].expires_at).getTime() <= expiresAtCutoff) {
      delete index.keys[key];
    }
  }
  leaseStore.writeIdempotency(leasesDir, index);
}

// ─── acquire ─────────────────────────────────────────────────────────────
function leaseAcquire(args, options = {}) {
  const scope = requireString(args.scope, "scope");
  const owner = requireString(args.owner, "owner");
  const actor = args.actor || owner;
  const ttlMs = requireNonNegativeInteger(args.ttl !== undefined ? Number(args.ttl) * 1000 : undefined, "ttl");
  const idempotencyKey = args.idempotencyKey ? requireString(args.idempotencyKey, "idempotencyKey") : null;
  const evidence = Array.isArray(args.evidence) ? args.evidence : (args.evidence ? [args.evidence] : []);
  const taint = scanTainted(evidence);
  if (taint) throw new LeaseCliError("ERR_LEASE_EVIDENCE_TAINTED", taint);

  const leasesDir = leasesDirFor(options.projectRoot || process.cwd());
  const manager = loadManager(leasesDir, options);

  // Detect idempotent short-circuit BEFORE acquire so we can flag the result.
  let idempotentHit = false;
  if (idempotencyKey) {
    const existing = manager.findLeaseByIdempotencyKey(idempotencyKey, options);
    if (existing && existing.scope === scope && existing.owner === owner) {
      const clock = options.clock || { now: () => Date.now() };
      const active = manager.isActive(existing, { clock });
      if (active) idempotentHit = true;
    }
  }

  try {
    const lease = manager.acquire(scope, owner, {
      ttl: ttlMs,
      actorId: actor,
      idempotencyKey,
      evidence,
    });
    persist(leasesDir, manager, options);
    return {
      ok: true,
      action: "lease_acquire",
      idempotent: idempotentHit,
      lease,
    };
  } catch (error) {
    if (error instanceof CoordinationError) {
      return { ok: false, action: "lease_acquire", error: error.details, code: error.key, numeric_code: error.code };
    }
    throw error;
  }
}

// ─── renew ───────────────────────────────────────────────────────────────
function leaseRenew(args, options = {}) {
  if (!args.leaseId && !args.scope) {
    throw new LeaseCliError("ERR_ARG_REQUIRED", { where: "leaseId|scope" });
  }
  const ttlMs = requireNonNegativeInteger(args.ttl !== undefined ? Number(args.ttl) * 1000 : undefined, "ttl");
  const evidence = Array.isArray(args.evidence) ? args.evidence : (args.evidence ? [args.evidence] : []);
  const taint = scanTainted(evidence);
  if (taint) throw new LeaseCliError("ERR_LEASE_EVIDENCE_TAINTED", taint);

  const leasesDir = leasesDirFor(options.projectRoot || process.cwd());
  const manager = loadManager(leasesDir, options);

  let leaseId = args.leaseId;
  if (!leaseId && args.scope) {
    const scope = requireString(args.scope, "scope");
    const owner = args.owner ? requireString(args.owner, "owner") : null;
    const leases = manager.listLeasesForScope(scope, options);
    const active = leases.find((l) => l.status === "active" && (!owner || l.owner === owner));
    if (!active) {
      throw new LeaseCliError("ERR_LEASE_NOT_FOUND", { scope, owner });
    }
    leaseId = active.leaseId;
  }

  try {
    const renewed = manager.renew(leaseId, {
      ttl: ttlMs,
      actorId: args.actor,
      evidence,
    });
    persist(leasesDir, manager, options);
    return {
      ok: true,
      action: "lease_renew",
      lease: renewed,
    };
  } catch (error) {
    if (error instanceof CoordinationError) {
      return { ok: false, action: "lease_renew", error: error.details, code: error.key, numeric_code: error.code };
    }
    throw error;
  }
}

// ─── release ─────────────────────────────────────────────────────────────
function leaseRelease(args, options = {}) {
  const leaseId = requireString(args.leaseId, "leaseId");
  const evidence = Array.isArray(args.evidence) ? args.evidence : (args.evidence ? [args.evidence] : []);
  const taint = scanTainted(evidence);
  if (taint) throw new LeaseCliError("ERR_LEASE_EVIDENCE_TAINTED", taint);

  const leasesDir = leasesDirFor(options.projectRoot || process.cwd());
  const manager = loadManager(leasesDir, options);
  try {
    const released = manager.release(leaseId, { actorId: args.actor, evidence });
    persist(leasesDir, manager, options);
    return {
      ok: true,
      action: "lease_release",
      lease: released,
    };
  } catch (error) {
    if (error instanceof CoordinationError) {
      return { ok: false, action: "lease_release", error: error.details, code: error.key, numeric_code: error.code };
    }
    throw error;
  }
}

// ─── status ──────────────────────────────────────────────────────────────
function leaseStatus(args, options = {}) {
  const leasesDir = leasesDirFor(options.projectRoot || process.cwd());
  const manager = loadManager(leasesDir, options);

  if (args.leaseId) {
    const lease = manager.findLeaseById(args.leaseId, options);
    if (!lease) {
      return { ok: true, action: "lease_status", found: false, lease_id: args.leaseId };
    }
    return { ok: true, action: "lease_status", found: true, lease };
  }

  if (args.scope) {
    const scope = requireString(args.scope, "scope");
    const leases = manager.listLeasesForScope(scope, options);
    return { ok: true, action: "lease_status", scope, leases };
  }

  // No filter: list all active leases.
  const leases = manager.listActiveLeases(options).map((l) => manager.findLeaseById(l.leaseId, options));
  return { ok: true, action: "lease_status", leases };
}

// ─── recover (FAE-007 takeover two-phase) ─────────────────────────────────
function leaseRecover(args, options = {}) {
  const scope = requireString(args.scope, "scope");
  const newOwner = requireString(args.newOwner, "newOwner");
  const actorSessionId = args.actorSessionId ? requireString(args.actorSessionId, "actorSessionId") : null;
  const recoveryEvidence = Array.isArray(args.recoveryEvidence)
    ? args.recoveryEvidence
    : (args.recoveryEvidence ? [args.recoveryEvidence] : []);
  const taint = scanTainted(recoveryEvidence);
  if (taint) throw new LeaseCliError("ERR_LEASE_EVIDENCE_TAINTED", taint);

  const leasesDir = leasesDirFor(options.projectRoot || process.cwd());
  const manager = loadManager(leasesDir, options);
  const takeoverTimeoutMs = requireNonNegativeInteger(
    args.takeoverTimeoutMs !== undefined ? Number(args.takeoverTimeoutMs) : undefined,
    "takeoverTimeoutMs",
  );

  try {
    const request = manager.requestTakeover(scope, newOwner, {
      actorSessionId: actorSessionId || newOwner,
      recoveryEvidence,
      takeoverTimeoutMs,
    });
    // Complete immediately with no awaitable: caller is human-in-loop.
    const complete = manager.completeTakeover(request.requestId, {
      actorSessionId: actorSessionId || newOwner,
      ttl: requireNonNegativeInteger(args.ttl !== undefined ? Number(args.ttl) * 1000 : undefined, "ttl"),
      recoveryEvidence,
    });
    persist(leasesDir, manager, options);
    return {
      ok: true,
      action: "lease_recover",
      request: { requestId: request.requestId, status: request.status, expiresAt: request.expiresAt },
      takeover: complete,
    };
  } catch (error) {
    if (error instanceof CoordinationError) {
      return { ok: false, action: "lease_recover", error: error.details, code: error.key, numeric_code: error.code };
    }
    throw error;
  }
}

module.exports = {
  leaseAcquire,
  leaseRenew,
  leaseRelease,
  leaseStatus,
  leaseRecover,
  LeaseCliError,
  TAINT_PATTERNS,
};