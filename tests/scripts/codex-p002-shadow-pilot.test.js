"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createShadowObservation, toPublicError, validateAdmission } = require("../../scripts/codex-p002-shadow-pilot.js");

const minimalContext = {
  REVISION: "fixture-revision",
  projectMinimalContext() {
    return {
      level: "minimal",
      estimated_tokens: 42,
      truncated: false,
      omitted: 0,
      fallback_used: false,
      items: [{ path: "lib/secret.js", reason_code: "l0_match" }],
    };
  },
};

const index = { modules: [] };

function admission(extra = {}) {
  return {
    attempt_id: "ocx-codex-pilot-001",
    task_id: "T-CODEX-PILOT-001",
    task_terms: ["token", "projection"],
    changed_files: ["lib/policy.js"],
    ...extra,
  };
}

test("Codex P-002 pilot returns a side-effect-free summary", () => {
  const result = createShadowObservation(admission(), { minimalContext, index });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "shadow");
  assert.equal(result.policy, "P-002");
  assert.equal(result.host, "codex");
  assert.equal(result.side_effects, "none");
  assert.equal(result.persisted, false);
  assert.match(result.projection.context_index_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...result.projection, context_index_digest: undefined }, {
    revision: "fixture-revision",
    context_index_digest: undefined,
    level: "minimal",
    estimated_tokens: 42,
    truncated: false,
    omitted: 0,
    item_count: 1,
    fallback_used: false,
    reason_codes: ["l0_match"],
  });
});

test("Codex P-002 pilot never emits task terms or selected paths", () => {
  const result = createShadowObservation(admission({ task_terms: ["privateTaskTerm"] }), { minimalContext, index });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("privateTaskTerm"), false);
  assert.equal(serialized.includes("lib/secret.js"), false);
});

test("Codex P-002 pilot rejects another Host and private payload fields", () => {
  assert.deepEqual(validateAdmission(admission({ attempt_id: "dsh-other-host" })), { ok: false, error: "codex_attempt_id_required" });
  assert.deepEqual(validateAdmission(admission({ prompt: "do not accept" })), { ok: false, error: "forbidden_field", field: "prompt" });
  assert.deepEqual(validateAdmission(admission({ extra: true })), { ok: false, error: "unknown_field", field: "extra" });
});

test("Codex P-002 pilot rejects unsafe metadata", () => {
  assert.deepEqual(validateAdmission(admission({ task_terms: ["contains spaces"] })), { ok: false, error: "invalid_task_terms" });
  assert.deepEqual(validateAdmission(admission({ changed_files: ["/private/path.js"] })), { ok: false, error: "invalid_changed_files" });
  assert.deepEqual(validateAdmission(admission({ changed_files: ["../escape.js"] })), { ok: false, error: "invalid_changed_files" });
  assert.deepEqual(validateAdmission(admission({ task_id: "contains private text" })), { ok: false, error: "invalid_identifier", field: "task_id" });
  assert.deepEqual(validateAdmission(admission({ model: "bad model" })), { ok: false, error: "invalid_identifier", field: "model" });
});

test("Codex P-002 pilot binds the projection to the exact index snapshot", () => {
  const baseline = createShadowObservation(admission(), { minimalContext, index: { modules: [] } });
  const changed = createShadowObservation(admission(), { minimalContext, index: { modules: [{ module_name: "changed" }] } });
  assert.notEqual(baseline.projection.context_index_digest, changed.projection.context_index_digest);
  assert.notEqual(baseline.projection_digest, changed.projection_digest);
});

test("Codex P-002 pilot uses an allowlisted public error only", () => {
  const privateError = new Error("privateTaskTerm /secret/source.js credential=hidden");
  const result = toPublicError(privateError);
  assert.deepEqual(result, { ok: false, error: "pilot_failed" });
  assert.equal(JSON.stringify(result).includes("privateTaskTerm"), false);
});
