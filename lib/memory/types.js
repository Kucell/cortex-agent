"use strict";

// ─── Memory Type Registry (M-002 MS-002) ─────────────────────────────────────
//
// Three memory types per D-002-2 (Eric 拍板 2026-08-01):
//   - episodic:   短时,事件流("2026-07-31 用户切换 Cortex → Codex 完成 FAE-001 审批")
//   - semantic:   长时,概念图("Eric 决策风格:具体推荐+备选+风险")
//   - procedural: 操作流程,触发器驱动(MS-002 落 schema,MS-002 阶段**不** 实现写操作,推到 v1.12)
//
// Why a single types.js (not lib/memory/{episodic,semantic,procedural}.js as
// originally drafted in M-002 mission-plan §Scope):
//   1. The three types share the same JSON schema (`memory.schema.json`); only
//      the `type` enum field distinguishes them. A 3-file split would create
//      three near-identical modules.
//   2. The `procedural` type is a v1.12 deferred implementation — no point
//      pre-creating an empty module.
//   3. `lib/coordination/` has flat single-file modules (cli.js, contract.js,
//      schemas.js). Keep that flat convention.

const TYPES = Object.freeze({
  EPISODIC: "episodic",
  SEMANTIC: "semantic",
  PROCEDURAL: "procedural",
});

const ALL_TYPES = Object.freeze([TYPES.EPISODIC, TYPES.SEMANTIC, TYPES.PROCEDURAL]);

// Types that MS-002 actually supports for write operations (distill).
// `procedural` is reserved per D-002-2 / RFC §12 #6 — interface reserved,
// no implementation until v1.12.
const WRITABLE_TYPES = Object.freeze([TYPES.EPISODIC, TYPES.SEMANTIC]);

// Default expiry horizon (days) per type, for episodic memories that don't
// pin themselves. Semantic memories are stable and shouldn't auto-expire by
// default. Procedural is unimplemented.
const DEFAULT_EXPIRY_DAYS = Object.freeze({
  [TYPES.EPISODIC]: 90,
  [TYPES.SEMANTIC]: null,    // null = never expires
  [TYPES.PROCEDURAL]: null,
});

function isValidType(t) {
  return ALL_TYPES.includes(t);
}

function isWritableType(t) {
  return WRITABLE_TYPES.includes(t);
}

// Parse a comma-separated `--type` flag value into a deduplicated list,
// validated against ALL_TYPES. Throws on unknown type.
function parseTypeList(raw) {
  if (raw == null || raw === "") return [...ALL_TYPES];
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (!isValidType(p)) {
      const err = new Error(
        `Unknown memory type: "${p}". Valid types: ${ALL_TYPES.join(", ")}.`
      );
      err.code = "ERR_INVALID_MEMORY_TYPE";
      throw err;
    }
    if (!out.includes(p)) out.push(p);
  }
  return out.length > 0 ? out : [...ALL_TYPES];
}

module.exports = {
  TYPES,
  ALL_TYPES,
  WRITABLE_TYPES,
  DEFAULT_EXPIRY_DAYS,
  isValidType,
  isWritableType,
  parseTypeList,
};
