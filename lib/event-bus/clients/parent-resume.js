"use strict";

/**
 * lib/event-bus/clients/parent-resume.js
 *
 * M-004 MS-003 / F-006 — parent-resume client.
 *
 * Finite State Machine (FSM) with 5 states:
 *
 *   INIT → RECEIVED → ACKED → RUNNING → DONE   (happy path)
 *                            \--------→ FAILED (1+ sub failed + escalate)
 *
 * Triggered by event-bus 5 类 core event (handled by `handle(event, ctx)`):
 *
 *   eb:subagent_spawned   → INIT → RECEIVED
 *   eb:subagent_progress  → RECEIVED → ACKED   (throttled ≥ 10%, see MS-002 bridge)
 *   eb:subagent_completed → ACKED → RUNNING → DONE   (triggers parent resume)
 *   eb:subagent_failed    → ACKED → RUNNING → FAILED  (triggers parent resume + escalate)
 *   eb:subagent_cancelled → ACKED → RUNNING → DONE   (triggers parent resume)
 *
 * P-003 integration (read P-003 lib/cross-project/* — 0 mutation of P-003):
 *   - 写 P-003 inbox  (lib/cross-project/inbox-store.js) for each sub event
 *   - 读 P-003 subscriptions (lib/cross-project/subscriptions.js) to verify
 *     父 mission_id 与 source project 绑定
 *   - 父 FSM DONE 时触发 P-003 bridge sync (mock — log only, leaves real sync to bridge-sync.js)
 *
 * Lease 校验 (D-FAE-002-4):
 *   - 父 mission_id 必须有 active lease (由 leaseProvider 提供)
 *   - lease 失效 / 错配 → 3 次 retry + 写 decision
 *     `.agent/decisions/D-ESC-<mission_id>-<ts>.json` 让 Eric 人工介入
 *
 * 安全 (Security):
 *   - 拒绝 mission_id 不在 `.agent/missions/` 的 event (避免恶意 mission 触发)
 *   - 拒绝 parent_id 跟 active mission 不匹配的 event (避免 parent 误 resume 错 mission)
 *
 * API:
 *   - parentResume.handle(event, ctx) → { ack, next_state, resume_action, ... }
 *   - parentResume.subscribe(bus, missionId, opts?) → subscription_handle
 *   - parentResume.unsubscribe(handle) → boolean
 *   - parentResume.listActive() → Array<{ mission_id, subagent_id, state, last_event_at }>
 *   - parentResume.setLeaseProvider(provider)        (test hook)
 *   - parentResume.setBridgeSyncTrigger(triggerFn)   (test hook)
 *   - parentResume.setRootDir(path)                  (test hook)
 *   - parentResume._resetForTests()                  (test hook)
 *
 * 零依赖 — 只用 node:fs / node:path / node:crypto.
 *
 * References:
 *   - docs/architecture/framework-event-bus-design.md §3.3, §4.4, §5
 *   - .agent/missions/M-004/handoffs/20260806-224500-ms-003-spec-done.md
 *   - D-FAE-002-4 (parent-resume 失败回滚)
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths } = require("../../runtime-layout");

// Lazy-required P-003 modules (P-003 不可修改, MS-003 仅 read)
let _inboxStore = null;
let _subscriptions = null;
function _requireP3() {
  if (!_inboxStore) _inboxStore = require("../../cross-project/inbox-store");
  if (!_subscriptions) _subscriptions = require("../../cross-project/subscriptions");
  return { inboxStore: _inboxStore, subscriptions: _subscriptions };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FSM_STATES = Object.freeze(["INIT", "RECEIVED", "ACKED", "RUNNING", "DONE", "FAILED"]);

const CORE_TRIGGERS = new Set([
  "subagent_spawned",
  "subagent_progress",
  "subagent_completed",
  "subagent_failed",
  "subagent_cancelled",
]);

const PROGRESS_THROTTLE_PERCENT = 10; // 跟 MS-002 bridge 一致
const DEFAULT_RETRY_LIMIT = 3;        // D-FAE-002-4
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 min (跟 lib/coordination/lease.js 一致)

// ---------------------------------------------------------------------------
// Module-level state (in-memory FSM + retry counter, keyed by mission_id+subagent_id)
// ---------------------------------------------------------------------------

// active FSMs: key = "<mission_id>::<subagent_id>" -> fsmState
const _fsm = new Map();

// retry counter for lease failures: key = "<mission_id>::<subagent_id>" -> count
const _retry = new Map();

// active subscriptions: subscriptionId -> { mission_id, bus, sub }
const _subs = new Map();

// last event seen per mission/sub: key -> { state, last_event_at, event_id }
const _lastSeen = new Map();

// injectable hooks (testable seams)
let _leaseProvider = null;
let _bridgeSyncTrigger = null;
let _rootDir = null;
let _inboxWriteEnabled = true; // P-003 integration opt-out for tests

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _fsmKey(missionId, subagentId) {
  return `${missionId || "global"}::${subagentId || "host"}`;
}

function _nowIso() {
  return new Date().toISOString();
}

function _ensureRootDir() {
  const root = _rootDir || process.cwd();
  return path.resolve(root);
}

function _missionsDir() {
  return path.join(_ensureRootDir(), ".agent", "missions");
}

function _decisionsDir() {
  return path.join(_ensureRootDir(), ".agent", "decisions");
}

/**
 * Security: verify mission_id exists in .agent/missions/<id>/ directory.
 * Returns true if a mission_id is "global" (framework internal, no mission) or
 * if the mission directory exists. Returns false for unknown / malicious ids.
 */
function _missionExists(missionId) {
  if (!missionId || missionId === "global") return true; // framework internal
  if (typeof missionId !== "string") return false;
  // Strict: no path traversal
  if (missionId.indexOf("/") !== -1 || missionId.indexOf("\\") !== -1) return false;
  if (missionId.indexOf("..") !== -1) return false;
  const dir = path.join(_missionsDir(), missionId);
  try {
    return fs.existsSync(dir);
  } catch (_) {
    return false;
  }
}

/**
 * Security: verify producer_id (parent_id) matches the active mission owner.
 * If mission_lease has held_by, producer.producer_id must equal it (or be in
 * the producer_kind allowlist for parent_agent / scheduler).
 */
function _parentIdMatches(producer, missionId) {
  if (!producer) return true; // no producer ctx → can't verify, allow (rare)
  if (producer.producer_kind === "cli" || producer.producer_kind === "adapter") return true;
  if (!missionId || missionId === "global") return true;
  if (!_leaseProvider) return true; // no provider → can't verify
  const lease = _leaseProvider.getActiveLease ? _leaseProvider.getActiveLease(missionId) : null;
  if (!lease) return true; // no active lease → fail open on parent_id check (lease_check itself will catch)
  if (lease.held_by && producer.producer_id && lease.held_by !== producer.producer_id) return false;
  return true;
}

// Default lease provider: read leases.json via shared runtime-layout API (best-effort)
// MS-003: uses shared runtime-layout API (VC-011)
function _defaultLeaseProvider() {
  return {
    isLeaseActive(missionId) {
      if (!missionId) return false;
      const file = _leasesFilePath();
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (_) {
        return false; // no lease file → treat as inactive (reject)
      }
      try {
        const parsed = JSON.parse(raw);
        const lease = parsed.leases && parsed.leases[missionId];
        if (!lease) return false;
        if (lease.released_at) return false;
        if (lease.stale_at) return false;
        if (lease.expires_at) {
          const expires = Date.parse(lease.expires_at);
          if (Number.isNaN(expires)) return false;
          if (expires < Date.now()) return false;
        }
        return true;
      } catch (_) {
        return false;
      }
    },
    getActiveLease(missionId) {
      if (!missionId) return null;
      const file = _leasesFilePath();
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (_) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        return parsed.leases && parsed.leases[missionId] ? parsed.leases[missionId] : null;
      } catch (_) {
        return null;
      }
    },
    listActive() {
      const file = _leasesFilePath();
      let raw;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (_) {
        return [];
      }
      try {
        const parsed = JSON.parse(raw);
        const leases = (parsed.leases && typeof parsed.leases === "object") ? parsed.leases : {};
        const out = [];
        const now = Date.now();
        for (const [mid, lease] of Object.entries(leases)) {
          if (!lease) continue;
          if (lease.released_at) continue;
          if (lease.stale_at) continue;
          if (lease.expires_at) {
            const expires = Date.parse(lease.expires_at);
            if (!Number.isNaN(expires) && expires < now) continue;
          }
          out.push({ mission_id: mid, ...lease });
        }
        return out;
      } catch (_) {
        return [];
      }
    },
  };
}

// MS-003: Get leases.json path using shared runtime-layout API
// Uses new-first/legacy-fallback per VC-012 compatibility window
function _leasesFilePath() {
  const paths = resolveRuntimePaths(_ensureRootDir());
  // During compat window: prefer legacy if exists, else new
  // After activation: always use new
  if (paths.legacyExists && !paths.activated) {
    return path.join(paths.coordination.legacy, "leases.json");
  }
  return path.join(paths.coordination.new, "leases.json");
}

function _effectiveLeaseProvider() {
  return _leaseProvider || _defaultLeaseProvider();
}

// Default bridge sync trigger: log to bus's hook map (read-only mock).
function _defaultBridgeSyncTrigger() {
  return function bridgeSyncTrigger({ missionId, subagentId, eventName, aggregatedCount }) {
    // noop default — P-003 bridge-sync is invoked separately via `bridge sync --source-root`
    return { ok: true, mocked: true, missionId, subagentId, eventName, aggregatedCount };
  };
}

function _effectiveBridgeSyncTrigger() {
  return _bridgeSyncTrigger || _defaultBridgeSyncTrigger();
}

// ---------------------------------------------------------------------------
// P-003 inbox write (best-effort; never throws to caller)
// ---------------------------------------------------------------------------

function _writeInboxSafe(missionId, event) {
  if (!_inboxWriteEnabled) return { ok: false, reason: "disabled" };
  try {
    const { inboxStore } = _requireP3();
    // Map event-bus envelope → P-003 bridge event shape
    const bridgeEvent = {
      bridge_event_id: "BR-EVT-" + (event.event_id || crypto.randomUUID()),
      source_project_id: missionId,
      source_task_id: event.correlation && event.correlation.subagent_id ? event.correlation.subagent_id : "host",
      correlation_group: missionId,
      event_type: _mapToBridgeEventType(event.event_name),
      summary: {
        subagent_id: event.correlation ? event.correlation.subagent_id : null,
        event_name: event.event_name,
        payload: event.payload || {},
        producer: event.producer,
      },
      propagated_at: event.occurred_at || _nowIso(),
    };
    const result = inboxStore.writeInboxEntry(_ensureRootDir(), missionId, bridgeEvent);
    return { ok: true, path: result.path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function _mapToBridgeEventType(eventName) {
  switch (eventName) {
    case "subagent_spawned":   return "task.state_changed";
    case "subagent_progress":  return "task.state_changed";
    case "subagent_completed": return "task.state_changed";
    case "subagent_failed":    return "decision.resolved";
    case "subagent_cancelled": return "task.state_changed";
    default:                   return "task.state_changed";
  }
}

function _readSubscriptionsSafe(missionId) {
  try {
    const { subscriptions } = _requireP3();
    return subscriptions.readSubscriptions(_ensureRootDir());
  } catch (_) {
    return { subscriptions: [] };
  }
}

// ---------------------------------------------------------------------------
// Escalation decision writer (D-FAE-002-4)
// ---------------------------------------------------------------------------

function _writeEscalationDecision(missionId, subagentId, reason, attempt) {
  const dir = _decisionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `D-ESC-${missionId}-${ts}.json`);
  const decision = {
    schema_version: 1,
    decision_id: `D-ESC-${missionId}-${ts}`,
    type: "parent_resume_escalation",
    status: "open",
    severity: "high",
    awaiting_user_intervention: true,
    mission_id: missionId,
    subagent_id: subagentId,
    reason,
    retry_count: attempt,
    attempt,
    retry_limit: DEFAULT_RETRY_LIMIT,
    created_at: new Date().toISOString(),
    next_steps: [
      "review the failing sub-agent / mission state",
      "decide whether to resume the mission manually or abort",
      "after resolution, mark this decision resolved (status=resolved)",
    ],
  };
  const data = JSON.stringify(decision, null, 2) + "\n";
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// FSM transition logic
// ---------------------------------------------------------------------------

function _initialStateFor(eventName) {
  switch (eventName) {
    case "subagent_spawned":   return "RECEIVED";
    case "subagent_progress":  return "ACKED";
    case "subagent_completed": return "DONE";
    case "subagent_failed":    return "FAILED";
    case "subagent_cancelled": return "DONE";
    default:                   return "RECEIVED";
  }
}

function _transition(current, eventName, ctx) {
  // State transition table per FSM design (D-FAE-002-4, §3.3)
  const next = { state: current, resume_action: null, terminal: false };

  if (eventName === "subagent_spawned") {
    // INIT → RECEIVED
    if (current === "INIT" || current === "RECEIVED") {
      next.state = "RECEIVED";
    } else {
      // idempotent: stay in current
      next.state = current;
    }
    return next;
  }
  if (eventName === "subagent_progress") {
    // RECEIVED → ACKED (only if percent - last ≥ 10% — throttled)
    const percent = ctx && ctx.percent != null ? Number(ctx.percent) : null;
    if (current === "RECEIVED" || current === "ACKED") {
      next.state = "ACKED";
    } else if (current === "INIT") {
      next.state = "RECEIVED"; // progress before spawn → soft
    }
    // throttle side note: caller should pre-throttle (MS-002 bridge does this)
    void percent;
    return next;
  }
  if (eventName === "subagent_completed") {
    // ACKED → RUNNING → DONE
    next.state = "DONE";
    next.resume_action = "resume_parent";
    next.terminal = true;
    return next;
  }
  if (eventName === "subagent_failed") {
    // ACKED → RUNNING → FAILED
    next.state = "FAILED";
    next.resume_action = "resume_parent_with_failure";
    next.terminal = true;
    return next;
  }
  if (eventName === "subagent_cancelled") {
    // ACKED → RUNNING → DONE (cancel 不阻止 resume)
    next.state = "DONE";
    next.resume_action = "resume_parent";
    next.terminal = true;
    return next;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a single event from the event-bus. Returns an object with the FSM
 * transition outcome. The shape is intentionally rich (next_state, lease_check,
 * inbox_write, p3_subscriptions, resume_action, ack, retry_count, ...) so
 * callers / tests can assert on each layer.
 *
 * @param {object} event  - full event-bus envelope
 * @param {object} ctx    - { subscription_id?, mission_id?, subagent_id?, producer?, ... }
 * @returns {object} { ack, next_state, resume_action, lease_check, inbox_write,
 *                     p3_subscriptions, retry_count, escalation?, reason? }
 */
function handle(event, ctx) {
  if (!event || typeof event !== "object") {
    return { ack: false, next_state: "INIT", reason: "invalid event" };
  }
  const eventName = event.event_name;
  if (!eventName || !CORE_TRIGGERS.has(eventName)) {
    // Not a parent-resume trigger → ack (let other clients handle) without FSM change
    return { ack: true, next_state: "INIT", ignored: true, reason: `event ${eventName || "?"} not in parent-resume trigger set` };
  }

  const missionId = (event.correlation && event.correlation.mission_id) || (ctx && ctx.mission_id) || "global";
  const subagentId = (event.correlation && event.correlation.subagent_id) || (ctx && ctx.subagent_id) || "host";
  const producer = event.producer || (ctx && ctx.producer) || null;
  const key = _fsmKey(missionId, subagentId);

  // ── Security: mission_id must exist in .agent/missions/<id>/
  if (!_missionExists(missionId)) {
    return {
      ack: false,
      next_state: "INIT",
      rejected: true,
      reason: `mission_id ${JSON.stringify(missionId)} not found in .agent/missions/`,
      mission_id: missionId,
    };
  }

  // ── Security: parent_id / producer_id must match active mission owner
  if (!_parentIdMatches(producer, missionId)) {
    return {
      ack: false,
      next_state: _fsm.get(key) || "INIT",
      rejected: true,
      reason: `producer_id ${producer && producer.producer_id} does not match active mission lease holder`,
      mission_id: missionId,
    };
  }

  // ── Lease check (D-FAE-002-4)
  const leaseProvider = _effectiveLeaseProvider();
  const leaseActive = missionId === "global" || (leaseProvider.isLeaseActive && leaseProvider.isLeaseActive(missionId));
  const leaseCheck = {
    active: !!leaseActive,
    mission_id: missionId,
    provider: leaseProvider === _defaultLeaseProvider() ? "default" : "injected",
  };

  if (!leaseActive) {
    // Increment retry counter
    const attempt = (_retry.get(key) || 0) + 1;
    _retry.set(key, attempt);

    if (attempt >= DEFAULT_RETRY_LIMIT) {
      // Write escalation decision
      const decisionPath = _writeEscalationDecision(
        missionId,
        subagentId,
        `lease invalid after ${attempt} retries`,
        attempt,
      );
      return {
        ack: false,
        next_state: "FAILED",
        lease_check: leaseCheck,
        retry_count: attempt,
        escalation: { decision_path: decisionPath, type: "parent_resume_escalation" },
        reason: "lease_invalid_escalated",
        mission_id: missionId,
        subagent_id: subagentId,
      };
    }

    return {
      ack: false,
      next_state: "RECEIVED",
      lease_check: leaseCheck,
      retry_count: attempt,
      reason: `lease invalid (attempt ${attempt}/${DEFAULT_RETRY_LIMIT})`,
      mission_id: missionId,
      subagent_id: subagentId,
    };
  }

  // Lease OK → reset retry counter
  _retry.delete(key);

  // ── Apply FSM transition
  const current = _fsm.get(key) || "INIT";
  const transition = _transition(current, eventName, event.payload || {});
  _fsm.set(key, transition.state);
  _lastSeen.set(key, {
    state: transition.state,
    last_event_at: _nowIso(),
    event_id: event.event_id,
    event_name: eventName,
  });

  // ── P-003 inbox write (best-effort, never blocks FSM)
  const inboxWrite = _writeInboxSafe(missionId, event);

  // ── P-003 subscriptions read (validate 父 mission_id 与 source binding)
  const p3Subs = _readSubscriptionsSafe(missionId);
  const p3Subscriptions = {
    count: Array.isArray(p3Subs.subscriptions) ? p3Subs.subscriptions.length : 0,
    matches: Array.isArray(p3Subs.subscriptions)
      ? p3Subs.subscriptions.filter((s) => s.source_project_id === missionId).length
      : 0,
  };

  // ── If terminal state, trigger P-003 bridge sync (mock) for aggregation
  let bridgeSync = null;
  if (transition.terminal) {
    const trigger = _effectiveBridgeSyncTrigger();
    bridgeSync = trigger({
      missionId,
      subagentId,
      eventName,
      aggregatedCount: 1, // single sub event; aggregated by caller (e.g. E2E runner)
      state: transition.state,
    });
  }

  return {
    ack: true,
    next_state: transition.state,
    resume_action: transition.resume_action,
    terminal: transition.terminal,
    lease_check: leaseCheck,
    inbox_write: inboxWrite,
    p3_subscriptions: p3Subscriptions,
    bridge_sync: bridgeSync,
    mission_id: missionId,
    subagent_id: subagentId,
    event_name: eventName,
    event_id: event.event_id,
    handled_at: _nowIso(),
  };
}

/**
 * Subscribe to a mission's lifecycle events on the bus.
 * @param {object} bus   - event-bus instance (from createEventBus)
 * @param {string} missionId
 * @param {object} [opts] - { ackTimeoutMs?, retryCount? }
 * @returns {string} subscription_id
 */
function subscribe(bus, missionId, opts) {
  if (!bus || typeof bus.subscribe !== "function") {
    throw new Error("parentResume.subscribe: bus.subscribe is required");
  }
  if (!missionId) {
    throw new Error("parentResume.subscribe: missionId is required");
  }
  opts = opts || {};
  const handler = function parentResumeHandler(event, ctx) {
    return handle(event, ctx);
  };
  // handler.name used by bus.subscribe for subs.json display
  Object.defineProperty(handler, "name", { value: "parent-resume" });

  const filter = {
    event_names: ["subagent_spawned", "subagent_progress", "subagent_completed", "subagent_failed", "subagent_cancelled"],
  };
  if (missionId !== "global") filter.correlation = { mission_id: missionId };

  const subscriptionId = bus.subscribe(filter, handler, {
    ackTimeoutMs: opts.ackTimeoutMs || 30000,
    retryCount: opts.retryCount !== undefined ? opts.retryCount : DEFAULT_RETRY_LIMIT,
  });

  _subs.set(subscriptionId, { mission_id: missionId, bus, filter });
  return subscriptionId;
}

/**
 * Unsubscribe and clear in-memory state.
 * @param {string} subscriptionId
 * @returns {boolean} true if found + removed
 */
function unsubscribe(subscriptionId) {
  if (!subscriptionId) return false;
  const entry = _subs.get(subscriptionId);
  if (!entry) return false;
  try {
    if (entry.bus && typeof entry.bus.unsubscribe === "function") {
      entry.bus.unsubscribe(subscriptionId);
    }
  } catch (_) { /* best-effort */ }
  _subs.delete(subscriptionId);
  return true;
}

/**
 * List all active FSM states across all subscribed missions.
 * @returns {Array<{ mission_id, subagent_id, state, last_event_at, event_id? }>}
 */
function listActive() {
  const out = [];
  for (const [key, info] of _lastSeen.entries()) {
    const [missionId, subagentId] = key.split("::");
    out.push({
      mission_id: missionId,
      subagent_id: subagentId,
      state: info.state,
      last_event_at: info.last_event_at,
      event_id: info.event_id,
      event_name: info.event_name,
    });
  }
  // Also include entries that have a state but no event yet (DONE/FAILED leftover)
  for (const [key, state] of _fsm.entries()) {
    if (_lastSeen.has(key)) continue;
    const [missionId, subagentId] = key.split("::");
    out.push({
      mission_id: missionId,
      subagent_id: subagentId,
      state,
      last_event_at: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

function setLeaseProvider(provider) {
  _leaseProvider = provider;
}

function setBridgeSyncTrigger(fn) {
  _bridgeSyncTrigger = fn;
}

function setRootDir(dir) {
  _rootDir = dir;
}

function setInboxWriteEnabled(enabled) {
  _inboxWriteEnabled = !!enabled;
}

function _resetForTests() {
  _fsm.clear();
  _retry.clear();
  _subs.clear();
  _lastSeen.clear();
  _leaseProvider = null;
  _bridgeSyncTrigger = null;
  _rootDir = null;
  _inboxWriteEnabled = true;
  // Reset module cache for P-3 requires so the next test uses fresh state
  try {
    delete require.cache[require.resolve("../../cross-project/inbox-store")];
    delete require.cache[require.resolve("../../cross-project/subscriptions")];
    delete require.cache[require.resolve("../../cross-project/bridge-event-schema")];
  } catch (_) { /* not loaded yet */ }
  _inboxStore = null;
  _subscriptions = null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // FSM
  FSM_STATES,
  CORE_TRIGGERS,
  PROGRESS_THROTTLE_PERCENT,
  DEFAULT_RETRY_LIMIT,

  // Public API
  handle,
  subscribe,
  unsubscribe,
  listActive,

  // Test hooks
  setLeaseProvider,
  setBridgeSyncTrigger,
  setRootDir,
  setInboxWriteEnabled,
  _resetForTests,
  _writeInboxSafe,           // exposed for tests
  _writeEscalationDecision,  // exposed for tests
  _missionExists,            // exposed for tests
  _parentIdMatches,          // exposed for tests
};
