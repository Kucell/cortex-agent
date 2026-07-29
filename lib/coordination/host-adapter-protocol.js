"use strict";

// ─── Host Adapter Protocol (vendor-neutral surface) ──────────────────────────
// Re-exports the protocol surface from adapter-core under a stable name. This
// module is the single import point for downstream code; the implementation
// lives in adapter-core so legacy imports keep working.
//
// CP-8 (P-003 §6) extends this module with the stable capability vocabulary
// and the four-way `delivered | presented | deferred | failed` delivery
// semantics. All new exports are additive — every legacy re-export below is
// unchanged so existing Codex / Claude / noop / webhook adapters and the
// coordination-host-adapter test suite continue to pass unmodified.
//
// Strictly: no fs / child_process / network. All host-bound payloads flow
// through checkDenyRules and respect autoApprove=false, sideEffects=false.

const core = require("./adapter-core");
const capabilities = require("./host-capabilities");

const MESSAGE_KINDS = Object.freeze([
  "capability.handshake",
  "capability.handshake.ack",
  "thread.wakeup",
  "thread.wakeup.ack",
  "context.structured",
  "consumer.recovery",
  "health.snapshot",
  "result.delivery",
  "result.ack",
]);

// Re-export every adapter-core surface that downstream code consumes.
const {
  REGISTERED_ADAPTER_IDS,
  STRUCTURED_CONTEXT_FIELDS,
  PHASES,
  RESULT_STATUSES,
  ALLOWED_TRANSITIONS,
  DENY_RULES,
  createAdapter: _legacyCreate, // not re-exported; use createAdapter below
} = core;

// Adapter factory exposed under protocol namespace.
function createAdapter(input) {
  return core.createHostAdapter(input);
}

// CP-8: stable capability vocabulary (P-003 §6.1) and four-way delivery
// semantics (P-003 §6.2). Re-exported through the protocol namespace so
// adapters only need to import this module to participate in CP-8.
// `journaled` is intentionally NOT a delivery result — it describes durable
// persistence, not whether a host confirmed receipt (P-003 §6.2 final line).

// Adapter factory exposed under protocol namespace.
module.exports = {
  MESSAGE_KINDS,
  REGISTERED_ADAPTER_IDS,
  STRUCTURED_CONTEXT_FIELDS,
  PHASES,
  RESULT_STATUSES,
  ALLOWED_TRANSITIONS,
  DENY_RULES,
  // CP-8 additions — additive, never replace legacy exports above.
  CAPABILITY_GROUPS: capabilities.CAPABILITY_GROUPS,
  CAPABILITY_NAMES: capabilities.CAPABILITY_NAMES,
  CAPABILITY_NAME_SET: capabilities.CAPABILITY_NAME_SET,
  DELIVERY_RESULTS: capabilities.DELIVERY_RESULTS,
  DELIVERY_RESULT_SEMANTICS: capabilities.DELIVERY_RESULT_SEMANTICS,
  DELIVERY_RESULT_SET: capabilities.DELIVERY_RESULT_SET,
  DELIVERY_RESULT_VALUES: capabilities.DELIVERY_RESULT_VALUES,
  isKnownCapability: capabilities.isKnownCapability,
  isKnownDeliveryResult: capabilities.isKnownDeliveryResult,
  createAdapter,
  handshake: core.handshake,
  buildStructuredContext: core.buildStructuredContext,
  threadWakeup: core.threadWakeup,
  registerRecoveryConsumer: core.registerRecoveryConsumer,
  healthSnapshot: core.healthSnapshot,
  ackResult: core.ackResult,
  deferredNoHost: core.deferredNoHost,
  checkDenyRules: core.checkDenyRules,
};