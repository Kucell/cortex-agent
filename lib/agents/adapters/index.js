"use strict";

// ─── Adapter Registry (M-003 MS-001 / F-001 + F-002) ───────────────────────────
//
// In-process registry of adapter classes, keyed by `adapter_type` string
// (claude-code, codex, codey, pi, minimax). Powers:
//   - `cortex-agent agent adapter list`     (F-001, D-003-4)
//   - `cortex-agent agent adapter health <id>` (F-001, D-003-4)
//   - `cortex-agent agent dispatch-execute` (F-009, D-003-3) — resolves the
//     adapter by entry.external.adapter_type, then calls invoke().
//
// Why a Map + cached instances:
//   - lookup is O(1) by adapter_type
//   - instances are reused (most adapters are stateless; claude-code holds a
//     single subprocess tracking Map keyed by runId)
//   - register() is the extension point for MS-002 / MS-003 adapters — they
//     can add themselves via this same registry without touching this file
//     (call register() from a side-effect import or from the new adapter
//     module's index.js).
//
// MS-001 ships with one adapter: claude-code. MS-002 adds codex / codey / pi,
// MS-003 adds minimax. The framework doesn't import them eagerly — they're
// added to the registry by their own index.js (see adapters/claude-code.js
// for the pattern).

const { ClaudeCodeAdapter } = require("./claude-code");

// Module-level registry. Tests can call reset() to wipe + re-init; the
// public API (register / get / list / has) is what production code uses.
const _REGISTRY = new Map(); // adapterType -> AdapterClass
const _INSTANCES = new Map(); // adapterType -> Adapter instance (lazy)

function _seed() {
  _REGISTRY.clear();
  _INSTANCES.clear();
  // MS-001 ships claude-code only; MS-002 / MS-003 adapters self-register.
  _REGISTRY.set("claude-code", ClaudeCodeAdapter);
}

function register(adapterType, AdapterClass) {
  if (typeof adapterType !== "string" || !adapterType) {
    throw new Error("register: adapterType (non-empty string) required");
  }
  if (typeof AdapterClass !== "function") {
    throw new Error("register: AdapterClass (constructor) required");
  }
  _REGISTRY.set(adapterType, AdapterClass);
  // New registration invalidates any cached instance for that type.
  _INSTANCES.delete(adapterType);
}

function unregister(adapterType) {
  const had = _REGISTRY.delete(adapterType);
  _INSTANCES.delete(adapterType);
  return had;
}

function has(adapterType) {
  return _REGISTRY.has(adapterType);
}

function get(adapterType) {
  if (!_REGISTRY.has(adapterType)) return null;
  if (!_INSTANCES.has(adapterType)) {
    const Cls = _REGISTRY.get(adapterType);
    _INSTANCES.set(adapterType, new Cls());
  }
  return _INSTANCES.get(adapterType);
}

function getClass(adapterType) {
  return _REGISTRY.get(adapterType) || null;
}

function list() {
  return Array.from(_REGISTRY.keys()).sort();
}

function instances() {
  // Materialize one instance per registered type (for health checks across
  // all adapters — `cortex-agent agent adapter list` does this).
  return list().map((type) => ({ type, instance: get(type) }));
}

function reset() {
  // Public: useful for tests and for a future "reload adapter registry"
  // CLI subcommand. Resets to the MS-001 seed set.
  _seed();
}

// Initialize the MS-001 seed set on first load. Subsequent register() calls
// augment; reset() reverts to this seed.
_seed();

module.exports = {
  register,
  unregister,
  has,
  get,
  getClass,
  list,
  instances,
  reset,
  // re-exported for tests / external adapter authors
  ClaudeCodeAdapter,
};
