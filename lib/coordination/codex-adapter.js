"use strict";

const {
  DELIVERY_RESULTS,
  assertSafeId,
  assertSafeText,
  createAdapterDescriptor,
  hasCapability,
  sanitizeEvidenceRefs,
} = require("./adapter-core");
const { assertEventSafe } = require("./contract");

const WAKE_EVENT_TYPES = new Set([
  "task.ready_for_review",
  "task.input_required",
  "task.blocked",
  "task.failed",
  "ownership.conflict",
]);

const WAKE_POLICIES = new Set([
  "coordinator_notify",
  "user_attention",
  "urgent",
]);

function detectCodexCapabilities(host = {}) {
  return createAdapterDescriptor({
    adapterId: host.adapterId || "codex",
    vendor: host.vendor || "openai",
    capabilities: {
      threadWakeup: host.threadWakeup === true,
      structuredContext: host.structuredContext === true,
      recoveryConsumer: host.recoveryConsumer !== false,
    },
  });
}

function shouldWake(event) {
  if (!event || typeof event !== "object") return false;
  if (event.eventType === "task.heartbeat"
      || event.eventType === "task.progress") return false;
  const policy = event.notification && event.notification.policy;
  return WAKE_EVENT_TYPES.has(event.eventType) || WAKE_POLICIES.has(policy);
}

function buildWakeupRequest(descriptor, event) {
  if (!shouldWake(event)) return null;
  if (!hasCapability(descriptor, "threadWakeup")
      || !hasCapability(descriptor, "structuredContext")) return null;
  assertEventSafe(event);
  return Object.freeze({
    adapterId: descriptor.adapterId,
    eventId: assertSafeId(event.eventId, "eventId"),
    taskId: assertSafeId(event.taskId, "taskId"),
    eventType: assertSafeId(event.eventType, "eventType"),
    state: assertSafeId(event.currentState, "currentState"),
    message: event.message ? assertSafeText(event.message, "message") : null,
    evidenceRefs: sanitizeEvidenceRefs(event.evidence || []),
    requestedAction: sanitizeRequestedAction(event.requestedAction),
    autoApprove: false,
    executeSideEffects: false,
  });
}

function sanitizeRequestedAction(action) {
  if (!action) return null;
  if (typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("requestedAction must be an object");
  }
  return Object.freeze({
    kind: assertSafeId(action.kind, "requestedAction.kind"),
    decisionRef: action.decisionRef
      ? assertSafeId(action.decisionRef, "requestedAction.decisionRef")
      : null,
    waitpointRef: action.waitpointRef
      ? assertSafeId(action.waitpointRef, "requestedAction.waitpointRef")
      : null,
  });
}

function createCodexAdapter(host = {}) {
  const descriptor = detectCodexCapabilities(host);
  const deliver = typeof host.deliver === "function" ? host.deliver : null;
  return Object.freeze({
    descriptor,
    async wake(event) {
      const request = buildWakeupRequest(descriptor, event);
      if (!request) {
        return Object.freeze({
          status: shouldWake(event)
            ? DELIVERY_RESULTS.DEFERRED
            : DELIVERY_RESULTS.SKIPPED,
          eventId: event && event.eventId ? event.eventId : null,
        });
      }
      if (!deliver) {
        return Object.freeze({
          status: DELIVERY_RESULTS.DEFERRED,
          eventId: request.eventId,
        });
      }
      await deliver(request);
      return Object.freeze({
        status: DELIVERY_RESULTS.DELIVERED,
        eventId: request.eventId,
      });
    },
    async deliver({ event }) {
      const delivery = await this.wake(event);
      return {
        status: delivery.status,
        acknowledged: false,
      };
    },
  });
}

async function recoverCoordinator(adapter, input) {
  if (!hasCapability(adapter.descriptor, "recoveryConsumer")) {
    return Object.freeze({ delivered: [], deferred: [], skipped: [] });
  }
  const acked = new Set(input.ackedEventIds || []);
  const ordered = dedupePendingFirst(
    input.pendingCriticalEvents || [],
    input.newEvents || [],
  );
  const result = { delivered: [], deferred: [], skipped: [] };
  for (const event of ordered) {
    if (acked.has(event.eventId)) continue;
    const delivery = await adapter.wake(event);
    result[delivery.status].push(delivery.eventId);
  }
  return Object.freeze({
    delivered: Object.freeze(result.delivered),
    deferred: Object.freeze(result.deferred),
    skipped: Object.freeze(result.skipped),
  });
}

function dedupePendingFirst(pending, fresh) {
  const seen = new Set();
  const result = [];
  for (const event of [...pending, ...fresh]) {
    if (!event || typeof event !== "object") {
      throw new TypeError("recovery events must be objects");
    }
    assertSafeId(event.eventId, "eventId");
    if (!seen.has(event.eventId)) {
      seen.add(event.eventId);
      result.push(event);
    }
  }
  return result;
}

// ─── Host Wakeup Adapter — Codex adapter stub ────────────────────────────────
// Vendor-specific handle to the vendor-neutral contract. This module does NOT
// call any Codex API (no public Codex API is reachable from this codebase),
// and does NOT pretend to. It only describes the JSON envelope a host would
// produce / consume, and wires it through the stdio / JSONL transport.

const CODEX_HOST_CAPABILITIES = Object.freeze([
  "capability.handshake",
  "capability.handshake.ack",
  "thread.wakeup",
  "context.structured",
  "consumer.recovery",
  "health.snapshot",
  "result.delivery",
  "result.ack",
]);

const CODEX_REQUIRED_FIELDS = Object.freeze([
  "kind",
  "schemaVersion",
  "adapterId",
  "capabilities",
]);

function createHostCodexAdapter() {
  return Object.assign(
    {},
    {
      adapterId: "codex.local",
      schemaVersion: "1.0",
      capabilities: CODEX_HOST_CAPABILITIES,
    },
  );
}

function describeEnvelope(adapter) {
  if (!adapter || adapter.adapterId !== "codex.local") {
    throw new Error("describeEnvelope expects a Codex host adapter (adapterId=codex.local)");
  }
  return Object.freeze({
    adapterId: adapter.adapterId,
    schemaVersion: adapter.schemaVersion,
    transport: "stdio/JSONL (one frame per line)",
    requiredFields: CODEX_REQUIRED_FIELDS,
    optionalFields: Object.freeze(["threadId", "context", "taskId", "status", "payload", "state", "note"]),
    autoApprove: false,
    sideEffects: false,
    notes: Object.freeze([
      "Codex adapter does not invoke any Codex API; no public Codex API is exposed to this codebase.",
      "Wired exclusively through the local stdio / JSONL transport owned by the host.",
      "All payloads are filtered by the vendor-neutral deny-rule set before crossing the boundary.",
      "host integration is expected to surface Codex UI events as thread.wakeup messages.",
    ]),
  });
}

// Alias used by the host-wakeup test suite (matches the protocol-style naming).
// Returns a full Host Wakeup adapter (with tasks Map + capabilities) so the
// downstream protocol layer can immediately drive handshake / wakeup flows.
function createAdapter() {
  const protocol = require("./host-adapter-protocol");
  return protocol.createAdapter({
    adapterId: "codex.local",
    capabilities: CODEX_HOST_CAPABILITIES,
  });
}

module.exports = {
  WAKE_EVENT_TYPES,
  WAKE_POLICIES,
  buildWakeupRequest,
  createCodexAdapter,
  dedupePendingFirst,
  detectCodexCapabilities,
  recoverCoordinator,
  shouldWake,
  // ─── Host Wakeup Adapter (vendor-neutral) additions ────────────────────────
  createHostCodexAdapter,
  createAdapter,
  describeEnvelope,
};
