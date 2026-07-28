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

module.exports = {
  WAKE_EVENT_TYPES,
  WAKE_POLICIES,
  buildWakeupRequest,
  createCodexAdapter,
  dedupePendingFirst,
  detectCodexCapabilities,
  recoverCoordinator,
  shouldWake,
};
