"use strict";

// ─── Ownership Lease & Stale (T-ACN-005 / M-008 CP-1) ─────────────────────
// 独立模块：acquire / renew / release，owner / fencing token / TTL，
// 冲突保护，过期转 STALE，TAKEOVER_REQUESTED 超时回 STALE，审计证据。
// 注入时钟做确定性测试；零第三方依赖。
//
// 边界（与 P-001 §4 不变量一致）：
// - 本模块只管理租约生命周期与审计证据，不直接改写任务状态机
//   （状态迁移由 Application Service 调用 contract.js）；不持久化
//   （由 journal/state 模块负责）。审计事件类型与状态串与 contract.js
//   词汇表保持一致，由测试校验，本模块不反向依赖 contract.js。
// - Ownership 是带租期的协调锁，过期只允许进入 stale/takeover 流程
//   （P-001 §4.7）。不同执行者不能无审计直接接管过期租约。
// - stale 由只读 staleCandidate 派生，受控 writer 确认（P-001 §13.2）。
// - takeover 两阶段：TAKEOVER_REQUESTED -> TAKEN_OVER（recovery evidence）
//   或超时 -> STALE（P-001 §13.3）。

const { CoordinationError, CODES } = require("./errors");

// ─── 常量 ─────────────────────────────────────────────────────────────────

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;         // 30 min
const DEFAULT_TAKEOVER_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min

// 审计事件类型（与 contract.js EVENT_TYPES 词汇表一致，由测试校验子集）
const AUDIT_EVENT_TYPES = [
  "ownership.acquired",
  "ownership.released",
  "ownership.conflict",
  "task.stale",
  "task.takeover_requested",
  "task.taken_over",
];
const AUDIT_EVENT_TYPE_SET = new Set(AUDIT_EVENT_TYPES);

// 状态串（与 contract.js STATES 一致，由测试校验）
const STALE_STATE = "STALE";
const TAKEOVER_REQUESTED_STATE = "TAKEOVER_REQUESTED";
const TAKEN_OVER_STATE = "TAKEN_OVER";

// ─── 时钟 ─────────────────────────────────────────────────────────────────

function defaultClock() {
  return { now: () => Date.now() };
}

// 手动时钟（确定性测试用）：now() 返回当前 ms；advance(ms) 推进；set(ms) 重置。
function createManualClock(initialMs = 0) {
  let t = initialMs;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function nowIso(clock) {
  return toIso(clock.now());
}

function toMs(value) {
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

// ─── 证据归一化 ───────────────────────────────────────────────────────────
// 接受 string | string[] | {ref}；输出 string[]。非空字符串校验。
function normalizeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return [];
  if (typeof evidence === "string") {
    if (evidence.length === 0) return [];
    return [evidence];
  }
  if (Array.isArray(evidence)) {
    const out = [];
    for (const e of evidence) {
      if (typeof e !== "string" || e.length === 0) {
        throw new CoordinationError("ERR_EVIDENCE_REF_INVALID", {
          details: { reason: "evidence ref must be a non-empty string", evidence },
        });
      }
      out.push(e);
    }
    return out;
  }
  if (typeof evidence === "object" && typeof evidence.ref === "string" && evidence.ref.length > 0) {
    return [evidence.ref];
  }
  throw new CoordinationError("ERR_EVIDENCE_REF_INVALID", {
    details: { reason: "evidence must be string, string[], or {ref}", evidence },
  });
}

// ─── LeaseManager ─────────────────────────────────────────────────────────

class LeaseManager {
  constructor({ clock } = {}) {
    this._clock = clock || defaultClock();
    this._leases = new Map();            // leaseId -> lease
    this._byScope = new Map();           // scope -> leaseId[] (insertion order)
    this._fencing = new Map();           // scope -> highest fencing token issued
    this._takeovers = new Map();         // requestId -> request
    this._takeoversByScope = new Map();  // scope -> requestId[] (insertion order)
    this._audit = [];                    // audit entries (insertion order)
    this._leaseSeq = 0;
    this._auditSeq = 0;
    this._tkoSeq = 0;
  }

  // ─── 内部：确定性 ID 生成（无 Math.random） ──────────────────────────
  _nextLeaseId() { this._leaseSeq += 1; return `LEASE-${this._leaseSeq}`; }
  _nextAuditId() { this._auditSeq += 1; return `AUDIT-${this._auditSeq}`; }
  _nextRequestId() { this._tkoSeq += 1; return `TKO-${this._tkoSeq}`; }

  _nextFencingToken(scope) {
    const prev = this._fencing.get(scope) || 0;
    const next = prev + 1;
    this._fencing.set(scope, next);
    return next;
  }

  // ─── 内部：审计 ──────────────────────────────────────────────────────
  _auditLog(entry) {
    if (!AUDIT_EVENT_TYPE_SET.has(entry.eventType)) {
      throw new CoordinationError("ERR_INVALID_EVENT_TYPE", { details: { eventType: entry.eventType } });
    }
    const record = {
      auditId: this._nextAuditId(),
      timestamp: entry.timestamp || nowIso(this._clock),
      eventType: entry.eventType,
      scope: entry.scope || null,
      leaseId: entry.leaseId || null,
      actor: entry.actor || null,
      fencingToken: entry.fencingToken != null ? entry.fencingToken : null,
      reason: entry.reason || null,
      evidence: entry.evidence ? [...entry.evidence] : [],
      details: entry.details ? { ...entry.details } : {},
    };
    this._audit.push(record);
    return record;
  }

  // ─── 内部：索引与查询 ────────────────────────────────────────────────
  _indexLease(scope, leaseId) {
    if (!this._byScope.has(scope)) this._byScope.set(scope, []);
    this._byScope.get(scope).push(leaseId);
  }
  _leasesForScope(scope) {
    const ids = this._byScope.get(scope) || [];
    const out = [];
    for (const id of ids) {
      const l = this._leases.get(id);
      if (l) out.push(l);
    }
    return out;
  }
  _latestLeaseForScope(scope) {
    const all = this._leasesForScope(scope);
    return all.length ? all[all.length - 1] : null;
  }
  _activeLeaseForScope(scope, now) {
    for (const lease of this._leasesForScope(scope)) {
      if (this._isActive(lease, now)) return lease;
    }
    return null;
  }
  _pendingTakeoverForScope(scope) {
    const ids = this._takeoversByScope.get(scope) || [];
    for (const id of ids) {
      const req = this._takeovers.get(id);
      if (req && req.status === "pending") return req;
    }
    return null;
  }

  // ─── 内部：状态判定 ──────────────────────────────────────────────────
  _isActive(lease, now) {
    if (!lease) return false;
    if (lease.releasedAt) return false;
    if (lease.staleAt) return false;
    return toMs(lease.expiresAt) > now;
  }

  _snapshot(lease) {
    return lease ? { ...lease } : null;
  }
  _snapshotRequest(req) {
    return req ? { ...req } : null;
  }

  _createLease({ scope, owner, actorId, ttl, now, takeover, recoveredFrom }) {
    const lease = {
      leaseId: this._nextLeaseId(),
      scope,
      owner,
      actorId: actorId || owner,
      fencingToken: this._nextFencingToken(scope),
      acquiredAt: toIso(now),
      expiresAt: toIso(now + ttl),
      releasedAt: null,
      staleAt: null,
      takeover: !!takeover,
      recoveredFrom: recoveredFrom || null,
    };
    this._leases.set(lease.leaseId, lease);
    this._indexLease(scope, lease.leaseId);
    return lease;
  }

  // ─── 公共：状态判定 ──────────────────────────────────────────────────
  isActive(leaseOrId, opts = {}) {
    const clock = opts.clock || this._clock;
    const lease = typeof leaseOrId === "string" ? this._leases.get(leaseOrId) : leaseOrId;
    return this._isActive(lease, clock.now());
  }

  isExpired(leaseOrId, opts = {}) {
    const clock = opts.clock || this._clock;
    const lease = typeof leaseOrId === "string" ? this._leases.get(leaseOrId) : leaseOrId;
    if (!lease) return true;
    return !this._isActive(lease, clock.now());
  }

  // ─── acquire ─────────────────────────────────────────────────────────
  acquire(scope, owner, opts = {}) {
    if (!scope || typeof scope !== "string") {
      throw new CoordinationError("ERR_INVALID_STATE", { details: { reason: "scope required", scope } });
    }
    if (!owner || typeof owner !== "string") {
      throw new CoordinationError("ERR_INVALID_ACTOR", { details: { reason: "owner required", owner } });
    }
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const ttl = typeof opts.ttl === "number" && opts.ttl > 0 ? opts.ttl : DEFAULT_LEASE_TTL_MS;
    const actorId = opts.actorId || owner;
    const evidence = normalizeEvidence(opts.evidence);

    // 同一 scope 已有 pending takeover -> 禁止直接 acquire（必须走 complete/expire）
    const pendingTko = this._pendingTakeoverForScope(scope);
    if (pendingTko) {
      this._auditLog({
        eventType: "ownership.conflict", scope, actor: actorId,
        reason: "takeover_in_progress", evidence,
        details: {
          currentOwner: null, requestedOwner: owner, takeoverRequired: true,
          takeoverRequestId: pendingTko.requestId,
        },
      });
      throw new CoordinationError("ERR_LEASE_CONFLICT", {
        details: { scope, reason: "takeover_in_progress", takeoverRequired: true, takeoverRequestId: pendingTko.requestId },
      });
    }

    const active = this._activeLeaseForScope(scope, now);
    if (active) {
      if (active.owner === owner) {
        // 同一 owner：续期（不传 actorId 时跳过会话校验，传则须匹配）
        return this.renew(active.leaseId, { ttl, actorId: opts.actorId, clock, evidence });
      }
      // 不同 owner：冲突，写审计，fail closed
      this._auditLog({
        eventType: "ownership.conflict", scope, leaseId: active.leaseId, actor: actorId,
        fencingToken: active.fencingToken, reason: "active_lease_held", evidence,
        details: { currentOwner: active.owner, requestedOwner: owner, takeoverRequired: true, active: true },
      });
      const err = new CoordinationError("ERR_LEASE_CONFLICT", {
        details: { scope, currentOwner: active.owner, requestedOwner: owner, leaseId: active.leaseId, active: true },
      });
      err.lease = this._snapshot(active);
      throw err;
    }

    // 无活跃租约：检查历史租约，防止无审计直接接管他人过期/stale 租约
    const prev = this._latestLeaseForScope(scope);
    if (prev && prev.owner !== owner && !prev.releasedAt) {
      const reasonKey = prev.staleAt ? "stale_lease_contested" : "expired_lease_contested";
      this._auditLog({
        eventType: "ownership.conflict", scope, leaseId: prev.leaseId, actor: actorId,
        fencingToken: prev.fencingToken, reason: reasonKey, evidence,
        details: {
          currentOwner: prev.owner, requestedOwner: owner, takeoverRequired: true,
          expired: !prev.staleAt, stale: !!prev.staleAt,
        },
      });
      const err = new CoordinationError("ERR_LEASE_CONFLICT", {
        details: {
          scope, currentOwner: prev.owner, requestedOwner: owner, leaseId: prev.leaseId,
          expired: !prev.staleAt, stale: !!prev.staleAt, takeoverRequired: true,
          reason: prev.staleAt ? "stale" : "expired",
        },
      });
      err.lease = this._snapshot(prev);
      throw err;
    }

    // 允许：无历史 / 同 owner 连续性 / 他人已 released（scope 已干净释放）
    const continuity = !!(prev && prev.owner === owner && !prev.releasedAt);
    const lease = this._createLease({
      scope, owner, actorId, ttl, now, takeover: false,
      recoveredFrom: continuity ? prev.leaseId : null,
    });
    this._auditLog({
      eventType: "ownership.acquired", scope, leaseId: lease.leaseId, actor: actorId,
      fencingToken: lease.fencingToken,
      reason: continuity ? "continuity_reacquire" : "initial_acquire", evidence,
      details: { owner, ttl, continuity, recoveredFrom: lease.recoveredFrom, previousOwner: prev ? prev.owner : null },
    });
    return this._snapshot(lease);
  }

  // ─── renew ───────────────────────────────────────────────────────────
  renew(leaseId, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const lease = this._leases.get(leaseId);
    if (!lease) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { leaseId } });
    }
    if (lease.releasedAt) {
      throw new CoordinationError("ERR_LEASE_EXPIRED", { details: { leaseId, reason: "already released" } });
    }
    if (lease.staleAt) {
      throw new CoordinationError("ERR_LEASE_EXPIRED", { details: { leaseId, reason: "already stale" } });
    }
    if (opts.actorId && lease.actorId !== opts.actorId) {
      throw new CoordinationError("ERR_LEASE_OWNER_MISMATCH", {
        details: { leaseId, currentOwner: lease.actorId, requestedOwner: opts.actorId },
      });
    }
    // pending takeover 期间原 owner 不得续期（无 TAKEOVER_REQUESTED -> EXECUTING 迁移）
    const pendingTko = this._pendingTakeoverForScope(lease.scope);
    if (pendingTko) {
      throw new CoordinationError("ERR_LEASE_CONFLICT", {
        details: { leaseId, scope: lease.scope, reason: "takeover_in_progress", takeoverRequestId: pendingTko.requestId },
      });
    }
    // 过期租约不能续期（需重新 acquire 走连续性，或 takeover）
    if (toMs(lease.expiresAt) <= now) {
      throw new CoordinationError("ERR_LEASE_EXPIRED", {
        details: { leaseId, reason: "lease past TTL; re-acquire required", expiresAt: lease.expiresAt },
      });
    }
    const ttl = typeof opts.ttl === "number" && opts.ttl > 0 ? opts.ttl : DEFAULT_LEASE_TTL_MS;
    const actorId = opts.actorId || lease.actorId;
    const evidence = normalizeEvidence(opts.evidence);
    lease.expiresAt = toIso(now + ttl);
    this._auditLog({
      eventType: "ownership.acquired", scope: lease.scope, leaseId: lease.leaseId, actor: actorId,
      fencingToken: lease.fencingToken, reason: "renewed", evidence,
      details: { owner: lease.owner, ttl, renewed: true },
    });
    return this._snapshot(lease);
  }

  // ─── release ─────────────────────────────────────────────────────────
  release(leaseId, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const lease = this._leases.get(leaseId);
    if (!lease) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { leaseId } });
    }
    if (opts.actorId && lease.actorId !== opts.actorId) {
      throw new CoordinationError("ERR_LEASE_OWNER_MISMATCH", {
        details: { leaseId, currentOwner: lease.actorId, requestedOwner: opts.actorId },
      });
    }
    if (lease.releasedAt) {
      return this._snapshot(lease); // 幂等
    }
    const evidence = normalizeEvidence(opts.evidence);
    const actorId = opts.actorId || lease.actorId;
    lease.releasedAt = toIso(now);
    this._auditLog({
      eventType: "ownership.released", scope: lease.scope, leaseId: lease.leaseId, actor: actorId,
      fencingToken: lease.fencingToken, reason: "released", evidence,
      details: { owner: lease.owner, wasStale: !!lease.staleAt },
    });
    return this._snapshot(lease);
  }

  // ─── 查询 ────────────────────────────────────────────────────────────
  getLease(leaseId) {
    return this._snapshot(this._leases.get(leaseId));
  }

  listActiveLeases(opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const out = [];
    for (const lease of this._leases.values()) {
      if (this._isActive(lease, now)) out.push(this._snapshot(lease));
    }
    return out;
  }

  listByScope(scope) {
    return this._leasesForScope(scope).map((l) => this._snapshot(l));
  }

  getFencingToken(scope) {
    return this._fencing.get(scope) || 0;
  }

  findConflicts(scope, owner, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const conflicts = [];
    for (const lease of this._leasesForScope(scope)) {
      if (lease.owner !== owner && this._isActive(lease, now)) {
        conflicts.push(this._snapshot(lease));
      }
    }
    return conflicts;
  }

  // ─── Stale candidate（只读派生，P-001 §13.2） ───────────────────────
  detectStaleCandidate(scopeOrLeaseId, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    let lease;
    if (typeof scopeOrLeaseId === "string" && this._leases.has(scopeOrLeaseId)) {
      lease = this._leases.get(scopeOrLeaseId);
    } else {
      lease = this._latestLeaseForScope(scopeOrLeaseId);
    }
    if (!lease) {
      return { scope: scopeOrLeaseId, leaseId: null, owner: null, stale: false, reasons: ["no_lease"], now: toIso(now) };
    }
    if (lease.releasedAt) {
      return {
        scope: lease.scope, leaseId: lease.leaseId, owner: lease.owner,
        stale: false, reasons: ["released"], now: toIso(now), releasedAt: lease.releasedAt,
        recommendation: "none",
      };
    }
    const reasons = [];
    if (lease.staleAt) reasons.push("already_stale");
    if (toMs(lease.expiresAt) <= now) reasons.push("lease_expired");
    if (opts.heartbeatDueAt !== undefined && opts.heartbeatDueAt !== null) {
      if (toMs(opts.heartbeatDueAt) <= now) reasons.push("heartbeat_timeout");
    }
    const stale = reasons.length > 0;
    return {
      scope: lease.scope, leaseId: lease.leaseId, owner: lease.owner,
      stale, reasons, now: toIso(now),
      acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt, staleAt: lease.staleAt,
      fencingToken: lease.fencingToken,
      recommendation: stale ? "confirm_stale" : "none",
    };
  }

  // ─── markStale（过期转 STALE，受控 writer，P-001 §13.2） ─────────────
  markStale(leaseId, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const lease = this._leases.get(leaseId);
    if (!lease) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { leaseId } });
    }
    if (lease.releasedAt) {
      throw new CoordinationError("ERR_INVALID_STATE", { details: { leaseId, reason: "released lease cannot be marked stale" } });
    }
    if (lease.staleAt) {
      return this._snapshot(lease); // 幂等
    }
    const expiredByTime = toMs(lease.expiresAt) <= now;
    const evidence = normalizeEvidence(opts.evidence);
    const reason = opts.reason || (expiredByTime ? "lease_expired" : "declared_stale");
    if (!expiredByTime && evidence.length === 0) {
      // 活跃租约需证据才能判 stale（心跳/进程证据等）
      throw new CoordinationError("ERR_MISSING_EVIDENCE", {
        details: { leaseId, reason: "active lease requires evidence to declare stale", expiresAt: lease.expiresAt },
      });
    }
    lease.staleAt = toIso(now);
    this._auditLog({
      eventType: "task.stale", scope: lease.scope, leaseId: lease.leaseId,
      actor: opts.actorId || lease.actorId, fencingToken: lease.fencingToken,
      reason, evidence,
      details: {
        state: STALE_STATE, owner: lease.owner, expiredByTime,
        expiresAt: lease.expiresAt, staleAt: lease.staleAt,
      },
    });
    return this._snapshot(lease);
  }

  // ─── Takeover（两阶段，P-001 §13.3） ────────────────────────────────

  // 阶段一：请求接管 -> TAKEOVER_REQUESTED
  requestTakeover(scope, requester, opts = {}) {
    if (!scope || typeof scope !== "string") {
      throw new CoordinationError("ERR_INVALID_STATE", { details: { reason: "scope required" } });
    }
    if (!requester || typeof requester !== "string") {
      throw new CoordinationError("ERR_INVALID_ACTOR", { details: { reason: "requester required" } });
    }
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const timeout = typeof opts.takeoverTtl === "number" && opts.takeoverTtl > 0
      ? opts.takeoverTtl : DEFAULT_TAKEOVER_TIMEOUT_MS;
    const evidence = normalizeEvidence(opts.evidence);

    const prev = this._latestLeaseForScope(scope);
    if (!prev) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { scope, reason: "no lease to take over" } });
    }
    if (prev.releasedAt) {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { scope, reason: "scope already released; acquire directly", leaseId: prev.leaseId },
      });
    }
    if (prev.owner === requester) {
      throw new CoordinationError("ERR_LEASE_OWNER_MISMATCH", {
        details: { scope, reason: "cannot take over own lease", owner: requester },
      });
    }
    const pending = this._pendingTakeoverForScope(scope);
    if (pending) {
      if (pending.requester === requester) {
        return this._snapshotRequest(pending); // 幂等
      }
      throw new CoordinationError("ERR_LEASE_CONFLICT", {
        details: { scope, reason: "another takeover pending", existingRequestId: pending.requestId, existingRequester: pending.requester },
      });
    }

    const req = {
      requestId: this._nextRequestId(),
      scope,
      requester,
      previousOwner: prev.owner,
      previousLeaseId: prev.leaseId,
      requestedAt: toIso(now),
      deadline: toIso(now + timeout),
      completedAt: null,
      expiredAt: null,
      cancelledAt: null,
      status: "pending",
      newLeaseId: null,
      recoveryEvidence: null,
    };
    this._takeovers.set(req.requestId, req);
    if (!this._takeoversByScope.has(scope)) this._takeoversByScope.set(scope, []);
    this._takeoversByScope.get(scope).push(req.requestId);
    this._auditLog({
      eventType: "task.takeover_requested", scope, leaseId: prev.leaseId,
      actor: opts.actorId || requester, fencingToken: prev.fencingToken,
      reason: "takeover_requested", evidence,
      details: {
        state: TAKEOVER_REQUESTED_STATE, requester, previousOwner: prev.owner,
        deadline: req.deadline, timeoutMs: timeout,
      },
    });
    return this._snapshotRequest(req);
  }

  // 阶段二（成功）：TAKEN_OVER，新 owner 取得更高 fencing token 的新租约
  completeTakeover(requestId, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const req = this._takeovers.get(requestId);
    if (!req) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { requestId } });
    }
    if (req.status !== "pending") {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { requestId, status: req.status, reason: "takeover not pending" },
      });
    }
    if (now > toMs(req.deadline)) {
      // 超时：不能完成，需先 expireTakeover 回 STALE
      throw new CoordinationError("ERR_TAKEOVER_REQUEST_TIMEOUT", {
        details: { requestId, deadline: req.deadline, now: toIso(now), reason: "past deadline; expire required" },
      });
    }
    const recoveryEvidence = normalizeEvidence(opts.recoveryEvidence);
    const prev = this._leases.get(req.previousLeaseId);
    const prevReleased = !!(prev && prev.releasedAt);
    // 旧租约未释放 -> 需要 recovery evidence（P-001 §13.3）
    if (!prevReleased && recoveryEvidence.length === 0) {
      throw new CoordinationError("ERR_MISSING_EVIDENCE", {
        details: { requestId, reason: "takeover completion requires recovery evidence unless previous lease released", previousLeaseId: req.previousLeaseId, previousReleased: prevReleased },
      });
    }
    const ttl = typeof opts.ttl === "number" && opts.ttl > 0 ? opts.ttl : DEFAULT_LEASE_TTL_MS;
    const actorId = opts.actorId || req.requester;

    // 旧租约若仍活跃 -> 标记为已释放（原 owner 已停止 / 租约回收）
    if (prev && !prev.releasedAt && !prev.staleAt) {
      prev.releasedAt = toIso(now);
      this._auditLog({
        eventType: "ownership.released", scope: req.scope, leaseId: prev.leaseId, actor: actorId,
        fencingToken: prev.fencingToken, reason: "takeover_recovery",
        evidence: recoveryEvidence,
        details: { owner: prev.owner, takeover: true, requestId },
      });
    }

    const lease = this._createLease({
      scope: req.scope, owner: req.requester, actorId, ttl, now,
      takeover: true, recoveredFrom: req.previousLeaseId,
    });
    req.status = "completed";
    req.completedAt = toIso(now);
    req.newLeaseId = lease.leaseId;
    req.recoveryEvidence = recoveryEvidence;

    this._auditLog({
      eventType: "ownership.acquired", scope: req.scope, leaseId: lease.leaseId, actor: actorId,
      fencingToken: lease.fencingToken, reason: "takeover_acquired", evidence: recoveryEvidence,
      details: { owner: lease.owner, takeover: true, recoveredFrom: lease.recoveredFrom, requestId },
    });
    this._auditLog({
      eventType: "task.taken_over", scope: req.scope, leaseId: lease.leaseId, actor: actorId,
      fencingToken: lease.fencingToken, reason: "taken_over", evidence: recoveryEvidence,
      details: {
        state: TAKEN_OVER_STATE, previousOwner: req.previousOwner, newOwner: req.requester,
        previousLeaseId: req.previousLeaseId, newLeaseId: lease.leaseId,
        requestId, recoveryEvidence,
      },
    });
    return { request: this._snapshotRequest(req), lease: this._snapshot(lease) };
  }

  // 阶段二（超时）：TAKEOVER_REQUESTED 超时回 STALE + 审计
  isTakeoverExpired(requestId, opts = {}) {
    const clock = opts.clock || this._clock;
    const req = this._takeovers.get(requestId);
    if (!req) return false;
    if (req.status !== "pending") return false;
    return clock.now() > toMs(req.deadline);
  }

  expireTakeover(requestId, opts = {}) {
    const clock = opts.clock || this._clock;
    const now = clock.now();
    const req = this._takeovers.get(requestId);
    if (!req) {
      throw new CoordinationError("ERR_LEASE_NOT_FOUND", { details: { requestId } });
    }
    if (req.status !== "pending") {
      throw new CoordinationError("ERR_INVALID_STATE", {
        details: { requestId, status: req.status, reason: "takeover not pending" },
      });
    }
    if (now <= toMs(req.deadline)) {
      // 未超时：no-op，仍 pending
      return { expired: false, request: this._snapshotRequest(req) };
    }

    req.status = "expired";
    req.expiredAt = toIso(now);
    const evidence = normalizeEvidence(opts.evidence);
    const prev = this._leases.get(req.previousLeaseId);
    let staleRecord = null;
    if (prev && !prev.releasedAt && !prev.staleAt) {
      prev.staleAt = toIso(now);
      staleRecord = this._snapshot(prev);
    }
    const audit = this._auditLog({
      eventType: "task.stale", scope: req.scope, leaseId: req.previousLeaseId,
      actor: opts.actorId || null, fencingToken: prev ? prev.fencingToken : null,
      reason: "takeover_timeout", evidence,
      details: {
        state: STALE_STATE,
        errorCode: "ERR_TAKEOVER_REQUEST_TIMEOUT",
        code: CODES.ERR_TAKEOVER_REQUEST_TIMEOUT.code,
        requestId, requester: req.requester, previousOwner: req.previousOwner,
        deadline: req.deadline, expiredAt: req.expiredAt,
        leaseMarkedStale: !!(prev && prev.staleAt),
      },
    });
    return { expired: true, request: this._snapshotRequest(req), staleRecord, auditEntry: audit };
  }

  getTakeoverRequest(requestId) {
    return this._snapshotRequest(this._takeovers.get(requestId));
  }

  listTakeovers(opts = {}) {
    const status = opts.status;
    const out = [];
    for (const req of this._takeovers.values()) {
      if (!status || req.status === status) out.push(this._snapshotRequest(req));
    }
    return out;
  }

  // ─── 审计日志 ────────────────────────────────────────────────────────
  getAuditLog(opts = {}) {
    let entries = this._audit;
    if (opts.eventType) entries = entries.filter((e) => e.eventType === opts.eventType);
    if (opts.scope) entries = entries.filter((e) => e.scope === opts.scope);
    if (opts.leaseId) entries = entries.filter((e) => e.leaseId === opts.leaseId);
    return entries.map((e) => ({ ...e, evidence: [...e.evidence], details: { ...e.details } }));
  }

  clearAuditLog() {
    this._audit = [];
  }
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  LeaseManager,
  defaultClock,
  createManualClock,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_TAKEOVER_TIMEOUT_MS,
  AUDIT_EVENT_TYPES,
};
