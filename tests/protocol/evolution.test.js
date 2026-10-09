"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeEvidenceBundle, normalizeEvolutionCandidate, createReasoningHandoff, normalizeEvolutionOutcome,
} = require("../../packages/protocol/src/evolution");

const observedAt = "2026-10-09T01:00:00.000Z";
function bundle(overrides = {}) {
  return {
    schema_version: "1", project_ref: "project:welding", source_revision: "abc12345", scope: "project",
    observations: [{kind: "test_result", evidence_ref: "test:robodk-001", observed_at: observedAt, redacted: true}],
    ...overrides,
  };
}
function candidate(overrides = {}) {
  return {
    schema_version: "1", candidate_id: "EC-001", project_ref: "project:welding",
    source_revision: "abc12345", scope: "project", hypothesis: "RoboDK version difference",
    evidence_refs: ["test:robodk-001"], ...overrides,
  };
}
function request(overrides = {}) {
  return {
    host_ref: "host:codex", host_capabilities: ["runtime.run.create", "runtime.run.status"],
    required_capabilities: ["runtime.run.create"], budget: {max_output_tokens: 1000, timeout_ms: 10000},
    ...overrides,
  };
}
function outcome(overrides = {}) {
  return {
    schema_version: "1", project_ref: "project:welding", candidate_id: "EC-001",
    task_id: "T-001", run_ref: "run:R-001", verification_status: "passed",
    verification_refs: ["test:passed-001"], ...overrides,
  };
}
const errorCode = (code) => (error) => error && error.code === code;

test("project evidence is versioned, immutable and redaction gated", () => {
  const x = normalizeEvidenceBundle(bundle());
  assert.equal(x.project_ref, "project:welding");
  assert.equal(x.observations[0].redacted, true);
  assert.ok(Object.isFrozen(x.observations));
  assert.throws(() => normalizeEvidenceBundle(bundle({observations: [
    {kind:"test_result",evidence_ref:"test:robodk-001",observed_at:observedAt,redacted:false},
  ]})), errorCode("ERR_EVOLUTION_UNREDACTED"));
});

test("unexpected fields, path traversal and duplicate observations fail closed", () => {
  assert.throws(() => normalizeEvidenceBundle(bundle({model_prompt:"send private data"})), errorCode("ERR_EVOLUTION_FIELD_UNKNOWN"));
  assert.throws(() => normalizeEvidenceBundle(bundle({source_revision:"../../a"})), errorCode("ERR_EVOLUTION_ID_INVALID"));
  assert.throws(() => normalizeEvidenceBundle(bundle({observations: [
    {kind:"test_result",evidence_ref:"file:../../secrets",observed_at:observedAt,redacted:true},
  ]})), errorCode("ERR_EVOLUTION_EVIDENCE_REF"));
  const o = bundle().observations[0];
  assert.throws(() => normalizeEvidenceBundle(bundle({observations:[o,o]})), errorCode("ERR_EVOLUTION_DUPLICATE"));
});

test("framework candidates need revision-pinned explicit consent", () => {
  assert.throws(() => normalizeEvidenceBundle(bundle({scope:"framework_candidate"})),errorCode("ERR_EVOLUTION_CONSENT_REQUIRED"));
  const consent = {consent_ref:"decision:D-001",purpose:"generic_summary",source_revision:"abc12345"};
  assert.equal(normalizeEvidenceBundle(bundle({scope:"framework_candidate",promotion_consent:consent})).scope,"framework_candidate");
  assert.throws(() => normalizeEvidenceBundle(bundle({scope:"framework_candidate",promotion_consent:{...consent,source_revision:"old"}})),errorCode("ERR_EVOLUTION_STALE_CONSENT"));
  assert.throws(() => normalizeEvidenceBundle(bundle({promotion_consent:consent})),errorCode("ERR_EVOLUTION_UNEXPECTED_CONSENT"));
});

test("project/ref/revision mismatch and unapproved downgrade rejected", () => {
  assert.equal(normalizeEvolutionCandidate(candidate(),bundle()).risk_tier,"medium");
  assert.equal(normalizeEvolutionCandidate(candidate({risk_tier:"high"}),bundle()).risk_tier,"high");
  assert.throws(() => normalizeEvolutionCandidate(candidate({project_ref:"project:brivya"}),bundle()),errorCode("ERR_EVOLUTION_SCOPE_MISMATCH"));
  assert.throws(() => normalizeEvolutionCandidate(candidate({source_revision:"other"}),bundle()),errorCode("ERR_EVOLUTION_STALE_REVISION"));
  assert.throws(() => normalizeEvolutionCandidate(candidate({evidence_refs:["file:private-data"]}),bundle()),errorCode("ERR_EVOLUTION_EVIDENCE_OUT_OF_SCOPE"));
  assert.throws(() => normalizeEvolutionCandidate(candidate({risk_tier:"low"}),bundle()),errorCode("ERR_EVOLUTION_RISK_ESCALATION_REQUIRED"));
});

test("AI handoff carries scoped evidence, a bound budget and no effects", () => {
  const x = createReasoningHandoff(request(),candidate(),bundle());
  assert.equal(x.mode,"analysis_only");
  assert.deepEqual(x.allowed_effects,[]);
  assert.deepEqual(x.evidence_refs,["test:robodk-001"]);
  assert.ok(Object.isFrozen(x.allowed_effects));
});

test("missing or unsafe host capabilities, write attempts and runaway budgets fail closed", () => {
  assert.throws(() => createReasoningHandoff(request({host_capabilities:[]}),candidate(),bundle()),errorCode("ERR_EVOLUTION_CAPABILITY_MISSING"));
  assert.throws(() => createReasoningHandoff(request({required_capabilities:["decisions.write"]}),candidate(),bundle()),errorCode("ERR_EVOLUTION_CAPABILITY_UNSAFE"));
  assert.throws(() => createReasoningHandoff(request({allowed_effects:["push"]}),candidate(),bundle()),errorCode("ERR_EVOLUTION_FIELD_UNKNOWN"));
  assert.throws(() => createReasoningHandoff(request({budget:{max_output_tokens:999999,timeout_ms:10000}}),candidate(),bundle()),errorCode("ERR_EVOLUTION_BUDGET"));
});

test("verification outcome is a receipt, not merge/release authority", () => {
  const x = normalizeEvolutionOutcome(outcome(),candidate(),bundle());
  assert.equal(x.verification_status,"passed");
  assert.equal(x.decision_id,null);
  assert.equal("approved" in x,false);
  assert.throws(() => normalizeEvolutionOutcome(outcome({merged:true}),candidate(),bundle()),errorCode("ERR_EVOLUTION_FIELD_UNKNOWN"));
  assert.throws(() => normalizeEvolutionOutcome(outcome({candidate_id:"EC-OTHER"}),candidate(),bundle()),errorCode("ERR_EVOLUTION_SCOPE_MISMATCH"));
  assert.throws(() => normalizeEvolutionOutcome(outcome({verification_refs:[]}),candidate(),bundle()),errorCode("ERR_EVOLUTION_LIST_INVALID"));
});

test("not_run requires zero verification refs, and completed states require evidence", () => {
  assert.equal(normalizeEvolutionOutcome(outcome({verification_status:"not_run",verification_refs:[]}),candidate(),bundle()).verification_status,"not_run");
  assert.throws(() => normalizeEvolutionOutcome(outcome({verification_status:"not_run"}),candidate(),bundle()),errorCode("ERR_EVOLUTION_UNEXPECTED_VERIFICATION"));
});
