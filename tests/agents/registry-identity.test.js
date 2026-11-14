"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deriveAgentId, validateIdentity, managedId, validateOwnedFiles,
  validateManagedEntry } = require("../../lib/agents/registry-identity");

const identity = { provider: "openai", adapter_type: "codex", subject: "native-session-a" };

test("managed identity is deterministic, key-order independent, and separates native hosts", () => {
  const id = deriveAgentId(identity);
  assert.match(id, /^agent-[a-f0-9]{64}$/);
  assert.equal(deriveAgentId({ subject: identity.subject, adapter_type: "codex", provider: "openai" }), id);
  for (const changed of [{ subject: "native-session-b" }, { provider: "other" }, { adapter_type: "dsh" }]) {
    assert.notEqual(deriveAgentId({ ...identity, ...changed }), id);
  }
});

test("role/model or task declarations cannot mint or replace a native identity", () => {
  for (const bad of [null, [], {}, { ...identity, role: "reviewer" },
    { ...identity, model: "other" }, { ...identity, subject: " " },
    { ...identity, subject: "session\nsecret" }, { ...identity, provider: "OpenAI" },
    { ...identity, adapter_type: "bogus" }]) assert.throws(() => validateIdentity(bad));
});

test("only generated IDs are accepted by the managed writer", () => {
  for (const id of ["../sample", "agent.schema", "sample", "a/b", "C:\\test", "agent-123", null]) {
    assert.throws(() => managedId(id), { code: "ERR_REGISTRY_INVALID" });
  }
  assert.equal(managedId(deriveAgentId(identity)), deriveAgentId(identity));
});

test("ownership grants are exact relative files, not scope-expanding patterns", () => {
  assert.doesNotThrow(() => validateOwnedFiles(["lib/agents/cli.js", ".agent/rules/example.md"]));
  for (const files of [[], ["/etc/passwd"], ["a/../b"], ["a//b"], ["src/**"],
    ["C:\\temp"], ["a", "a"], ["./a"], ["src/{a,b}.js"]]) {
    assert.throws(() => validateOwnedFiles(files), { code: "ERR_REGISTRY_INVALID" });
  }
});

test("legacy records remain readable; partial managed records fail closed", () => {
  assert.equal(validateManagedEntry({ agent_id: "legacy" }).agent_id, "legacy");
  for (const field of ["identity", "enabled", "registration"]) {
    assert.throws(() => validateManagedEntry({ [field]: true }), { code: "ERR_REGISTRY_INVALID" });
  }
});
