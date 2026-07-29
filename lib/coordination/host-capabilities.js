"use strict";

// ─── Host Capability Vocabulary & Delivery Semantics (CP-8) ────────────────
// Stable vocabulary for vendor-neutral Host Adapter Protocol v1, frozen by
// P-003 §6.1 (capability negotiation) and §6.2 (delivery result). This module
// is the single source of truth for:
//
//   • CAPABILITY_NAMES — closed set of stable capability identifiers
//   • CAPABILITY_GROUPS — capability ↔ role groupings for documentation/tests
//   • DELIVERY_RESULTS — frozen `delivered | presented | deferred | failed` enum
//   • DELIVERY_RESULT_SEMANTICS — short, non-secret meaning of each result
//   • isKnownCapability / isKnownDeliveryResult — membership predicates
//
// The module is intentionally side-effect free: no fs / network / process
// access. Downstream modules (host-adapter-protocol, consumer-registry,
// local-host-binding) import from here and never re-define the vocabulary.

const CAPABILITY_NAMES = Object.freeze([
  "notification.receive",
  "user.attention",
  "thread.resume",
  "thread.wakeup",
  "turn.start",
  "delivery.receipt",
  "event.ack",
  "interactive.input",
  "session.events",
  "tool.events",
  "permission.events",
  "process.headless",
  "structured.output",
]);

const CAPABILITY_NAME_SET = new Set(CAPABILITY_NAMES);

// Grouping is purely informational (used by tests + docs). It is NOT a type
// system: a capability still has exactly one canonical identifier from
// CAPABILITY_NAMES regardless of which group it appears in. Groups make it
// trivial to assert that "wakeup-style" capabilities stay coherent.
const CAPABILITY_GROUPS = Object.freeze({
  notification: Object.freeze(["notification.receive", "delivery.receipt", "event.ack"]),
  attention: Object.freeze(["user.attention", "interactive.input"]),
  session: Object.freeze(["thread.resume", "thread.wakeup", "turn.start", "session.events"]),
  observability: Object.freeze(["tool.events", "permission.events", "session.events"]),
  execution: Object.freeze(["process.headless", "structured.output"]),
});

// Delivery result semantics — frozen by P-003 §6.2. Each entry is a short,
// non-secret description. Never echo a rejected payload back through these.
const DELIVERY_RESULTS = Object.freeze({
  DELIVERED: "delivered",
  PRESENTED: "presented",
  DEFERRED: "deferred",
  FAILED: "failed",
});

const DELIVERY_RESULT_VALUES = Object.freeze(Object.values(DELIVERY_RESULTS));
const DELIVERY_RESULT_SET = new Set(DELIVERY_RESULT_VALUES);

const DELIVERY_RESULT_SEMANTICS = Object.freeze({
  delivered: Object.freeze({
    summary: "Target host confirmed receipt.",
    targetConversation: true,
    isTerminal: true,
  }),
  presented: Object.freeze({
    summary: "IDE / system notification shown but not in the target conversation.",
    targetConversation: false,
    isTerminal: false,
  }),
  deferred: Object.freeze({
    summary: "Capability unavailable right now; event stays pending.",
    targetConversation: false,
    isTerminal: false,
  }),
  failed: Object.freeze({
    summary: "Stable failure; bounded retry applies.",
    targetConversation: false,
    isTerminal: true,
  }),
});

function isKnownCapability(name) {
  return typeof name === "string" && CAPABILITY_NAME_SET.has(name);
}

function isKnownDeliveryResult(value) {
  return typeof value === "string" && DELIVERY_RESULT_SET.has(value);
}

module.exports = {
  CAPABILITY_GROUPS,
  CAPABILITY_NAMES,
  CAPABILITY_NAME_SET,
  DELIVERY_RESULTS,
  DELIVERY_RESULT_SEMANTICS,
  DELIVERY_RESULT_SET,
  DELIVERY_RESULT_VALUES,
  isKnownCapability,
  isKnownDeliveryResult,
};