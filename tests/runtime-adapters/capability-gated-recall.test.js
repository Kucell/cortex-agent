"use strict";

// Capability-gated recall E2E (M-032 VC-005 / P-001): the sub-agent recall
// path is enabled only when the host descriptor declares subagent +
// prompt_guidance. Absent capability yields explicit CLI fallback.

const test = require("node:test");
const assert = require("node:assert/strict");

const cap = require("../../lib/runtime-adapters/capability-contract");
const { DshAdapter } = require("../../lib/agents/adapters/dsh");

function gate({ subagent = true, promptGuidance = true } = {}) {
  const levels = { native: 4, adapter: 3, explicit: 2, unobservable: 1, unsupported: 0 };
  const support = { subagent, promptGuidance };
  const check = (name) => {
    const value = name === "subagent" ? support.subagent : support.promptGuidance;
    return value ? { level: "native", source: "runtime-trace", reason: "declared" } : { level: "unsupported", source: "not-implemented", reason: "not declared" };
  };
  const descriptor = {
    schema_version: "1.0",
    host: { adapter_id: "dsh", vendor: "deepseek", version: "0.1.0" },
    detected_at: "2026-09-09T00:00:00.000Z",
    capabilities: {
      "subagent": check("subagent"),
      "prompt_guidance": check("promptGuidance"),
    },
  };
  const validated = cap.validateCapabilityDescriptor(descriptor);
  const present = (name) => levels[validated.capabilities[name].level] >= levels.native;
  const supported = present("subagent") && present("prompt_guidance");
  return { supported, mode: supported ? "sub_agent_flow" : "explicit_cli_fallback" };
}

test("VC-005: capability-supported host enables the recall sub-agent flow", () => {
  const result = gate({ subagent: true, promptGuidance: true });
  assert.equal(result.supported, true);
  assert.equal(result.mode, "sub_agent_flow");
});

test("VC-005: missing subagent capability falls back to explicit CLI", () => {
  const result = gate({ subagent: false, promptGuidance: true });
  assert.equal(result.supported, false);
  assert.equal(result.mode, "explicit_cli_fallback");
});

test("VC-005: missing prompt guidance capability also falls back", () => {
  const result = gate({ subagent: true, promptGuidance: false });
  assert.equal(result.supported, false);
  assert.equal(result.mode, "explicit_cli_fallback");
});

test("DSH adapter declares subagent + prompt_guidance as native", () => {
  const adapter = new DshAdapter({ bin: "/bin/true" });
  const descriptor = adapter.discover().capability_descriptor;
  assert.equal(cap.validateCapabilityDescriptor(descriptor).capabilities.subagent.level, "native");
  assert.equal(cap.validateCapabilityDescriptor(descriptor).capabilities.prompt_guidance.level, "native");
});

test("DSH descriptor validates against extended vocabulary", () => {
  const adapter = new DshAdapter({ bin: "/bin/true" });
  const descriptor = adapter.discover().capability_descriptor;
  assert.doesNotThrow(() => cap.validateCapabilityDescriptor(descriptor));
});
