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
  ERR_LEASE_IDEMPOTENCY_MISMATCH: {
    code: 1027,
    zh: "幂等键冲突",
    en: "Idempotency key conflict",
    description: { zh: "同一幂等键已被其他作用域或执行者占用", en: "Idempotency key is bound to a different scope or owner" },
  },
  ERR_LEASE_EVIDENCE_TAINTED: {
    code: 1028,
    zh: "证据包含敏感串",
    en: "Evidence contains sensitive value",
    description: { zh: "租约 evidence 不能包含 sk-… / MINIMAX_* / api[-_]?key / password 等敏感串", en: "Lease evidence must not contain sensitive strings such as sk-… / MINIMAX_* / api[-_]?key / password" },
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
  // ─── Protected permit store (M-044 / MS-003) ─────────────────────────────
  ERR_ANCHOR_REQUIRED: {
    code: 1029,
    zh: "必须提供受保护锚点目录",
    en: "Protected anchor directory is required",
    description: { zh: "受保护作用域的存储必须绑定锚点目录，缺失即拒绝启动", en: "A store in the protected scope must bind an anchor directory; a missing anchor refuses to start" },
  },
  ERR_ANCHOR_MISSING: {
    code: 1030,
    zh: "锚点不存在",
    en: "Anchor is missing",
    description: { zh: "锚点日志为空或缺失，无法证明高水位，拒绝启动", en: "The anchor journal is empty or missing, so the high-water mark cannot be proven; refuse to start" },
  },
  ERR_ANCHOR_CORRUPT: {
    code: 1031,
    zh: "锚点记录损坏",
    en: "Anchor record is corrupt",
    description: { zh: "锚点条目或高水位声明的摘要校验失败，拒绝启动", en: "The digest of an anchor entry or high-water declaration does not verify; refuse to start" },
  },
  ERR_ANCHOR_UNREADABLE: {
    code: 1032,
    zh: "锚点不可读",
    en: "Anchor is unreadable",
    description: { zh: "锚点目录或条目无法读取，拒绝启动", en: "The anchor directory or one of its entries cannot be read; refuse to start" },
  },
  ERR_ANCHOR_NOT_SEPARATE: {
    code: 1033,
    zh: "锚点与数据库未分离",
    en: "Anchor and database are not separate",
    description: { zh: "锚点目录与数据库目录互相包含，无法构成独立的回滚域", en: "The anchor directory and the database directory contain each other, so they do not form separate rollback domains" },
  },
  ERR_ANCHOR_DIR_MISSING: {
    code: 1034,
    zh: "锚点目录缺失",
    en: "Anchor directory is missing",
    description: { zh: "指定的锚点目录不存在", en: "The given anchor directory does not exist" },
  },
  ERR_ANCHOR_WRITE_INCOMPLETE: {
    code: 1035,
    zh: "锚点写入不完整",
    en: "Anchor write is incomplete",
    description: { zh: "锚点记录未能完整落盘，该事务不得生效", en: "The anchor record was not written completely; the transaction must not take effect" },
  },
  ERR_ANCHOR_DECLARATION_MISSING: {
    code: 1036,
    zh: "高水位声明缺失或为空",
    en: "High-water declaration is missing or empty",
    description: { zh: "高水位声明文件缺失或为空，第二见证失效，拒绝启动", en: "The high-water declaration file is missing or empty, so the second witness is void; refuse to start" },
  },
  ERR_ANCHOR_STORE_MISMATCH: {
    code: 1037,
    zh: "锚点存储身份不匹配",
    en: "Anchor store identity does not match",
    description: { zh: "锚点日志的存储身份与数据库不一致，拒绝采用该日志", en: "The store identity in the anchor journal differs from the database; refuse to adopt the journal" },
  },
  ERR_STATE_ROLLED_BACK: {
    code: 1038,
    zh: "数据库已回滚",
    en: "Database was rolled back",
    description: { zh: "数据库序列落后于锚点高水位，拒绝启动", en: "The database sequence is behind the anchor high-water mark; refuse to start" },
  },
  ERR_STATE_AHEAD_OF_ANCHOR: {
    code: 1039,
    zh: "数据库领先于锚点",
    en: "Database is ahead of the anchor",
    description: { zh: "数据库序列领先锚点且无悬空意图可证明，拒绝接受该状态", en: "The database sequence is ahead of the anchor and no dangling intent proves it; refuse the state" },
  },
  ERR_STATE_TAMPERED: {
    code: 1040,
    zh: "状态被篡改",
    en: "State was tampered with",
    description: { zh: "数据库内容与锚点见证的摘要不一致，拒绝启动", en: "The database body does not match the digest the anchor witnessed; refuse to start" },
  },
  ERR_CRASH_WINDOW_RECOVERABLE: {
    code: 1041,
    zh: "处于可恢复的崩溃窗口",
    en: "A recoverable crash window is present",
    description: { zh: "数据库已提交而锚点提交条目缺失，需走受管恢复入口", en: "The database committed but the anchor commit entry is missing; the managed recovery entry point is required" },
  },
  ERR_UNSAFE_PATH: {
    code: 1042,
    zh: "路径不安全",
    en: "Unsafe path",
    description: { zh: "路径包含符号链接或不是预期的常规文件，拒绝访问", en: "The path contains a symbolic link or is not the expected regular file; refuse access" },
  },
  ERR_AUDIT_WRITE_FAILED: {
    code: 1043,
    zh: "审计写入失败",
    en: "Audit write failed",
    description: { zh: "审计记录无法落盘，该事务不得提交", en: "The audit record could not be written, so the transaction must not commit" },
  },
  ERR_RECOVERY_AUDIT_REQUIRED: {
    code: 1044,
    zh: "恢复操作必须提供审计记录",
    en: "Recovery requires an audit record",
    description: { zh: "受管恢复入口必须提供操作者与原因", en: "A managed recovery entry point must name the operator and the reason" },
  },
  ERR_RECOVERY_NOT_APPLICABLE: {
    code: 1045,
    zh: "恢复不适用",
    en: "Recovery is not applicable",
    description: { zh: "当前状态不满足受管恢复的前置条件，拒绝恢复", en: "The current state does not meet the preconditions of a managed recovery; refuse to recover" },
  },
  ERR_ANCHOR_PERMISSIONS: {
    code: 1046,
    zh: "锚点域权限过宽",
    en: "Anchor domain permissions are too broad",
    description: { zh: "锚点目录或其文件对 group/other 可写，高水位见证不可信，拒绝启动", en: "The anchor directory or a file in it is writable by group or other, so the high-water witness is not trustworthy; refuse to start" },
  },
  ERR_ANCHOR_OWNERSHIP: {
    code: 1047,
    zh: "锚点域属主不可信",
    en: "Anchor domain ownership is not trustworthy",
    description: { zh: "锚点目录不属于声明的服务身份，属主可改写锚点域并替换全部见证，拒绝启动", en: "The anchor directory does not belong to the declared service identity, so its owner can rewrite the anchor domain and replace every witness; refuse to start" },
  },
  ERR_ANCHOR_MODE_DOWNGRADE: {
    code: 1048,
    zh: "锚点域权限模式被降级",
    en: "Anchor domain permission mode was downgraded",
    description: { zh: "调用方声明的锚点域权限模式弱于记录在案的模式，拒绝执行", en: "The caller states an anchor permission mode weaker than the recorded one; refuse to proceed" },
  },
  ERR_ANCHOR_MODE_INVALID: {
    code: 1049,
    zh: "锚点域权限模式非法",
    en: "Anchor domain permission mode is not a known mode",
    description: { zh: "锚点域权限模式既不是 strict 也不是 permissive，拒绝执行（不得按宽松处理）", en: "The anchor permission mode is neither strict nor permissive; refuse to proceed instead of treating it as permissive" },
  },
  ERR_ANCHOR_AUTHORIZATION_UNKNOWN: {
    code: 1050,
    zh: "锚点域授权模型不可判定",
    en: "Anchor domain authorization model cannot be determined",
    description: { zh: "平台原生授权模型无法枚举可写身份集合；判不出来不等于安全，拒绝启动", en: "The platform authorization model cannot enumerate the set of writable identities; not being able to decide is not the same as being safe, so refuse to start" },
  },
  ERR_ANCHOR_SERVICE_IDENTITY_INVALID: {
    code: 1051,
    zh: "声明的服务身份非法",
    en: "The declared service identity is invalid",
    description: { zh: "声明的服务身份无法归一化为平台身份值（uid 或 SID），拒绝启动", en: "The declared service identity cannot be normalized into a platform identity value (uid or SID); refuse to start" },
  },
  ERR_ANCHOR_SERVICE_IDENTITY_MISMATCH: {
    code: 1052,
    zh: "调用进程身份与服务身份不一致",
    en: "The calling process identity does not match the declared service identity",
    description: { zh: "调用进程身份不等于声明的服务身份，可能存在进程冒充服务身份，拒绝启动", en: "The calling process identity is not the declared service identity, so a process may be impersonating the service identity; refuse to start" },
  },
  ERR_ANCHOR_WRITER_SET: {
    code: 1053,
    zh: "锚点域可写者集合不唯一",
    en: "The set of writers of the anchor domain is not exactly the service identity",
    description: { zh: "可写身份集合不等于 {服务身份}，存在第二个可写者或服务身份本身不可写，拒绝启动", en: "The set of writable identities is not exactly {the service identity}; there is a second writer, or the service identity cannot write at all, so refuse to start" },
  },
  ERR_ANCHOR_ADAPTER_UNAVAILABLE: {
    code: 1054,
    zh: "当前平台无可用授权适配器",
    en: "No authorization adapter is available for this platform",
    description: { zh: "当前平台没有可用的授权适配器，必须 fail-closed 拒绝启动", en: "No authorization adapter is available for this platform, so the check must fail closed and refuse to start" },
  },
  ERR_ACTION_IN_FLIGHT: {
    code: 1055,
    zh: "同一动作已在执行",
    en: "The same action is already in flight",
    description: { zh: "同一桌面上的同一 operation/target/参数 已有在执行的许可，禁止重复铸造", en: "A permit for the same operation/target/parameters on the same desktop is already in flight; minting another one is refused" },
  },
  ERR_ACTION_ALREADY_DISPATCHED: {
    code: 1056,
    zh: "该动作已完成，不可重复派发",
    en: "The action has already been dispatched and must not be repeated",
    description: { zh: "同一桌面上的同一 operation/target/参数 已被派发并完成，再次派发必须被拒绝", en: "The same operation/target/parameters on the same desktop have already been dispatched and completed; dispatching them again must be refused" },
  },
  ERR_PERMIT_SIGNATURE_INVALID: {
    code: 1057,
    zh: "许可签名无效",
    en: "The permit signature is not valid",
    description: { zh: "待签名字节与签名不匹配，或签名覆盖集合与绑定集合不一致，拒绝接受该许可", en: "The signed bytes do not match the signature, or the signed field set does not cover the binding field set; the permit is refused" },
  },
  ERR_PERMIT_SEQUENCE_REPLAY: {
    code: 1058,
    zh: "许可序号未推进",
    en: "The permit sequence did not advance",
    description: { zh: "签名的 sequence 未大于本地已见序号高水位，判定为重放并拒绝", en: "The signed sequence is not greater than the local highest-seen sequence, so it is treated as a replay and refused" },
  },
  ERR_PERMIT_DEADLINE_EXPIRED: {
    code: 1059,
    zh: "许可已过期",
    en: "The permit deadline has passed",
    description: { zh: "签名中的 deadline_ms 早于当前时间，拒绝接受该许可", en: "The signed deadline_ms is earlier than the current time, so the permit is refused" },
  },
  ERR_PERMIT_BINDING_UNCOVERED: {
    code: 1060,
    zh: "签名覆盖未涵盖绑定字段",
    en: "The signature does not cover every binding field",
    description: { zh: "consume() 的绑定字段集合存在未被签名覆盖的元素，拒绝签发与验签", en: "Some element of the consume() binding field set is not covered by the signature; minting and verification are refused" },
  },
  ERR_PERMIT_PRIVATE_KEY_EXPOSED: {
    code: 1061,
    zh: "私钥出口被触达",
    en: "A private key export path was reached",
    description: { zh: "私钥对象的导出、序列化或格式化出口被触达，拒绝继续使用该批次密钥", en: "An export, serialization or formatting path of the private key object was reached; the batch key is refused" },
  },
  ERR_REVOCATION_SEQUENCE_BROKEN: {
    code: 1062,
    zh: "撤销链断裂",
    en: "The revocation chain is broken",
    description: { zh: "撤销列表的序号不等于本地已应用撤销序号高水位加一，或前驱不匹配，链断裂即拒绝该列表", en: "The revocation sequence is not the local applied high-water mark plus one, or the predecessor does not match; a broken chain means the list is refused" },
  },
  ERR_REVOCATION_SET_NOT_MONOTONIC: {
    code: 1063,
    zh: "撤销集合未单调增长",
    en: "The revoked fingerprint set is not monotonic",
    description: { zh: "撤销列表的已撤销指纹集合不是本地已应用集合的超集，拒绝该列表且不推进高水位", en: "The revoked fingerprint set of the list is not a superset of the locally applied set; the list is refused and no high-water mark advances" },
  },
  ERR_REVOCATION_SIGNER_INVALID: {
    code: 1064,
    zh: "撤销列表签发者无效",
    en: "The revocation list signer is not valid",
    description: { zh: "撤销列表的签名公钥不在 pin 中，或已在本地已撤销指纹集合内，拒绝该列表并拒绝本次验签", en: "The public key that signed the revocation list is not in the pin, or is already in the locally revoked fingerprint set; the list is refused and this verification is refused" },
  },
  ERR_PIN_NOT_EXCLUSIVE: {
    code: 1065,
    zh: "pin 登记不独占",
    en: "The pin registration is not exclusive",
    description: { zh: "独占性判定不成立（既有 pin、目标实例有进程或有旧 run），停止整条路线，不实施 authority-bind", en: "The exclusivity precondition does not hold (an existing pin, a live process on the target instance, or a prior run), so the whole route stops and authority-bind is not performed" },
  },
  ERR_PIN_ALREADY_EXISTS: {
    code: 1066,
    zh: "pin 已存在",
    en: "A pin already exists",
    description: { zh: "原子登记发现既有 pin，后到者不得覆盖先到者，拒绝登记", en: "The atomic registration found an existing pin; the later writer must not overwrite the earlier one, so the registration is refused" },
  },
  ERR_PERMIT_INPUT_INVALID: {
    code: 1067,
    zh: "许可交付输入非法",
    en: "The permit delivery input is not valid",
    description: { zh: "字段缺失、类型错误或值不可规范化（含浮点），拒绝处理该输入", en: "A field is missing, has the wrong type or carries a value that cannot be canonicalized (floating point included); the input is refused" },
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
