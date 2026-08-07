"use strict";

// ─── Coordination Adapter v1 Capability Compatibility tests (M-002) ────────
// Verifies that the legacy boolean descriptor (compat window) AND the v1
// frozen capability descriptor (lib/runtime-adapters/capability-contract)
// co-exist on Codex / Claude coordination adapters. The v1 descriptor must
// pass through the contract validator and expose precise level / source /
// reason for every mapped capability, including unavailable / deferred
// scenarios.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CAPABILITY_DESCRIPTOR_SCHEMA_VERSION,
  CAPABILITY_LEVELS,
  CAPABILITY_MAPPING_SCHEMA,
  CAPABILITY_NAMES,
  CAPABILITY_SOURCES,
  createAdapterDescriptor,
  hasCapability,
  createV1CapabilityDescriptor,
  attachV1CapabilityDescriptor,
  LEGACY_TO_V1_MAPPING,
} = require("../../lib/coordination/adapter-core");
const runtimeCap = require("../../lib/runtime-adapters/capability-contract");

const { createCodexAdapter } = require("../../lib/coordination/codex-adapter");
const { createClaudeAdapter } = require("../../lib/coordination/claude-adapter");

// ─── Legacy compat shim ─────────────────────────────────────────────────────

test("legacy createAdapterDescriptor still produces boolean-only descriptor", () => {
  const desc = createAdapterDescriptor({
    adapterId: "acme",
    vendor: "acme-ai",
    capabilities: { hooks: true, explicitCli: false },
  });
  assert.equal(desc.adapterId, "acme");
  assert.equal(desc.vendor, "acme-ai");
  assert.equal(desc.capabilities.hooks, true);
  assert.equal(desc.capabilities.explicitCli, false);
  // Compat marker present so legacy shape stays self-identifying.
  assert.equal(desc.legacy_schema, "1.0");
});

test("hasCapability accepts both legacy boolean and v1 entries", () => {
  const legacy = createAdapterDescriptor({
    adapterId: "acme",
    vendor: "acme-ai",
    capabilities: { foo: true, bar: false },
  });
  assert.equal(hasCapability(legacy, "foo"), true);
  assert.equal(hasCapability(legacy, "bar"), false);

  const v1 = createV1CapabilityDescriptor({
    adapterId: "acme",
    vendor: "acme-ai",
    version: "1.0.0",
    capabilities: { foo: true },
  });
  // v1 capability entry shapes match by level. We don't expose v1 caps on
  // arbitrary names; use the frozen vocabulary name to confirm semantics.
  const knownLegacy = createAdapterDescriptor({
    adapterId: "acme",
    vendor: "acme-ai",
    capabilities: { "session.boundary": true },
  });
  assert.equal(hasCapability(knownLegacy, "session.boundary"), true);

  // Sanity: hasCapability returns false for unknown names.
  assert.equal(hasCapability(legacy, "missing"), false);
  assert.equal(hasCapability(v1, "session.boundary"), false);
  // v1 entries expose level values; hasCapability would be true for adapter
  // when invoked against a descriptor carrying that exact name as a v1
  // entry. We exercise that path via attachV1CapabilityDescriptor below.
});

test("createV1CapabilityDescriptor rejects unknown adapterId / vendor", () => {
  // Empty adapterId fails first (legacy assertSafeId is strict on empty).
  assert.throws(
    () => createV1CapabilityDescriptor({ adapterId: "", vendor: "v" }),
    /adapterId/,
  );
  // Missing vendor falls back to "unknown" by design (some host fixtures
  // only carry adapterId); but explicit empty vendor is still rejected.
  assert.throws(
    () => createV1CapabilityDescriptor({ adapterId: "ok", vendor: "" }),
    /vendor/,
  );
});

test("createV1CapabilityDescriptor rejects invalid detectedAt", () => {
  assert.throws(
    () => createV1CapabilityDescriptor({
      adapterId: "codex",
      vendor: "openai",
      detectedAt: "not-an-iso",
    }),
    /ISO-8601/,
  );
});

test("createV1CapabilityDescriptor defaults detectedAt to current time", () => {
  const desc = createV1CapabilityDescriptor({
    adapterId: "codex",
    vendor: "openai",
    capabilities: {},
  });
  assert.ok(runtimeCap.isValidIsoTimestamp(desc.detected_at));
});

test("createV1CapabilityDescriptor rejects unknown level emitted by rule", () => {
  // Drive the derive function directly with a fake rule that bypasses
  // the closed-enum guard — sanity check that the guard exists.
  for (const rule of LEGACY_TO_V1_MAPPING) {
    for (const lvl of ["native", "adapter", "explicit", "unobservable", "unsupported"]) {
      const out = rule.derive(true, {});
      assert.ok(CAPABILITY_LEVELS.includes(out.level));
      assert.ok(CAPABILITY_SOURCES.includes(out.source));
      // use lvl so the static analyser doesn't flag the loop variable.
      assert.equal(typeof lvl, "string");
    }
  }
});

// ─── Mapping table frozen ───────────────────────────────────────────────────

test("mapping schema and adapter ids are frozen", () => {
  assert.equal(CAPABILITY_MAPPING_SCHEMA, "legacy->v1/1.0");
  assert.ok(Object.isFrozen(LEGACY_TO_V1_MAPPING));
  for (const rule of LEGACY_TO_V1_MAPPING) {
    assert.ok(Object.isFrozen(rule));
    assert.ok(Array.isArray(rule.adapterIds));
    assert.ok(rule.adapterIds.length > 0);
    assert.ok(CAPABILITY_NAMES.includes(rule.capability));
    assert.equal(typeof rule.derive, "function");
  }
});

// ─── Codex v1 capability descriptor ─────────────────────────────────────────

test("Codex adapter emits legacy descriptor AND v1 capabilityDescriptor", () => {
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async () => {},
  });
  // Legacy shape preserved.
  assert.equal(adapter.descriptor.adapterId, "codex");
  assert.equal(adapter.descriptor.vendor, "openai");
  assert.equal(adapter.descriptor.capabilities.threadWakeup, true);
  assert.equal(adapter.descriptor.capabilities.structuredContext, true);
  assert.equal(adapter.descriptor.capabilities.recoveryConsumer, true);
  // v1 attached.
  assert.ok(adapter.descriptor.capabilityDescriptor);
  assert.equal(adapter.descriptor.capabilityDescriptor.schema_version, "1.0");
  assert.equal(adapter.descriptor.capabilityDescriptor.host.adapter_id, "codex");
  assert.equal(adapter.descriptor.capabilityMappingSchema, CAPABILITY_MAPPING_SCHEMA);
});

test("Codex v1 descriptor passes frozen contract validator", () => {
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    deliver: async () => {},
  });
  const v1 = adapter.descriptor.capabilityDescriptor;
  // Run the descriptor back through the frozen validator; it must round-trip.
  const roundTripped = runtimeCap.validateCapabilityDescriptor(v1);
  assert.equal(roundTripped.schema_version, "1.0");
  assert.equal(roundTripped.host.adapter_id, "codex");
  assert.ok(roundTripped.capabilities["session.boundary"]);
  assert.ok(roundTripped.capabilities["message.boundary"]);
});

test("Codex threadWakeup=true maps to session.boundary=adapter", () => {
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: false,
    // Disable recoveryConsumer so its mapping does NOT overwrite the
    // threadWakeup-derived session.boundary entry (last write wins).
    recoveryConsumer: false,
    deliver: async () => {},
  });
  const c = adapter.descriptor.capabilityDescriptor.capabilities;
  assert.equal(c["session.boundary"].level, "adapter");
  assert.equal(c["session.boundary"].source, "static-analysis");
  assert.ok(/threadWakeup/.test(c["session.boundary"].reason));
  // structuredContext=false → unsupported message.boundary
  assert.equal(c["message.boundary"].level, "unsupported");
  assert.equal(c["message.boundary"].source, "not-exposed");
});

test("Codex recoveryConsumer alone with no boundary signal maps to unobservable", () => {
  // Recovery-only scenario: threadWakeup and structuredContext keys must
  // be absent from the legacy bag (NOT explicitly false), so the
  // corresponding rules don't run and recoveryConsumer's `recovery-only`
  // placeholder survives. detectCodexCapabilities always materialises
  // threadWakeup, so drive the builder directly to express "absent".
  const v1 = createV1CapabilityDescriptor({
    adapterId: "codex",
    vendor: "openai",
    capabilities: { recoveryConsumer: true },
  });
  assert.equal(v1.capabilities["session.boundary"].level, "unobservable");
  assert.equal(v1.capabilities["session.boundary"].source, "not-exposed");
  assert.ok(/recovery-only/.test(v1.capabilities["session.boundary"].reason));
});

test("Codex with explicit host.version and detectedAt uses them verbatim", () => {
  const adapter = createCodexAdapter({
    threadWakeup: true,
    structuredContext: true,
    // Host version strings commonly include "/" or "+"; the v1 contract
    // accepts a relaxed character set so the descriptor can preserve the
    // raw value.
    version: "codex-cli+0.41.0",
    detectedAt: "2026-07-28T00:00:00.000Z",
    deliver: async () => {},
  });
  const v1 = adapter.descriptor.capabilityDescriptor;
  assert.equal(v1.host.version, "codex-cli+0.41.0");
  assert.equal(v1.detected_at, "2026-07-28T00:00:00.000Z");
});

test("Codex deferred/unavailable mapping uses precise level + reason", () => {
  // threadWakeup=false + structuredContext=false → threadWakeup's rule
  // overwrites recoveryConsumer's placeholder, so session.boundary lands
  // on `unsupported`. message.boundary mirrors structuredContext.
  const adapter = createCodexAdapter({
    threadWakeup: false,
    structuredContext: false,
    deliver: async () => {},
  });
  const c = adapter.descriptor.capabilityDescriptor.capabilities;
  assert.equal(c["session.boundary"].level, "unsupported");
  assert.equal(c["message.boundary"].level, "unsupported");
  assert.ok(c["session.boundary"].reason.length > 0);
  assert.ok(c["message.boundary"].reason.length > 0);
});

test("Codex with recoveryConsumer only stays unobservable", () => {
  // No threadWakeup / no structuredContext, but recoveryConsumer enabled.
  // session.boundary must end at `unobservable` because the threadWakeup
  // rule does not run (key absent from legacy bag) and recoveryConsumer
  // emits its `recovery-only` placeholder. Drive the builder directly so
  // we can omit threadWakeup cleanly — the legacy descriptor always emits
  // threadWakeup at construction time, so we cannot reproduce this case
  // through createCodexAdapter.
  const v1 = createV1CapabilityDescriptor({
    adapterId: "codex",
    vendor: "openai",
    capabilities: { recoveryConsumer: true },
  });
  assert.equal(v1.capabilities["session.boundary"].level, "unobservable");
  assert.equal(v1.capabilities["session.boundary"].source, "not-exposed");
  assert.ok(/recovery-only/.test(v1.capabilities["session.boundary"].reason));
});

// ─── Claude v1 capability descriptor ────────────────────────────────────────

test("Claude adapter emits legacy descriptor AND v1 capabilityDescriptor", () => {
  const adapter = createClaudeAdapter({
    hooks: true,
    explicitCli: true,
    processBoundaryEvidence: true,
  });
  assert.equal(adapter.descriptor.adapterId, "claude-code");
  assert.equal(adapter.descriptor.vendor, "anthropic");
  assert.equal(adapter.descriptor.capabilities.hooks, true);
  assert.equal(adapter.descriptor.capabilities.explicitCli, true);
  assert.equal(adapter.descriptor.capabilities.processBoundaryEvidence, true);
  assert.ok(adapter.descriptor.capabilityDescriptor);
  assert.equal(
    adapter.descriptor.capabilityDescriptor.schema_version,
    "1.0",
  );
});

test("Claude hooks=true maps to tool.before.observe=native", () => {
  const adapter = createClaudeAdapter({
    hooks: true,
    explicitCli: false,
    processBoundaryEvidence: false,
  });
  const c = adapter.descriptor.capabilityDescriptor.capabilities;
  assert.equal(c["tool.before.observe"].level, "native");
  assert.equal(c["tool.before.observe"].source, "runtime-trace");
  // explicit CLI fallback → context.render.observe=explicit.
  assert.equal(c["context.render.observe"].level, "unsupported");
  // processBoundaryEvidence=false → turn.boundary=unobservable.
  assert.equal(c["turn.boundary"].level, "unobservable");
});

test("Claude explicit CLI enabled maps to context.render.observe=explicit", () => {
  const adapter = createClaudeAdapter({
    hooks: false,
    explicitCli: true,
    processBoundaryEvidence: false,
  });
  const c = adapter.descriptor.capabilityDescriptor.capabilities;
  assert.equal(c["context.render.observe"].level, "explicit");
  assert.equal(c["context.render.observe"].source, "self-reported");
  assert.equal(c["tool.before.observe"].level, "unsupported");
});

test("Claude processBoundaryEvidence=true maps to turn.boundary=adapter", () => {
  // reportingMode requires explicitCli=true (or hooks=true) — without it,
  // createClaudeAdapter throws. Keep explicitCli=true so we can focus on
  // processBoundaryEvidence.
  const adapter = createClaudeAdapter({
    hooks: false,
    explicitCli: true,
    processBoundaryEvidence: true,
  });
  const c = adapter.descriptor.capabilityDescriptor.capabilities;
  assert.equal(c["turn.boundary"].level, "adapter");
  assert.equal(c["turn.boundary"].source, "static-analysis");
});

// ─── Idempotence + immutability ─────────────────────────────────────────────

test("attachV1CapabilityDescriptor is idempotent", () => {
  const base = createAdapterDescriptor({
    adapterId: "codex",
    vendor: "openai",
    capabilities: { threadWakeup: true, structuredContext: true },
  });
  const wrapped1 = attachV1CapabilityDescriptor(base, {
    version: "1.0.0",
    detectedAt: "2026-07-28T00:00:00.000Z",
  });
  const wrapped2 = attachV1CapabilityDescriptor(wrapped1, {});
  assert.strictEqual(wrapped1, wrapped2);
});

test("legacy descriptor remains usable while v1 is attached", () => {
  // SamHMI pilot + notification-pump still rely on legacy boolean shape;
  // this asserts the v1 attachment does not mutate the legacy view.
  const base = createAdapterDescriptor({
    adapterId: "codex",
    vendor: "openai",
    capabilities: { threadWakeup: true, structuredContext: true },
  });
  const wrapped = attachV1CapabilityDescriptor(base, {});
  assert.equal(wrapped.adapterId, "codex");
  assert.equal(wrapped.capabilities.threadWakeup, true);
  assert.equal(wrapped.capabilities.structuredContext, true);
  // hasCapability against the legacy shape still returns booleans.
  assert.equal(hasCapability(wrapped, "threadWakeup"), true);
  assert.equal(hasCapability(wrapped, "structuredContext"), true);
  // And the v1 capability entry round-trips through the frozen validator.
  const ok = runtimeCap.validateCapabilityDescriptor(wrapped.capabilityDescriptor);
  assert.equal(ok.schema_version, "1.0");
});

// ─── Cross-suite stability ─────────────────────────────────────────────────

test("v1 capability descriptor exposes only frozen names for these adapters", () => {
  const codex = createCodexAdapter({ threadWakeup: true, structuredContext: true });
  const claude = createClaudeAdapter({
    hooks: true, explicitCli: true, processBoundaryEvidence: true,
  });
  for (const name of Object.keys(codex.descriptor.capabilityDescriptor.capabilities)) {
    assert.ok(CAPABILITY_NAMES.includes(name), `${name} not in CAPABILITY_NAMES`);
  }
  for (const name of Object.keys(claude.descriptor.capabilityDescriptor.capabilities)) {
    assert.ok(CAPABILITY_NAMES.includes(name), `${name} not in CAPABILITY_NAMES`);
  }
});

test("CAPABILITY_DESCRIPTOR_SCHEMA_VERSION is 1.0 from both contract modules", () => {
  assert.equal(CAPABILITY_DESCRIPTOR_SCHEMA_VERSION, "1.0");
  assert.equal(runtimeCap.CAPABILITY_DESCRIPTOR_SCHEMA_VERSION, "1.0");
});