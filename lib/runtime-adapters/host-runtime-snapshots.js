"use strict";

// ─── Host Runtime Snapshots (M-031 MS-001 / F-031-001) ────────────────────────
//
// Read-only capability snapshot rows for the seven P-007 hosts. Each row
// captures, at a given timestamp:
//   - capabilities    : what the host advertises it can do (discover envelope)
//   - limits          : what the host is known NOT to do
//   - evidence        : where the snapshot was derived (file path, revision,
//                       or external probe result)
//   - received_at     : ISO timestamp when the snapshot was captured
//
// Phase 1 (M-031 MS-001) ships static snapshots for the 3 hosts that were
// either listed-but-empty (cursor) or had incomplete metadata (codey,
// minimax). The other 4 (claude-code / codex / pi / dsh) are derived from
// their existing BaseAdapter subclasses' discover() envelopes (read-only,
// no extra probe).
//
// Why a static, read-only module:
//   - Snapshots are pure data; they never trigger probes themselves.
//   - Capability detection at runtime is per-host in MS-002 / MS-003 —
//     this module is the data store those probes eventually write to.
//   - Schema and shape stay aligned with the existing
//     `lib/runtime-adapters/capability-contract.js` vocabulary (P-001 frozen).
//
// Hard constraints (per VC-031-001-04):
//   - Zero npm deps.
//   - Read-only; no mutation of host state.
//   - No external network calls; no subprocess spawn.
//   - Capability names must already exist in capability-contract vocabulary;
//     no new enums introduced.

const { list: listAdapters, get: getAdapter } = require("../agents/adapters");

// Canonical ordering: the seven P-007 hosts in audit-table order.
const HOST_ORDER = Object.freeze([
  "claude-code",
  "pi",
  "cursor",
  "codex",
  "codey",
  "minimax",
  "dsh",
]);

// Static snapshots for the 3 hosts MS-001 explicitly enumerates. Other
// hosts are derived from their BaseAdapter discover() envelope at call time.
const STATIC_SNAPSHOTS = Object.freeze({
  cursor: Object.freeze({
    capabilities: Object.freeze([
      "editor_discovery",
      "binary_health_check",
      "capability_snapshot",
    ]),
    limits: Object.freeze([
      "no_dispatch_protocol",
      "no_invoke_support",
      "no_cancel_support",
      "no_context_or_tool_hooks",
      "no_private_ide_state_read",
    ]),
    evidence: Object.freeze([
      ".agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-007-host-adapter-completeness-proposal.md#1.2",
      "lib/agents/adapters/cursor.js",
      "lib/agents/registry-adapter-types.js#VALID_ADAPTER_TYPES_EXT",
    ]),
    observer: true,
    invoke_supported: false,
    cancel_supported: false,
  }),
  codey: Object.freeze({
    capabilities: Object.freeze([
      "text_generation",
      "code_completion",
      "chat_completion",
    ]),
    limits: Object.freeze([
      "missing_dispatch_whitelist",
      "missing_skill_discovery_path",
      "missing_shadow_adapter",
    ]),
    evidence: Object.freeze([
      ".agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-007-host-adapter-completeness-proposal.md#1.2",
    ]),
    observer: false,
    invoke_supported: true,
    cancel_supported: true,
  }),
  minimax: Object.freeze({
    capabilities: Object.freeze([
      "text_generation",
      "code_completion",
      "chat_completion",
    ]),
    limits: Object.freeze([
      "missing_dispatch_whitelist",
      "missing_skill_discovery_path",
      "missing_shadow_adapter",
    ]),
    evidence: Object.freeze([
      ".agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-007-host-adapter-completeness-proposal.md#1.2",
    ]),
    observer: false,
    invoke_supported: true,
    cancel_supported: true,
  }),
});

// Derive a runtime snapshot row from a BaseAdapter discover() envelope.
function _envelopeToRow(host, envelope, fallbackLimits) {
  return Object.freeze({
    host,
    capabilities: Object.freeze([...(envelope?.capabilities || [])]),
    evidence: Object.freeze([
      ...(envelope ? [`discover:${host}@${envelope.version || "unknown"}`] : []),
      ...(fallbackLimits ? ["limits:inferred"] : []),
    ]),
    observer: envelope?.observer === true,
    invoke_supported: envelope?.invoke_supported !== false,
    cancel_supported: envelope?.cancel_supported !== false,
    limits: Object.freeze(fallbackLimits || []),
    received_at: new Date().toISOString(),
  });
}

// Default fallback limits for hosts not explicitly enumerated in
// STATIC_SNAPSHOTS. Conservative; only flag what is KNOWN missing.
//
// M-031 MS-001 scope only: parity/diagnostic surfaces for the whitelist and
// skill-discovery gaps belong to MS-002 and are NOT built here — they live
// in their canonical sources (`lib/dispatch/execute.js#SUPPORTED_HOSTS` and
// `lib/runtime-adapters/minimax-cli-skill-discovery.js#HOSTS` +
// `HOST_PATH_BUILDER`) so this module never introduces a second truth
// source. The dsh host remains `missing_dispatch_whitelist` and
// `missing_skill_discovery_path` until MS-002 closes those two specific
// gaps in the canonical sources (see validation contract VC-031-DRIFT-002).
const FALLBACK_LIMITS = Object.freeze({
  "claude-code": Object.freeze(["missing_shadow_adapter"]),
  "codex": Object.freeze([]),
  "pi": Object.freeze([]),
  "dsh": Object.freeze([
    "missing_dispatch_whitelist",
    "missing_skill_discovery_path",
  ]),
});

// Return all host snapshots in canonical HOST_ORDER.
function snapshotAll() {
  const rows = [];
  for (const host of HOST_ORDER) {
    rows.push(snapshotFor(host));
  }
  return Object.freeze(rows);
}

// Return the snapshot for a single host. Unknown hosts return a row
// with empty capabilities + a "host not enumerated" note.
function snapshotFor(host) {
  const now = new Date().toISOString();
  if (typeof host !== "string" || !host) {
    throw new Error("snapshotFor: host (non-empty string) required");
  }
  if (STATIC_SNAPSHOTS[host]) {
    return Object.freeze({
      host,
      ...STATIC_SNAPSHOTS[host],
      received_at: now,
    });
  }
  // Derive from registered adapter if present.
  if (getAdapter(host)) {
    let envelope = null;
    try {
      envelope = getAdapter(host).discover();
    } catch (_) { /* observer base class may not implement */ }
    return _envelopeToRow(host, envelope, FALLBACK_LIMITS[host] || []);
  }
  // Unknown host — empty row.
  return Object.freeze({
    host,
    capabilities: Object.freeze([]),
    limits: Object.freeze(["host_not_enumerated"]),
    evidence: Object.freeze([]),
    observer: false,
    invoke_supported: false,
    cancel_supported: false,
    received_at: now,
  });
}

// Return only the hosts MS-001 explicitly enumerates (cursor / codey /
// minimax), as required by VC-031-001-04.
function enumeratedHosts() {
  return Object.freeze(["cursor", "codey", "minimax"]);
}

// Return canonical HOST_ORDER list (read-only).
function hostOrder() {
  return HOST_ORDER.slice();
}

// Return registered adapter list (read-only). Useful for callers that
// want to know which hosts are dispatchable today (post-_seed()).
function registeredAdapters() {
  return Object.freeze(listAdapters().slice());
}

module.exports = {
  snapshotAll,
  snapshotFor,
  enumeratedHosts,
  hostOrder,
  registeredAdapters,
};
