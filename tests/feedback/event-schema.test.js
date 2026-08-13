"use strict";

// ─── VC-001 — Event schema rejects forbidden fields and unknown keys ─────────

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  validateEvent,
  ALLOWED_KINDS,
  ALLOWED_SEVERITIES,
  ALLOWED_ADAPTERS,
  REQUIRED_TOP_LEVEL_FIELDS,
  FORBIDDEN_TOP_LEVEL_FIELDS,
  EVENT_ID_PATTERN,
} = require("../../lib/feedback/event-schema");

function baseEvent(overrides = {}) {
  return {
    schema_version: 1,
    event_id: "fev_00000000-0000-4000-8000-000000000000",
    occurred_at: "2026-08-12T09:00:00.000Z",
    kind: "blocker",
    severity: "high",
    title: "governed hook returned diagnostic",
    source: {
      adapter: "cortex-diagnostic",
      project_slug: "cortex-agent",
    },
    fingerprint: "pending",
    ...overrides,
  };
}

test("VC-001 baseline event is accepted", () => {
  const result = validateEvent(baseEvent(), { adapterEnabled: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.event.fingerprint.startsWith("sha256:"), true);
});

test("VC-001 rejects unknown top-level field", () => {
  const ev = baseEvent({ bogus: "ignored" });
  const result = validateEvent(ev, { adapterEnabled: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /unknown field "bogus"/.test(e)), result.errors.join("; "));
});

test("VC-001 rejects prompt/transcript/token/stack/abs_path fields (PII contract)", () => {
  const forbidden = ["prompt", "transcript", "stack", "abs_path", "token", "secret", "credential", "password", "api_key", "host"];
  for (const field of forbidden) {
    const ev = baseEvent({ [field]: "should never be accepted" });
    const result = validateEvent(ev, { adapterEnabled: true });
    assert.equal(result.ok, false, `field ${field} should be rejected`);
    assert.ok(result.errors.some((e) => e.includes(field)), `expected error mentioning ${field}: ${result.errors.join("; ")}`);
  }
  assert.ok(FORBIDDEN_TOP_LEVEL_FIELDS.includes("prompt"));
  assert.ok(FORBIDDEN_TOP_LEVEL_FIELDS.includes("transcript"));
  assert.ok(FORBIDDEN_TOP_LEVEL_FIELDS.includes("stack"));
});

test("VC-001 rejects absolute paths inside title/summary/diagnostic_code", () => {
  const cases = [
    { title: "/etc/passwd leaked into title" },
    { title: "ok title", summary: "/home/user/secret.txt" },
    { title: "ok title", diagnostic_code: "/var/log/x" },
  ];
  for (const overrides of cases) {
    const result = validateEvent(baseEvent(overrides), { adapterEnabled: true });
    assert.equal(result.ok, false, `should reject: ${JSON.stringify(overrides)}`);
  }
});

test("VC-001 rejects unknown kind / severity / adapter", () => {
  for (const kind of ["interrupt", "panic", ""]) {
    const r = validateEvent(baseEvent({ kind }), { adapterEnabled: true });
    assert.equal(r.ok, false);
  }
  for (const sev of ["warn", "emergency", ""]) {
    const r = validateEvent(baseEvent({ severity: sev }), { adapterEnabled: true });
    assert.equal(r.ok, false);
  }
  for (const adapter of ["openai", "anthropic-telemetry", ""]) {
    const r = validateEvent(baseEvent({ source: { adapter, project_slug: "cortex-agent" } }), { adapterEnabled: true });
    assert.equal(r.ok, false);
  }
});

test("VC-001 rejects control characters and oversize strings", () => {
  const ev = baseEvent({ title: "x".repeat(5000) });
  const r = validateEvent(ev, { adapterEnabled: true });
  assert.equal(r.ok, false, "oversize title must be rejected");
  const ev2 = baseEvent({ title: "ok\u0001title" });
  const r2 = validateEvent(ev2, { adapterEnabled: true });
  assert.equal(r2.ok, false, "control characters must be rejected");
});

test("VC-001 rejects malformed event_id", () => {
  for (const bad of ["", "not-uuid", "fev_short", "Fev_00000000-0000-4000-8000-000000000000", "../etc/passwd"]) {
    const r = validateEvent(baseEvent({ event_id: bad }), { adapterEnabled: true });
    assert.equal(r.ok, false, `event_id ${bad} should be rejected`);
  }
  // UUID-ish IDs are accepted.
  assert.match("fev_00000000-0000-4000-8000-000000000000", EVENT_ID_PATTERN);
});

test("VC-001 rejects bad project_slug shape and run_ref that looks like a path", () => {
  const badSlug = validateEvent(baseEvent({ source: { adapter: "cortex-diagnostic", project_slug: "../etc" } }), { adapterEnabled: true });
  assert.equal(badSlug.ok, false);
  const badRunRef = validateEvent(baseEvent({ source: { adapter: "cortex-diagnostic", project_slug: "cortex-agent", run_ref: "/home/user/x" } }), { adapterEnabled: true });
  assert.equal(badRunRef.ok, false);
});

test("VC-001 tag list overflow is rejected", () => {
  const tags = new Array(20).fill("a");
  const r = validateEvent(baseEvent({ tags }), { adapterEnabled: true });
  assert.equal(r.ok, false);
});

test("VC-001 schema_version mismatch is rejected", () => {
  const r = validateEvent(baseEvent({ schema_version: 2 }), { adapterEnabled: true });
  assert.equal(r.ok, false);
});

test("VC-001 missing required fields are rejected", () => {
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    const ev = baseEvent();
    delete ev[field];
    const r = validateEvent(ev, { adapterEnabled: true });
    assert.equal(r.ok, false, `missing ${field} should be rejected`);
  }
});

test("VC-001 lists the registered enums (defensive)", () => {
  assert.deepEqual(ALLOWED_KINDS, ["blocker", "observation", "question", "feature-request"]);
  assert.deepEqual(ALLOWED_SEVERITIES, ["low", "medium", "high", "critical"]);
  assert.ok(ALLOWED_ADAPTERS.includes("manual"));
  assert.ok(ALLOWED_ADAPTERS.includes("cortex-diagnostic"));
});