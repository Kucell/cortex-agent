"use strict";

// ─── Host Adapter Protocol v1 — capability vocabulary + delivery semantics ─
//
// CP-8 / P-003 §6.1 + §6.2 / VC-002-02. Covers:
//   • The frozen, closed-vocabulary CAPABILITY_NAMES exported by
//     host-adapter-protocol.
//   • The four-way DELIVERY_RESULTS enum (delivered / presented / deferred /
//     failed) and its semantics helpers.
//   • isKnownCapability / isKnownDeliveryResult membership predicates.
//   • Routing decisions must NOT infer capabilities from a product name.
//   • Legacy protocol exports (MESSAGE_KINDS, PHASES, REGISTERED_ADAPTER_IDS,
//     createAdapter, handshake, etc.) still surface identically — these
//     tests guard the backward-compatibility promise of CP-8.
//   • Schemas added in CP-8 (capabilityDescriptorV1Schema,
//     deliveryReceiptSchema) accept the canonical shapes and reject extras.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");
const capabilities = require(path.join(root, "lib/coordination/host-capabilities"));
const protocol = require(path.join(root, "lib/coordination/host-adapter-protocol"));
const schemas = require(path.join(root, "lib/coordination/schemas"));
const core = require(path.join(root, "lib/coordination/adapter-core"));

// ─── 1. Frozen capability vocabulary ────────────────────────────────────────

test("CP-8: CAPABILITY_NAMES exposes the 13 frozen capability identifiers", () => {
  const expected = [
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
  ];
  assert.equal(protocol.CAPABILITY_NAMES.length, expected.length);
  for (const name of expected) {
    assert.ok(protocol.CAPABILITY_NAMES.includes(name), `missing capability: ${name}`);
  }
});

test("CP-8: CAPABILITY_NAMES is closed (no ad-hoc names allowed)", () => {
  // Membership is decided by the frozen set; strings that look like
  // capabilities but are not on the list are rejected by isKnownCapability.
  assert.equal(protocol.isKnownCapability("notification.receive"), true);
  assert.equal(protocol.isKnownCapability("thread.wakeup"), true);
  assert.equal(protocol.isKnownCapability("turn.start"), true);
  assert.equal(protocol.isKnownCapability("session.events"), true);

  assert.equal(protocol.isKnownCapability(""), false);
  assert.equal(protocol.isKnownCapability("wakeup"), false);            // product-style shortcut
  assert.equal(protocol.isKnownCapability("notification"), false);      // missing module
  assert.equal(protocol.isKnownCapability("codex.wakeup"), false);      // product-prefixed
  assert.equal(protocol.isKnownCapability("Thread.wakeup"), false);     // case sensitive
  assert.equal(protocol.isKnownCapability(null), false);
  assert.equal(protocol.isKnownCapability(undefined), false);
  assert.equal(protocol.isKnownCapability(42), false);
});

test("CP-8: CAPABILITY_NAMES and CAPABILITY_NAME_SET stay in sync", () => {
  assert.equal(protocol.CAPABILITY_NAMES.length, protocol.CAPABILITY_NAME_SET.size);
  for (const name of protocol.CAPABILITY_NAMES) {
    assert.equal(protocol.CAPABILITY_NAME_SET.has(name), true);
  }
});

test("CP-8: CAPABILITY_GROUPS only references known capability identifiers", () => {
  for (const group of Object.values(protocol.CAPABILITY_GROUPS)) {
    for (const name of group) {
      assert.equal(protocol.isKnownCapability(name), true, `group leaked an unknown capability: ${name}`);
    }
  }
});

// ─── 2. Four-way delivery result semantics ──────────────────────────────────

test("CP-8: DELIVERY_RESULTS exposes delivered/presented/deferred/failed only", () => {
  assert.deepEqual(protocol.DELIVERY_RESULTS, {
    DELIVERED: "delivered",
    PRESENTED: "presented",
    DEFERRED: "deferred",
    FAILED: "failed",
  });
  assert.deepEqual(protocol.DELIVERY_RESULT_VALUES, [
    "delivered",
    "presented",
    "deferred",
    "failed",
  ]);
});

test("CP-8: DELIVERY_RESULT_SET mirrors DELIVERY_RESULT_VALUES", () => {
  assert.equal(protocol.DELIVERY_RESULT_SET.size, protocol.DELIVERY_RESULT_VALUES.length);
  for (const value of protocol.DELIVERY_RESULT_VALUES) {
    assert.equal(protocol.DELIVERY_RESULT_SET.has(value), true);
  }
});

test("CP-8: isKnownDeliveryResult accepts the four values and rejects everything else", () => {
  assert.equal(protocol.isKnownDeliveryResult("delivered"), true);
  assert.equal(protocol.isKnownDeliveryResult("presented"), true);
  assert.equal(protocol.isKnownDeliveryResult("deferred"), true);
  assert.equal(protocol.isKnownDeliveryResult("failed"), true);

  assert.equal(protocol.isKnownDeliveryResult("journaled"), false); // intentionally not a delivery result (P-003 §6.2)
  assert.equal(protocol.isKnownDeliveryResult("skipped"), false);   // legacy compat value, no longer in CP-8
  assert.equal(protocol.isKnownDeliveryResult("ok"), false);
  assert.equal(protocol.isKnownDeliveryResult(""), false);
  assert.equal(protocol.isKnownDeliveryResult(null), false);
  assert.equal(protocol.isKnownDeliveryResult(42), false);
});

test("CP-8: DELIVERY_RESULT_SEMANTICS classifies delivered as terminal target-conversation", () => {
  const s = protocol.DELIVERY_RESULT_SEMANTICS.delivered;
  assert.equal(s.targetConversation, true);
  assert.equal(s.isTerminal, true);
  assert.ok(typeof s.summary === "string" && s.summary.length > 0);
});

test("CP-8: DELIVERY_RESULT_SEMANTICS classifies presented as non-terminal", () => {
  const s = protocol.DELIVERY_RESULT_SEMANTICS.presented;
  assert.equal(s.targetConversation, false);
  assert.equal(s.isTerminal, false);
});

test("CP-8: DELIVERY_RESULT_SEMANTICS classifies deferred as pending, retriable", () => {
  const s = protocol.DELIVERY_RESULT_SEMANTICS.deferred;
  assert.equal(s.targetConversation, false);
  assert.equal(s.isTerminal, false);
});

test("CP-8: DELIVERY_RESULT_SEMANTICS classifies failed as terminal retriable failure", () => {
  const s = protocol.DELIVERY_RESULT_SEMANTICS.failed;
  assert.equal(s.targetConversation, false);
  assert.equal(s.isTerminal, true);
});

test("CP-8: DELIVERY_RESULT_SEMANTICS has exactly the four canonical entries", () => {
  assert.deepEqual(
    Object.keys(protocol.DELIVERY_RESULT_SEMANTICS).sort(),
    ["deferred", "delivered", "failed", "presented"],
  );
});

// ─── 3. Routing decisions must NOT use product names ──────────────────────

test("CP-8 / VC-002-02: routing never infers wakeup support from a product name", () => {
  // A bare Codex product name (with no capability handshake) cannot be used
  // to claim `thread.wakeup` support — only the descriptor / handshake does.
  const desc = protocol.createAdapter({
    adapterId: "codex.local",
    capabilities: [], // intentionally empty: no capability handshake
  });
  // The product id alone never grants wakeup; routing must look at the
  // declared capability array, not the adapterId string.
  assert.equal(desc.capabilities.includes("thread.wakeup"), false);

  // With wakeup declared, routing can rely on the descriptor.
  const wakeupDesc = protocol.createAdapter({
    adapterId: "codex.local",
    capabilities: ["thread.wakeup"],
  });
  assert.equal(wakeupDesc.capabilities.includes("thread.wakeup"), true);

  // Generic adapter ids (product-style, e.g. "codex" without namespace)
  // are rejected by the registered-whitelist check, so routing cannot
  // accidentally route through a product name.
  assert.throws(
    () => protocol.createAdapter({ adapterId: "codex", capabilities: ["thread.wakeup"] }),
    /adapter id not registered/i,
  );
});

test("CP-8: legacy MESSAGE_KINDS, PHASES, REGISTERED_ADAPTER_IDS still match M-001", () => {
  // Backward-compatibility guard. Existing adapters and coordination-host-
  // adapter.test.js depend on these exact values; do not let CP-8 changes
  // mutate them.
  assert.deepEqual(protocol.MESSAGE_KINDS, [
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
  assert.deepEqual(protocol.PHASES, [
    "pending",
    "deferred",
    "running",
    "ack_pending",
    "completed",
    "failed",
  ]);
  for (const id of ["codex.local", "claude-code.local", "cursor.local", "windsurf.local"]) {
    assert.ok(protocol.REGISTERED_ADAPTER_IDS.includes(id));
  }
});

test("CP-8: legacy exports stay unchanged (regression guard)", () => {
  assert.equal(typeof protocol.createAdapter, "function");
  assert.equal(typeof protocol.handshake, "function");
  assert.equal(typeof protocol.threadWakeup, "function");
  assert.equal(typeof protocol.buildStructuredContext, "function");
  assert.equal(typeof protocol.registerRecoveryConsumer, "function");
  assert.equal(typeof protocol.healthSnapshot, "function");
  assert.equal(typeof protocol.ackResult, "function");
  assert.equal(typeof protocol.deferredNoHost, "function");
  assert.equal(typeof protocol.checkDenyRules, "function");
  assert.deepEqual(protocol.RESULT_STATUSES, ["completed", "failed"]);
});

// ─── 4. Capability descriptor v1 schema ─────────────────────────────────────

test("CP-8: capabilityDescriptorV1Schema accepts canonical shape", () => {
  const verdict = schemas.validateCapabilityDescriptorV1({
    schemaVersion: "1.0",
    adapterId: "codex.local",
    capabilities: ["notification.receive", "thread.wakeup"],
    detectedAt: "2026-07-29T00:00:00.000Z",
  });
  assert.equal(verdict.ok, true);
});

test("CP-8: capabilityDescriptorV1Schema rejects unknown capability names", () => {
  const verdict = schemas.validateCapabilityDescriptorV1({
    schemaVersion: "1.0",
    adapterId: "codex.local",
    capabilities: ["notification.receive", "made.up.capability"],
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => /made\.up\.capability/.test(e)));
});

test("CP-8: capabilityDescriptorV1Schema rejects duplicate capabilities", () => {
  const verdict = schemas.validateCapabilityDescriptorV1({
    schemaVersion: "1.0",
    adapterId: "codex.local",
    capabilities: ["thread.wakeup", "thread.wakeup"],
  });
  assert.equal(verdict.ok, false);
});

test("CP-8: capabilityDescriptorV1Schema rejects unknown top-level keys", () => {
  const verdict = schemas.validateCapabilityDescriptorV1({
    schemaVersion: "1.0",
    adapterId: "codex.local",
    capabilities: ["thread.wakeup"],
    rogueField: true,
  });
  assert.equal(verdict.ok, false);
});

test("CP-8: capabilityDescriptorV1Schema rejects missing required keys", () => {
  for (const missing of ["adapterId", "capabilities"]) {
    const input = { schemaVersion: "1.0", capabilities: ["thread.wakeup"] };
    if (missing === "capabilities") delete input.capabilities;
    if (missing === "adapterId") delete input.adapterId;
    const verdict = schemas.validateCapabilityDescriptorV1(input);
    assert.equal(verdict.ok, false, `expected missing=${missing} to fail`);
  }
});

// ─── 5. Delivery receipt schema ────────────────────────────────────────────

test("CP-8: deliveryReceiptSchema accepts a canonical four-way receipt", () => {
  for (const status of ["delivered", "presented", "deferred", "failed"]) {
    const verdict = schemas.validateDeliveryReceipt({
      deliveryKey: "abc123",
      consumerId: "consumer-a",
      eventId: "evt-1",
      target: "coordinator:project-owner",
      status,
      adapterId: "codex.local",
      attempts: 1,
      nextAttemptAt: null,
      acked: false,
      reason: null,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    assert.equal(verdict.ok, true, `status=${status} should validate`);
  }
});

test("CP-8: deliveryReceiptSchema rejects status outside the four-way enum", () => {
  const verdict = schemas.validateDeliveryReceipt({
    deliveryKey: "abc",
    consumerId: "consumer-a",
    eventId: "evt-1",
    target: "coordinator:project-owner",
    status: "skipped", // legacy value, NOT a CP-8 delivery result
  });
  assert.equal(verdict.ok, false);
});

test("CP-8: deliveryReceiptSchema is closed — no rogue fields allowed", () => {
  const verdict = schemas.validateDeliveryReceipt({
    deliveryKey: "abc",
    consumerId: "consumer-a",
    eventId: "evt-1",
    target: "coordinator:project-owner",
    status: "delivered",
    secretToken: "ghp_AAAA", // must never reach a receipt
  });
  assert.equal(verdict.ok, false);
});

// ─── 6. Integration: capability handshake + delivery semantic ──────────────

test("CP-8: handshake enumerates missing CP-8 capabilities verbatim", () => {
  const adapter = protocol.createAdapter({
    adapterId: "codex.local",
    capabilities: ["notification.receive"], // only one of the required set
  });
  const result = protocol.handshake(adapter, {
    required: ["notification.receive", "thread.wakeup", "delivery.receipt"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingCapabilities, ["thread.wakeup", "delivery.receipt"]);
});

test("CP-8: full CP-8 handshake round-trip", () => {
  const adapter = protocol.createAdapter({
    adapterId: "codex.local",
    capabilities: [
      "notification.receive",
      "thread.wakeup",
      "delivery.receipt",
      "event.ack",
    ],
  });
  const result = protocol.handshake(adapter, {
    required: ["notification.receive", "thread.wakeup", "delivery.receipt", "event.ack"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingCapabilities, []);
});

test("CP-8: legacy createV1CapabilityDescriptor still works alongside CP-8 surface", () => {
  // The two surfaces must not collide: the M-001 descriptor uses the
  // session.boundary / message.boundary / turn.boundary vocabulary, while
  // CP-8 uses notification.receive / thread.wakeup / etc. Both are
  // available simultaneously so adapters can be probed against either
  // vocabulary without conflict.
  assert.notEqual(core.CAPABILITY_NAMES, capabilities.CAPABILITY_NAMES);
  assert.ok(core.CAPABILITY_NAMES.includes("session.boundary"));
  assert.ok(capabilities.CAPABILITY_NAMES.includes("thread.wakeup"));
});