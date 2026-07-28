"use strict";

// ─── Stable Coordination Error Codes ───────────────────────────────────────
// Bilingual single source: every code has zh/en descriptions.
// New codes must be appended; existing codes never change meaning or number.
// Code range: 1000-1999 reserved for coordination.

const CODES = {
  ERR_INVALID_TRANSITION: {
    code: 1001,
    zh: "状态转换非法",
    en: "State transition not allowed",
    description: { zh: "当前状态不允许转换到目标状态", en: "Current state does not allow transition to target state" },
  },
  ERR_INVALID_EVENT: {
    code: 1002,
    zh: "事件格式无效",
    en: "Event format invalid",
    description: { zh: "事件信封缺少必填字段或字段类型错误", en: "Event envelope missing required fields or field type mismatch" },
  },
  ERR_LEASE_CONFLICT: {
    code: 1003,
    zh: "租约冲突",
    en: "Lease conflict",
    description: { zh: "该作用域已被其他执行者持有租约", en: "Scope is already held by another owner" },
  },
  ERR_LEASE_EXPIRED: {
    code: 1004,
    zh: "租约已过期",
    en: "Lease expired",
    description: { zh: "所有权租约已过期，需先续期或重新获取", en: "Ownership lease has expired, renew or re-acquire required" },
  },
  ERR_SEQUENCE_GAP: {
    code: 1005,
    zh: "序列号跳跃",
    en: "Sequence gap detected",
    description: { zh: "事件序列号不连续，需 reconcile", en: "Event sequence is non-contiguous, reconcile required" },
  },
  ERR_DUPLICATE_EVENT: {
    code: 1006,
    zh: "重复事件",
    en: "Duplicate event ID",
    description: { zh: "相同 eventId 已存在，返回已有结果", en: "Event ID already exists, returning previous result" },
  },
  ERR_REVISION_MISMATCH: {
    code: 1007,
    zh: "修订号不匹配",
    en: "Revision mismatch",
    description: { zh: "快照 revision 不匹配，并发更新冲突", en: "Snapshot revision mismatch, concurrent update conflict" },
  },
  ERR_ACTOR_MISMATCH: {
    code: 1008,
    zh: "执行者不匹配",
    en: "Actor mismatch",
    description: { zh: "当前执行者无权执行此状态转换", en: "Current actor not authorized for this state transition" },
  },
  ERR_INVALID_STATE: {
    code: 1009,
    zh: "状态无效",
    en: "Invalid state",
    description: { zh: "当前状态不允许此操作", en: "Current state does not allow this operation" },
  },
  ERR_ACK_ALREADY: {
    code: 1010,
    zh: "已确认",
    en: "Already acknowledged",
    description: { zh: "该事件已被消费者确认", en: "Event has already been acknowledged by consumer" },
  },
  ERR_ACK_NOT_FOUND: {
    code: 1011,
    zh: "事件未找到",
    en: "Event not found for ACK",
    description: { zh: "待确认的事件 ID 不存在", en: "Event ID to acknowledge does not exist" },
  },
  ERR_CURSOR_INVALID: {
    code: 1012,
    zh: "游标无效",
    en: "Invalid cursor",
    description: { zh: "消费者游标引用不合法", en: "Consumer cursor reference is invalid" },
  },
  ERR_CONSUMER_NOT_FOUND: {
    code: 1013,
    zh: "消费者未找到",
    en: "Consumer not found",
    description: { zh: "指定的消费者 ID 不存在", en: "Specified consumer ID does not exist" },
  },
  ERR_EVENT_TOO_LARGE: {
    code: 1014,
    zh: "事件过大",
    en: "Event too large",
    description: { zh: "事件大小超过限制", en: "Event size exceeds maximum allowed" },
  },
  ERR_INVALID_EVENT_TYPE: {
    code: 1015,
    zh: "事件类型无效",
    en: "Invalid event type",
    description: { zh: "事件类型不在词汇表中", en: "Event type not in vocabulary" },
  },
  ERR_INVALID_ACTOR: {
    code: 1016,
    zh: "执行者规格无效",
    en: "Invalid actor specification",
    description: { zh: "执行者缺少 actorId 或 kind 字段", en: "Actor missing required actorId or kind field" },
  },
  ERR_MISSING_EVIDENCE: {
    code: 1017,
    zh: "缺少证据",
    en: "Missing evidence",
    description: { zh: "此转换要求提供证据引用", en: "This transition requires evidence references" },
  },
  ERR_MISSING_REQUESTED_ACTION: {
    code: 1018,
    zh: "缺少请求动作",
    en: "Missing requested action",
    description: { zh: "WAITING_FOR_INPUT 状态需要 requestedAction", en: "WAITING_FOR_INPUT state requires a requestedAction" },
  },
  ERR_EVENT_NOT_LEGAL: {
    code: 1019,
    zh: "事件非法",
    en: "Event not legal for current state",
    description: { zh: "当前状态不允许该事件类型", en: "Current state does not allow this event type" },
  },
  ERR_SCHEMA_VERSION_UNKNOWN: {
    code: 1020,
    zh: "Schema 版本未知",
    en: "Unknown schema version",
    description: { zh: "未知的 schemaVersion major，拒绝处理", en: "Unknown schemaVersion major, rejecting" },
  },
  ERR_EVIDENCE_REF_INVALID: {
    code: 1021,
    zh: "证据引用格式无效",
    en: "Evidence reference format invalid",
    description: { zh: "evidence.ref 仅允许注册 artifact ID、稳定 resource ref 或 repo-relative path", en: "evidence.ref only allows registered artifact ID, stable resource ref, or repo-relative path" },
  },
  ERR_LEASE_NOT_FOUND: {
    code: 1022,
    zh: "租约未找到",
    en: "Lease not found",
    description: { zh: "指定的租约 ID 不存在", en: "Specified lease ID does not exist" },
  },
  ERR_LEASE_OWNER_MISMATCH: {
    code: 1023,
    zh: "租约执行者不匹配",
    en: "Lease owner mismatch",
    description: { zh: "只有租约持有者才能续期或释放租约", en: "Only the lease owner can renew or release the lease" },
  },
  ERR_TAKEOVER_REQUEST_TIMEOUT: {
    code: 1024,
    zh: "接管请求超时",
    en: "Takeover request timeout",
    description: { zh: "TAKEOVER_REQUESTED 超时，回退到 STALE 并写审计事件", en: "TAKEOVER_REQUESTED timed out, reverting to STALE with audit event" },
  },
  ERR_ABSENT_NO_EVENT: {
    code: 1025,
    zh: "ABSENT 状态不允许事件",
    en: "No event allowed in ABSENT",
    description: { zh: "隐式 ABSENT 状态仅允许 task.created 事件", en: "Implicit ABSENT state only allows task.created event" },
  },
  ERR_COMPLETED_RUN_PHASE_PROTECTED: {
    code: 1026,
    zh: "COMPLETED 同步 Run 时不可覆盖阶段",
    en: "COMPLETED sync to Run must not overwrite phase",
    description: { zh: "COMPLETED 同步 Run 时只能 append event/evidence ref，不得覆盖 Run.phase", en: "COMPLETED syncing to Run may only append event/evidence ref, must not overwrite Run.phase" },
  },
};

// Stable error class with machine-readable code + bilingual message.
class CoordinationError extends Error {
  constructor(key, extra = {}) {
    const def = CODES[key];
    if (!def) {
      super(`Unknown coordination error: ${key}`);
      this.code = 1999;
      this.key = "ERR_UNKNOWN";
      this.zh = "未知协调错误";
      this.en = "Unknown coordination error";
    } else {
      super(def.en);
      this.code = def.code;
      this.key = key;
      this.zh = def.zh;
      this.en = def.en;
    }
    this.name = "CoordinationError";
    if (extra.cause) this.cause = extra.cause;
    if (extra.details) this.details = extra.details;
  }
}

function byCode(code) {
  for (const [key, def] of Object.entries(CODES)) {
    if (def.code === code) return { key, ...def };
  }
  return null;
}

function byKey(key) {
  return CODES[key] || null;
}

module.exports = {
  CODES,
  CoordinationError,
  byCode,
  byKey,
};