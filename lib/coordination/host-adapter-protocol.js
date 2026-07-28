"use strict";

// ─── Host Adapter Protocol (vendor-neutral surface) ──────────────────────────
// Re-exports the protocol surface from adapter-core under a stable name. This
// module is the single import point for downstream code; the implementation
// lives in adapter-core so legacy imports keep working.
//
// Strictly: no fs / child_process / network. All host-bound payloads flow
// through checkDenyRules and respect autoApprove=false, sideEffects=false.

const core = require("./adapter-core");

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

module.exports = {
  MESSAGE_KINDS,
  REGISTERED_ADAPTER_IDS,
  STRUCTURED_CONTEXT_FIELDS,
  PHASES,
  RESULT_STATUSES,
  ALLOWED_TRANSITIONS,
  DENY_RULES,
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
