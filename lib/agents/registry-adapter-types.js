"use strict";

// ─── Additive Adapter Types Registry (M-003 MS-004 / §6.2 fix) ───────────────────
//
// Background (per `.agent/missions/M-003/handoffs/20260804-183000-deviations-decided.md`
// §2 + Eric 拍板 2026-08-04 18:20):
//
//   M-002's `lib/agents/registry.js` ships with
//   `VALID_ADAPTER_TYPES = ["claude-code", "cortex", "codex", "codey", "pi", "custom"]`
//   and **MUST stay zero-modified** (硬约束 — M-002 5/5 ship 完整保留).
//   When MS-003 shipped the `minimax` adapter, agent entries with
//   `external.adapter_type = "minimax"` failed at `validateAdapterType()` with
//   `ERR_INVALID_ADAPTER_TYPE`, blocking minimax agent writes.
//
//   Eric 拍板 (8-04 18:20): MS-004 cleanup 加 "minimax" to M-002 VALID_ADAPTER_TYPES,
//   走 **additive 模式** — 不改 `registry.js` 主体, 在新 file 里
//   扩展 list, dispatch-execute.js / m003-cli.js 走新 import.
//
// This module is the additive extension point. It re-exports M-002's frozen
// list, defines the MS-004 add list (`['minimax']`), exposes a combined
// "all-known adapter types" list, and provides a tolerant validator that
// accepts any union of (M-002 strict) ∪ (M-003 ext).
//
//   - `VALID_ADAPTER_TYPES`     — re-exported from M-002 (unchanged, frozen).
//   - `VALID_ADAPTER_TYPES_EXT` — MS-003+ add list (M-003 minimax; future M-004
//                                  MCP bridge may add more).
//   - `VALID_ADAPTER_TYPES_ALL` — frozen union of both.
//   - `isKnownAdapterType(t)`   — true iff t ∈ ALL.
//   - `validateAdapterTypeExt(t)` — throws `ERR_INVALID_ADAPTER_TYPE` (same code
//                                    as M-002) if t ∉ ALL. Use this anywhere
//                                    we need to accept minimax + future
//                                    M-003+ adapters without depending on
//                                    M-002's strict list.
//
// Hard constraints (per validation contract `VC-M-003-MS-004-dispatch`):
//   - registry.js zero-modify (re-export only, not a rewrite).
//   - Zero npm deps (node:assert / object spread only).
//   - Pure addition. No file in lib/agents/ (M-002 5/5) is modified.
//
// Migration path (when M-002 itself accepts minimax natively — future v1.13+):
//   1. Add "minimax" to `lib/agents/registry.js#VALID_ADAPTER_TYPES`.
//   2. Keep this file as a back-compat shim OR remove it (callers switch to
//      `require("./registry").VALID_ADAPTER_TYPES` directly).
//   Either way, callers using `validateAdapterTypeExt` keep working.

const { VALID_ADAPTER_TYPES } = require("./registry");

// MS-003 minimax adapter_type. Add more here as M-003+ adapters ship.
// M-029 / P-006: DSH (DeepSeek Harness) promoted from TCP shadow host
// (D-TCP-004) to a first-class dispatch adapter by user approval on
// 2026-08-19 (D-ARI-P006-promote-dsh-firstclass). Registered here as
// `dsh`; the dispatch adapter file lives at `lib/agents/adapters/dsh.js`
// (M-029 MS-001, commit `7d877a8`) and is wired through _seed() /
// bootstrap / adapter-core.js by MS-002.
const VALID_ADAPTER_TYPES_EXT = Object.freeze(["minimax", "dsh"]);

// Frozen union — both M-002 strict + MS-003+ extensions.
const VALID_ADAPTER_TYPES_ALL = Object.freeze([
  ...VALID_ADAPTER_TYPES,
  ...VALID_ADAPTER_TYPES_EXT,
]);

function isKnownAdapterType(t) {
  return typeof t === "string" && VALID_ADAPTER_TYPES_ALL.includes(t);
}

// Throws ERR_INVALID_ADAPTER_TYPE if `t` is not in the union. Re-uses M-002's
// canonical error code so callers can handle one error code across M-002 /
// M-003 code paths.
function validateAdapterTypeExt(t) {
  if (!isKnownAdapterType(t)) {
    const err = new Error(
      `validateAdapterTypeExt: invalid adapter_type "${t}". ` +
      `Valid: ${VALID_ADAPTER_TYPES_ALL.join(", ")}.`,
    );
    err.code = "ERR_INVALID_ADAPTER_TYPE";
    throw err;
  }
}

module.exports = {
  VALID_ADAPTER_TYPES,
  VALID_ADAPTER_TYPES_EXT,
  VALID_ADAPTER_TYPES_ALL,
  isKnownAdapterType,
  validateAdapterTypeExt,
};
