"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validatePolicy, validateGrant } = require("../../lib/agents/registry-authorization");

function grant() {
  return { identity: { provider: "openai", adapter_type: "codex", subject: "native-a" },
    role: "implementer", model: "test-model", capabilities: ["code_generation", "test_writing"],
    projects: ["example"], owned_files: ["lib/example.js"] };
}

function policy() {
  return { schema_version: 1, owner_id: "owner", local_user: "os-user", project_id: "example",
    maintainers: [{ actor_id: "maintainer", session_id: "native-m", projects: ["example"] }],
    grants: [grant()] };
}

test("owner policy validates exact grants and independent reviewer identities", () => {
  const p = policy();
  p.grants.push({ ...grant(), identity: { ...grant().identity, subject: "native-b" },
    role: "reviewer", capabilities: ["code_review"] });
  assert.equal(validatePolicy(p), p);
  assert.throws(() => validatePolicy({ ...p, grants: [grant(), { ...grant(), role: "reviewer",
    capabilities: ["code_review"] }] }), { code: "ERR_REGISTRY_INVALID" });
});

test("owner policy refuses malformed, ambiguous or cross-project authority", () => {
  for (const override of [{ schema_version: 2 }, { local_user: "" }, { owner_id: "" },
    { maintainers: [] }, { maintainers: [{ ...policy().maintainers[0], role: "owner" }] },
    { maintainers: [...policy().maintainers, ...policy().maintainers] },
    { grants: [{ ...grant(), projects: ["unrelated"] }] }, { grants: [grant(), grant()] },
    { project_id: "bad/../id" }, { surprise: true }]) {
    assert.throws(() => validatePolicy({ ...policy(), ...override }));
  }
});

test("capabilities must match the role; subscription alone never grants registration", () => {
  for (const override of [{ capabilities: ["javascript"] }, { capabilities: ["code_generation"] },
    { role: "reviewer", capabilities: ["test_writing"] },
    { role: "reviewer", capabilities: ["code_review", "code_generation"] },
    { role: "coordinator", capabilities: ["code_generation"] },
    { projects: [] }, { owned_files: ["src/**"] }, { model: "" }, { role: "owner" },
    { enabled: true }]) assert.throws(() => validateGrant({ ...grant(), ...override }));
});
