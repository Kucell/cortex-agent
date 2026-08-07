"use strict";

// ─── Runtime Adapter Contract tests (T-ARI-001 / P-001 / M-001) ─────────────
// Pure node:test, no external deps. Covers capability vocabulary +
// descriptor validation + runtime boundary event validation + bounded safe
// fields + redaction rejection + closed-schema rejection + immutability.

const test = require("node:test");
const assert = require("node:assert/strict");

const cap = require("../../lib/runtime-adapters/capability-contract");
const evt = require("../../lib/runtime-adapters/boundary-event");

// ─── Capability vocabulary ──────────────────────────────────────────────────

test("capability vocabulary is frozen and contains M-001 entries", () => {
  assert.ok(Array.isArray(cap.CAPABILITY_NAMES));
  assert.ok(Array.isArray(cap.CAPABILITY_LEVELS));
  assert.ok(Array.isArray(cap.CAPABILITY_SOURCES));
  for (const name of [
    "session.boundary",
    "turn.boundary",
    "message.boundary",
    "tool.before.observe",
    "tool.before.block",
    "tool.update",
    "context.render.observe",
  ]) {
    assert.ok(cap.isKnownCapability(name), `expected ${name} to be a known capability`);
  }
  for (const level of ["native", "adapter", "explicit", "unobservable", "unsupported"]) {
    assert.ok(cap.CAPABILITY_LEVELS.includes(level));
  }
  assert.equal(cap.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION, "1.0");
  assert.ok(Object.isFrozen(cap.CAPABILITY_NAMES));
  assert.ok(Object.isFrozen(cap.CAPABILITY_LEVELS));
  assert.ok(Object.isFrozen(cap.CAPABILITY_SOURCES));
});

test("isKnownCapability rejects unknown names without throwing", () => {
  assert.equal(cap.isKnownCapability("nope"), false);
  assert.equal(cap.isKnownCapability(""), false);
  assert.equal(cap.isKnownCapability(null), false);
  assert.equal(cap.isKnownCapability(undefined), false);
  assert.equal(cap.isKnownCapability(42), false);
});

// ─── Capability descriptor validation ───────────────────────────────────────

function baseDescriptor(overrides) {
  return Object.assign(
    {
      schema_version: "1.0",
      host: { adapter_id: "acme", vendor: "acme-ai", version: "0.1.0" },
      detected_at: "2026-07-28T00:00:00.000Z",
      capabilities: {
        "session.boundary": { level: "native", source: "extension-api" },
        "tool.before.block": { level: "native", source: "extension-api" },
        "context.render.observe": { level: "unsupported", source: "not-exposed" },
      },
    },
    overrides || {}
  );
}

test("validateCapabilityDescriptor accepts a complete descriptor", () => {
  const out = cap.validateCapabilityDescriptor(baseDescriptor());
  assert.equal(out.schema_version, "1.0");
  assert.equal(out.host.adapter_id, "acme");
  assert.equal(Object.keys(out.capabilities).length, 3);
  assert.deepEqual(out.capabilities["session.boundary"], {
    level: "native",
    source: "extension-api",
    reason: null,
  });
});

test("validateCapabilityDescriptor accepts numeric epoch as detected_at", () => {
  const desc = baseDescriptor({ detected_at: Date.UTC(2026, 6, 28) });
  const out = cap.validateCapabilityDescriptor(desc);
  assert.equal(out.detected_at, "2026-07-28T00:00:00.000Z");
});

test("validateCapabilityDescriptor rejects unknown schema_version", () => {
  assert.throws(
    () => cap.validateCapabilityDescriptor(baseDescriptor({ schema_version: "2.0" })),
    (err) => err.code === "ERR_SCHEMA_VERSION_UNKNOWN"
  );
});

test("validateCapabilityDescriptor rejects non-ISO detected_at string", () => {
  for (const bad of [
    "2026-07-28",
    "2026/07/28T00:00:00Z",
    "2026-07-28T00:00:00",
    "2026-07-28 00:00:00Z",
    "2026-07-28T00:00:00Z UTC",
    "not-a-date",
  ]) {
    assert.throws(
      () => cap.validateCapabilityDescriptor(baseDescriptor({ detected_at: bad })),
      (err) => err.code === "ERR_TIMESTAMP_INVALID",
      `expected ${bad} to be rejected`
    );
  }
});

test("validateCapabilityDescriptor rejects NaN/Infinity epoch", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => cap.validateCapabilityDescriptor(baseDescriptor({ detected_at: bad })),
      (err) => err.code === "ERR_TIMESTAMP_INVALID"
    );
  }
});

test("validateCapabilityDescriptor normalises ISO with offset to canonical Z form", () => {
  const desc = baseDescriptor({ detected_at: "2026-07-28T08:00:00.000+08:00" });
  const out = cap.validateCapabilityDescriptor(desc);
  assert.equal(out.detected_at, "2026-07-28T00:00:00.000Z");
});

test("validateCapabilityDescriptor rejects unknown capability level", () => {
  const desc = baseDescriptor({
    capabilities: {
      "session.boundary": { level: "approximate", source: "extension-api" },
    },
  });
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_CAPABILITY_LEVEL_UNKNOWN"
  );
});

test("validateCapabilityDescriptor rejects unknown source", () => {
  const desc = baseDescriptor({
    capabilities: {
      "session.boundary": { level: "native", source: "vibes" },
    },
  });
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_CAPABILITY_SOURCE_UNKNOWN"
  );
});

test("validateCapabilityDescriptor rejects unknown capability name", () => {
  const desc = baseDescriptor({
    capabilities: {
      "made.up.capability": { level: "native", source: "extension-api" },
    },
  });
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_CAPABILITY_NAME_UNKNOWN"
  );
});

test("validateCapabilityDescriptor rejects missing host", () => {
  const desc = baseDescriptor();
  delete desc.host;
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_HOST_MISSING"
  );
});

test("validateCapabilityDescriptor rejects missing capabilities map", () => {
  const desc = baseDescriptor();
  delete desc.capabilities;
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_CAPABILITIES_MISSING"
  );
});

test("validateCapabilityDescriptor rejects empty entry", () => {
  const desc = baseDescriptor();
  desc.capabilities["session.boundary"] = { level: "native" };
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_FIELD_NOT_STRING"
  );
});

// ─── Closed-schema rejection (host / entry / descriptor top) ───────────────

test("validateCapabilityDescriptor rejects unknown host field", () => {
  const desc = baseDescriptor();
  desc.host.adapter_url = "https://example.com";
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "adapter_url"
  );
});

test("validateCapabilityDescriptor rejects unknown capability entry field", () => {
  const desc = baseDescriptor();
  desc.capabilities["session.boundary"].hint = "maybe";
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "hint"
  );
});

test("validateCapabilityDescriptor rejects unknown descriptor top-level field", () => {
  const desc = baseDescriptor();
  desc.profile = "experimental";
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "profile"
  );
});

test("validateCapabilityDescriptor rejects array host", () => {
  const desc = baseDescriptor();
  desc.host = [];
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_HOST_MISSING"
  );
});

test("validateCapabilityDescriptor rejects array capabilities", () => {
  const desc = baseDescriptor();
  desc.capabilities = [];
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) => err.code === "ERR_CAPABILITIES_MISSING"
  );
});

// ─── Practical bounds (host + reason) ──────────────────────────────────────

test("validateCapabilityDescriptor enforces host adapter_id length bound", () => {
  const desc = baseDescriptor();
  desc.host.adapter_id = "a".repeat(cap.MAX_HOST_ADAPTER_ID_LENGTH + 1);
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) =>
      err.code === "ERR_FIELD_TOO_LONG" &&
      err.details.maxLength === cap.MAX_HOST_ADAPTER_ID_LENGTH
  );
});

test("validateCapabilityDescriptor enforces host vendor/version length bound", () => {
  const desc = baseDescriptor();
  desc.host.vendor = "v".repeat(cap.MAX_HOST_VENDOR_LENGTH + 1);
  assert.throws(() => cap.validateCapabilityDescriptor(desc), (err) => err.code === "ERR_FIELD_TOO_LONG");
  const desc2 = baseDescriptor();
  desc2.host.version = "v".repeat(cap.MAX_HOST_VERSION_LENGTH + 1);
  assert.throws(() => cap.validateCapabilityDescriptor(desc2), (err) => err.code === "ERR_FIELD_TOO_LONG");
});

test("validateCapabilityDescriptor enforces capability reason length bound", () => {
  const desc = baseDescriptor();
  desc.capabilities["session.boundary"].reason = "r".repeat(cap.MAX_CAPABILITY_REASON_LENGTH + 1);
  assert.throws(
    () => cap.validateCapabilityDescriptor(desc),
    (err) =>
      err.code === "ERR_FIELD_TOO_LONG" &&
      err.details.maxLength === cap.MAX_CAPABILITY_REASON_LENGTH
  );
});

test("validateCapabilityDescriptor accepts capability reason at bound", () => {
  const desc = baseDescriptor();
  desc.capabilities["session.boundary"].reason = "r".repeat(cap.MAX_CAPABILITY_REASON_LENGTH);
  const out = cap.validateCapabilityDescriptor(desc);
  assert.equal(out.capabilities["session.boundary"].reason.length, cap.MAX_CAPABILITY_REASON_LENGTH);
});

// ─── Runtime boundary event vocabulary ──────────────────────────────────────

test("boundary event types cover P-001 M-001 catalogue", () => {
  for (const t of [
    "session.start",
    "session.end",
    "turn.start",
    "turn.end",
    "message.start",
    "message.update",
    "message.end",
    "tool.before",
    "tool.update",
    "tool.after",
    "context.discovered",
    "context.selected",
    "context.rendered",
    "context.measured",
  ]) {
    assert.ok(evt.RUNTIME_BOUNDARY_EVENT_TYPES.includes(t), `missing ${t}`);
  }
  assert.equal(evt.RUNTIME_BOUNDARY_EVENT_SCHEMA_VERSION, "1.0");
  assert.equal(evt.RUNTIME_BOUNDARY_EVENT_ID_PREFIX, "RBE-");
  assert.ok(Object.isFrozen(evt.RUNTIME_BOUNDARY_EVENT_TYPES));
  assert.ok(Object.isFrozen(evt.RUNTIME_BOUNDARY_EVENT_DECISIONS));
});

test("boundary event decisions are a closed enum", () => {
  for (const d of ["allowed", "denied", "blocked", "unavailable"]) {
    assert.ok(evt.RUNTIME_BOUNDARY_EVENT_DECISIONS.includes(d));
  }
});

// ─── Boundary event validation ──────────────────────────────────────────────

function baseEvent(overrides) {
  return Object.assign(
    {
      schema_version: "1.0",
      event_id: "RBE-2026-07-28-0001",
      type: "tool.before",
      at: "2026-07-28T00:00:00.000Z",
      host: { adapter_id: "acme", session_ref: "opaque-ref" },
      correlation: { task_id: "T-1", run_id: "R-1", session_id: "S-1", operation_id: "OP-1" },
      resource: { kind: "tool", name: "bash", target_digest: "sha256:abc" },
      capability: "tool.before.block",
      decision: { result: "allowed", authorization_ref: "D-1" },
      evidence_refs: ["E-1", "E-2"],
    },
    overrides || {}
  );
}

test("validateBoundaryEvent accepts a complete tool.before envelope", () => {
  const out = evt.validateBoundaryEvent(baseEvent());
  assert.equal(out.type, "tool.before");
  assert.equal(out.capability, "tool.before.block");
  assert.equal(out.decision.result, "allowed");
  assert.equal(out.resource.kind, "tool");
  assert.deepEqual(out.evidence_refs, ["E-1", "E-2"]);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.host), true);
  assert.equal(Object.isFrozen(out.evidence_refs), true);
});

test("validateBoundaryEvent accepts a session.start without resource", () => {
  const ev = baseEvent({ type: "session.start" });
  delete ev.resource;
  delete ev.capability;
  delete ev.decision;
  const out = evt.validateBoundaryEvent(ev);
  assert.equal(out.type, "session.start");
  assert.equal(out.resource, null);
  assert.equal(out.decision, null);
});

// ─── Strict ISO timestamp + event_id format ────────────────────────────────

test("validateBoundaryEvent rejects non-ISO at string", () => {
  for (const bad of [
    "2026-07-28",
    "2026/07/28T00:00:00Z",
    "2026-07-28 00:00:00Z",
    "2026-07-28T00:00:00Z UTC",
    "not-a-date",
  ]) {
    assert.throws(
      () => evt.validateBoundaryEvent(baseEvent({ at: bad })),
      (err) => err.code === "ERR_TIMESTAMP_INVALID",
      `expected at=${bad} to be rejected`
    );
  }
});

test("validateBoundaryEvent accepts numeric epoch at and normalises to ISO", () => {
  const out = evt.validateBoundaryEvent(baseEvent({ at: Date.UTC(2026, 6, 28) }));
  assert.equal(out.at, "2026-07-28T00:00:00.000Z");
});

test("validateBoundaryEvent normalises ISO with offset to canonical Z form", () => {
  const out = evt.validateBoundaryEvent(
    baseEvent({ at: "2026-07-28T08:00:00.000+08:00" })
  );
  assert.equal(out.at, "2026-07-28T00:00:00.000Z");
});

test("validateBoundaryEvent rejects event_id without RBE- prefix", () => {
  for (const bad of ["2026-07-28-0001", "rbe-2026-07-28-0001", "XBE-001"]) {
    assert.throws(
      () => evt.validateBoundaryEvent(baseEvent({ event_id: bad })),
      (err) => err.code === "ERR_EVENT_ID_PREFIX_MISSING",
      `expected ${bad} to fail prefix check`
    );
  }
});

test("validateBoundaryEvent rejects event_id with unsafe body chars", () => {
  for (const bad of [
    "RBE-/etc/passwd",
    "RBE-has space",
    "RBE-bang!",
    "RBE-;rm-rf",
  ]) {
    assert.throws(
      () => evt.validateBoundaryEvent(baseEvent({ event_id: bad })),
      (err) => err.code === "ERR_EVENT_ID_BODY_INVALID",
      `expected ${bad} to fail body check`
    );
  }
});

test("validateBoundaryEvent rejects empty event_id body", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ event_id: "RBE-" })),
    (err) => err.code === "ERR_EVENT_ID_BODY_EMPTY"
  );
});

test("validateBoundaryEvent rejects event_id over MAX_EVENT_ID_LENGTH", () => {
  const long = "RBE-" + "a".repeat(evt.MAX_EVENT_ID_LENGTH);
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ event_id: long })),
    (err) => err.code === "ERR_FIELD_TOO_LONG"
  );
});

test("validateBoundaryEvent accepts event_id with . _ - body separators", () => {
  const ev = baseEvent({ event_id: "RBE-2026.07.28-host_42-final" });
  const out = evt.validateBoundaryEvent(ev);
  assert.equal(out.event_id, "RBE-2026.07.28-host_42-final");
});

// ─── event.capability cross-validation ──────────────────────────────────────

test("validateBoundaryEvent rejects event.capability not in CAPABILITY_NAMES", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ capability: "made.up.capability" })),
    (err) => err.code === "ERR_CAPABILITY_NAME_UNKNOWN"
  );
});

test("validateBoundaryEvent rejects empty event.capability", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ capability: "" })),
    (err) => err.code === "ERR_FIELD_NOT_STRING"
  );
});

// ─── Event envelope unknown field rejection ────────────────────────────────

test("validateBoundaryEvent rejects unknown event type", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ type: "tool.weird" })),
    (err) => err.code === "ERR_EVENT_TYPE_UNKNOWN"
  );
});

test("validateBoundaryEvent rejects unknown decision.result", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ decision: { result: "maybe" } })),
    (err) => err.code === "ERR_DECISION_RESULT_UNKNOWN"
  );
});

test("validateBoundaryEvent rejects extra top-level fields", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ freeform: "nope" })),
    (err) => err.code === "ERR_FIELD_UNKNOWN"
  );
});

test("validateBoundaryEvent rejects unknown host fields", () => {
  assert.throws(
    () => evt.validateBoundaryEvent(baseEvent({ host: { adapter_id: "acme", hostname: "x" } })),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "hostname"
  );
});

test("validateBoundaryEvent rejects unknown decision fields", () => {
  assert.throws(
    () =>
      evt.validateBoundaryEvent(
        baseEvent({ decision: { result: "allowed", secret_ref: "x" } })
      ),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "secret_ref"
  );
});

test("validateBoundaryEvent rejects unknown correlation fields", () => {
  assert.throws(
    () =>
      evt.validateBoundaryEvent(
        baseEvent({ correlation: { task_id: "T-1", whatever: "x" } })
      ),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "whatever"
  );
});

test("tool.before must carry resource+capability+decision", () => {
  const ev = baseEvent({ type: "tool.before" });
  delete ev.decision;
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_TOOL_EVENT_INCOMPLETE"
  );
});

// ─── Bounded safe fields ───────────────────────────────────────────────────

test("validateBoundaryEvent rejects resource.arguments full payload", () => {
  const ev = baseEvent({
    resource: {
      kind: "tool",
      name: "bash",
      target_digest: "sha256:abc",
      arguments: "rm -rf /",
    },
  });
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_FIELD_UNKNOWN" && err.details.key === "arguments"
  );
});

test("validateBoundaryEvent rejects resource.input/output/content/payload", () => {
  for (const forbidden of ["input", "output", "content", "payload"]) {
    const ev = baseEvent({
      resource: { kind: "tool", name: "bash", target_digest: "sha256:abc", [forbidden]: "x" },
    });
    assert.throws(
      () => evt.validateBoundaryEvent(ev),
      (err) => err.code === "ERR_FIELD_UNKNOWN",
      `should reject resource.${forbidden}`
    );
  }
});

test("validateBoundaryEvent rejects unknown resource fields", () => {
  const ev = baseEvent({
    resource: { kind: "tool", name: "bash", target_digest: "sha256:abc", mystery: true },
  });
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_FIELD_UNKNOWN"
  );
});

test("validateBoundaryEvent enforces bounded evidence_refs length", () => {
  const ev = baseEvent();
  ev.evidence_refs = new Array(evt.MAX_EVIDENCE_REFS + 1).fill("E");
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) =>
      (err.code === "ERR_FIELD_TOO_LONG" || err.code === "ERR_EVIDENCE_REFS_TOO_MANY") &&
      err.details.maxLength === evt.MAX_EVIDENCE_REFS
  );
});

test("validateBoundaryEvent enforces host adapter_id length bound", () => {
  const ev = baseEvent();
  ev.host.adapter_id = "a".repeat(evt.MAX_HOST_ADAPTER_ID_LENGTH + 1);
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) =>
      err.code === "ERR_FIELD_TOO_LONG" &&
      err.details.maxLength === evt.MAX_HOST_ADAPTER_ID_LENGTH
  );
});

test("validateBoundaryEvent enforces host session_ref length bound", () => {
  const ev = baseEvent();
  ev.host.session_ref = "s".repeat(evt.MAX_HOST_SESSION_REF_LENGTH + 1);
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) =>
      err.code === "ERR_FIELD_TOO_LONG" &&
      err.details.maxLength === evt.MAX_HOST_SESSION_REF_LENGTH
  );
});

// ─── Redaction-oriented rejection (fail-closed) ────────────────────────────

test("validateBoundaryEvent rejects evidence_ref carrying AWS access key", () => {
  const ev = baseEvent({ evidence_refs: ["AKIAIOSFODNN7EXAMPLE"] });
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_EVENT_TAINTED" && err.details.rule === "aws_access_key"
  );
});

test("validateBoundaryEvent rejects correlation field carrying GitHub PAT", () => {
  const ev = baseEvent({
    correlation: { task_id: "ghp_abcdefghijklmnopqrstuvwxyz1234" },
  });
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_EVENT_TAINTED" && err.details.rule === "github_pat"
  );
});

test("validateBoundaryEvent rejects decision.reason carrying PEM key", () => {
  const ev = baseEvent({
    decision: { result: "denied", reason: "saw -----BEGIN RSA PRIVATE KEY-----" },
  });
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_EVENT_TAINTED" && err.details.rule === "pem_private_key"
  );
});

test("validateBoundaryEvent rejects secret field names inside allowed container", () => {
  // correlation rejects unknown keys first; assert fail-closed via the
  // closed-schema pathway. (Secret-named keys can never reach deeper layers.)
  const ev = baseEvent();
  ev.correlation.notes = { password: "hunter2" };
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) =>
      err.code === "ERR_FIELD_UNKNOWN" ||
      err.code === "ERR_EVENT_TAINTED"
  );
});

test("validateBoundaryEvent rejects url_userinfo in nested array", () => {
  const ev = baseEvent();
  ev.evidence_refs = ["safe", "https://user:hunter2@example.com"];
  assert.throws(
    () => evt.validateBoundaryEvent(ev),
    (err) => err.code === "ERR_EVENT_TAINTED" && err.details.rule === "url_userinfo"
  );
});

// ─── Idempotency / ordering keys ───────────────────────────────────────────

test("validateBoundaryEvent accepts same shape twice (idempotency key is event_id)", () => {
  const a = evt.validateBoundaryEvent(baseEvent());
  const b = evt.validateBoundaryEvent(baseEvent());
  assert.equal(a.event_id, b.event_id);
  assert.deepEqual(a, b);
});

test("validateCapabilityDescriptor preserves capability key sort order", () => {
  const desc = baseDescriptor({
    capabilities: {
      "context.render.observe": { level: "unsupported", source: "not-exposed" },
      "session.boundary": { level: "native", source: "extension-api" },
      "tool.before.block": { level: "native", source: "extension-api" },
    },
  });
  const out = cap.validateCapabilityDescriptor(desc);
  const keys = Object.keys(out.capabilities);
  assert.deepEqual(keys, [
    "context.render.observe",
    "session.boundary",
    "tool.before.block",
  ]);
});

// ─── Immutability ──────────────────────────────────────────────────────────

test("validateCapabilityDescriptor returns a deep-frozen object", () => {
  const out = cap.validateCapabilityDescriptor(baseDescriptor());
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.host), true);
  for (const k of Object.keys(out.capabilities)) {
    assert.equal(Object.isFrozen(out.capabilities[k]), true, `capability entry ${k} not frozen`);
  }
  // Mutation must throw in strict mode (the file is "use strict").
  assert.throws(() => {
    out.capabilities["session.boundary"].level = "mutated";
  });
  assert.throws(() => {
    out.host.adapter_id = "evil";
  });
});

test("validateBoundaryEvent returns a deep-frozen envelope", () => {
  const ev = baseEvent();
  const out = evt.validateBoundaryEvent(ev);
  assert.equal(Object.isFrozen(out), true);
  assert.equal(Object.isFrozen(out.host), true);
  assert.equal(Object.isFrozen(out.evidence_refs), true);
  assert.equal(Object.isFrozen(out.correlation), true);
  if (out.resource) assert.equal(Object.isFrozen(out.resource), true);
  if (out.decision) assert.equal(Object.isFrozen(out.decision), true);
  // Try mutating frozen values — must throw under "use strict".
  assert.throws(() => {
    out.host.adapter_id = "evil";
  });
  assert.throws(() => {
    out.event_id = "RBE-other";
  });
  assert.throws(() => {
    out.evidence_refs.push("E-new");
  });
});

test("frozen validator does not share mutable references between calls", () => {
  const out1 = cap.validateCapabilityDescriptor(baseDescriptor());
  const out2 = cap.validateCapabilityDescriptor(baseDescriptor());
  assert.notEqual(out1.capabilities, out2.capabilities);
  // mutate output 1 (would throw, but ensure deep copy semantics if call
  // path were weakened). Test by reading only.
  assert.notStrictEqual(out1.host, out2.host);
});