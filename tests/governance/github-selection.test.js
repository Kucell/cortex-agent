"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  GitHubSelectionError, inspectGitHubSelection, inspectStructuralEvidence,
} = require("../../lib/governance/github-selection");
const schema = require("../../lib/governance/github-selection-evidence.schema.json");

// Every fixture below is synthetic. Account/repository IDs are comparison
// inputs to frozen comparison policy, NOT an observed dispatch, authenticated
// identity or Owner binding. The adapter has no global Kucell/Owner policy.
// No filesystem, env, credentials, network, subprocess, Host or model is used.
const clone = (v) => JSON.parse(JSON.stringify(v));
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}
const digest = (v) => "sha256:" + crypto.createHash("sha256").update(v, "utf8").digest("hex");
function reseal(f) {
  f.frozen.resource_digest = digest(f.canonical.resource_content);
  f.frozen.decision_digest = digest(f.canonical.decision_content);
  f.selection.resource_digest = f.frozen.resource_digest;
  f.selection.frozen_digest = digest(stable(f.frozen));
  f.context.inputs = clone(f.selection);
  return f;
}
function fixture() {
  const project = "11111111-1111-4111-8111-111111111111";
  const resource = "scope:synthetic-s1";
  const decision = {
    schema_version: 1, decision_id: "D-synthetic-s1", type: "architecture", status: "open",
    requested_by: "synthetic-requester", prompt: "Synthetic inert selection only",
    options: ["approve", "reject", "request_revision"],
    selected_option: null, resolved_by: null, resolved_at: null, rationale: "",
    gate: { action: "architecture", resource_ref: resource },
    relations: { task_ids: [], mission_ids: [], run_ids: [], queue_ids: [], session_ids: [],
      artifact_refs: [], worktree_paths: [] },
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  };
  const controller = {
    workflow_path: ".github/workflows/synthetic-controller.yml", ref: "refs/heads/synthetic",
    workflow_ref: "Kucell/cortex-agent-agent/.github/workflows/synthetic-controller.yml@refs/heads/synthetic",
    workflow_sha: "a".repeat(40), script_digest: "sha256:" + "b".repeat(64),
  };
  const f = {
    selection: { project_id: project, resource_ref: resource, resource_digest: "",
      frozen_digest: "", operation_id: "OP-synthetic-001", action: "approve" },
    frozen: {
      schema_version: 1, project_id: project, subject_id: "50976390",
      product_repository: { id: "1139198846", name: "Kucell/cortex-agent", head_sha: "c".repeat(40) },
      governance_repository: { id: "1266950600", name: "Kucell/cortex-agent-agent", revision: "d".repeat(40) },
      controller, resource_ref: resource, resource_digest: "", decision_id: "D-synthetic-s1",
      decision_digest: "", operation_id: "OP-synthetic-001", operation: "review",
      allowed_actions: ["approve", "reject", "request_revision"],
    },
    context: {
      repository_id: "1266950600", repository: "Kucell/cortex-agent-agent",
      sender_id: "50976390", actor_id: "50976390", triggering_actor_id: "50976390",
      event_name: "workflow_dispatch", workflow_ref: controller.workflow_ref,
      workflow_sha: controller.workflow_sha, script_digest: controller.script_digest,
      ref: controller.ref, run_id: "900000000000000001", run_attempt: 1, inputs: {},
    },
    canonical: {
      project_id: project, revision: "d".repeat(40), resource_ref: resource,
      resource_content: JSON.stringify({ fixture_only: true, project_id: project, operation_id: "OP-synthetic-001" }) + "\n",
      decision_id: "D-synthetic-s1", decision_content: JSON.stringify(decision, null, 2) + "\n",
      consumed_run_keys: [], consumed_selection_keys: [],
    },
  };
  return reseal(f);
}
function rejects(f, code) {
  assert.throws(() => inspectGitHubSelection(f),
    (e) => e instanceof GitHubSelectionError && (!code || e.code === code));
}

test("synthetic positive match returns frozen audit evidence and no authority", () => {
  const f = fixture(), before = JSON.stringify(f);
  const e = inspectGitHubSelection(f);
  assert.equal(e.verification, "STRUCTURAL_MATCH_ONLY");
  assert.equal(e.authentication, "NOT_ESTABLISHED");
  assert.equal(e.authority, "none");
  for (const key of ["execution_authorized", "effect_permitted", "canonical_mutation", "human_presence_verified"]) {
    assert.equal(e[key], false);
  }
  assert.equal(e.selection.operation, "review");
  assert.equal(e.subject.account_id, "50976390");
  assert.equal(e.replay.observation, "NOT_ATOMIC");
  assert.equal(e.replay.consumption, "CANONICAL_TRANSACTION_REQUIRED");
  assert.equal(JSON.stringify(f), before);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.controller) && Object.isFrozen(e.replay));
  assert.equal(inspectStructuralEvidence(clone(e)).audit_ref, e.audit_ref);
});

test("caller-created matching JSON remains unauthenticated", () => {
  const e = inspectGitHubSelection(JSON.parse(JSON.stringify(fixture())));
  assert.equal(e.authentication, "NOT_ESTABLISHED");
  assert.equal(e.execution_authorized, false);
  const forged = clone(e); forged.authentication = "AUTHENTICATED";
  const { audit_ref, ...body } = forged;
  forged.audit_ref = digest(stable(body));
  assert.throws(() => inspectStructuralEvidence(forged), { code: "ERR_GITHUB_SELECTION_SCHEMA" });
});

test("unknown trust flags, callbacks, env, secrets and nested keys reject", () => {
  for (const mutate of [
    (f) => { f.trusted = true; },
    (f) => { f.env = { GITHUB_ACTOR_ID: "50976390" }; },
    (f) => { f.context.authenticated = true; },
    (f) => { f.context.token = "synthetic-not-a-secret"; },
    (f) => { f.context.verify = () => true; },
    (f) => { f.frozen.controller.owner = "Kucell"; },
    (f) => { f.canonical.approved = true; },
  ]) { const f = fixture(); mutate(f); rejects(f); }
});

test("accessors, inherited data, sparse arrays and non-JSON values reject", () => {
  let invoked = false;
  const f = fixture();
  Object.defineProperty(f.context, "actor_id", { enumerable: true, get() { invoked = true; return "50976390"; } });
  rejects(f, "ERR_GITHUB_SELECTION_DATA");
  assert.equal(invoked, false);
  const inherited = fixture(); Object.setPrototypeOf(inherited.context, { authenticated: true }); rejects(inherited);
  const sparse = fixture(); sparse.frozen.allowed_actions = new Array(2); rejects(sparse);
  const missing = fixture(); delete missing.context.actor_id; rejects(missing);
  const symbol = fixture(); symbol.context[Symbol("trusted")] = true; rejects(symbol);
});

test("immutable repository and account IDs and types must match exactly", () => {
  for (const [section, key, value] of [
    ["context", "repository_id", "1139198846"], ["context", "repository", "Kucell/other"],
    ["context", "sender_id", "1"], ["context", "actor_id", "1"],
    ["context", "triggering_actor_id", "1"], ["context", "actor_id", 50976390],
  ]) { const f = fixture(); f[section][key] = value; rejects(f); }
  const product = fixture(); product.frozen.product_repository.id = "1266950600"; reseal(product); rejects(product);
  const governance = fixture(); governance.frozen.governance_repository.id = "1"; reseal(governance); rejects(governance);
});

test("only workflow_dispatch attempt 1 is eligible for structural matching", () => {
  for (const [key, value] of [["event_name", "pull_request_target"], ["event_name", "workflow_run"],
    ["run_attempt", 2], ["run_attempt", "1"], ["run_id", "0"], ["run_id", "01"]]) {
    const f = fixture(); f.context[key] = value; rejects(f, "ERR_GITHUB_SELECTION_SCHEMA");
  }
});

test("workflow ref, SHA, script digest and dispatch ref are all pinned", () => {
  for (const [key, value] of [
    ["workflow_ref", "Kucell/cortex-agent-agent/.github/workflows/other.yml@refs/heads/synthetic"],
    ["workflow_sha", "e".repeat(40)], ["script_digest", "sha256:" + "e".repeat(64)],
    ["ref", "refs/heads/other"],
  ]) { const f = fixture(); f.context[key] = value; rejects(f, "ERR_GITHUB_SELECTION_WORKFLOW"); }
  const ref = fixture(); ref.context.ref = "refs/pull/1/merge"; rejects(ref);
  const mismatch = fixture(); mismatch.frozen.controller.workflow_path = ".github/workflows/other.yml";
  reseal(mismatch); rejects(mismatch, "ERR_GITHUB_SELECTION_WORKFLOW");
});

test("selection must equal dispatch inputs and frozen project/resource/operation", () => {
  const differentInput = fixture(); differentInput.context.inputs.action = "reject";
  rejects(differentInput, "ERR_GITHUB_SELECTION_INPUT_MISMATCH");
  for (const [key, value] of [["project_id", "22222222-2222-4222-8222-222222222222"],
    ["resource_ref", "scope:other"], ["operation_id", "OP-other"]]) {
    const f = fixture(); f.selection[key] = value; f.context.inputs = clone(f.selection); rejects(f);
  }
  const project = fixture(); project.canonical.project_id = "22222222-2222-4222-8222-222222222222"; rejects(project);
});

test("canonical revision and Decision ID must match frozen snapshot", () => {
  for (const [key, value] of [["revision", "e".repeat(40)], ["decision_id", "D-other"]]) {
    const f = fixture(); f.canonical[key] = value; rejects(f, "ERR_GITHUB_SELECTION_REVISION");
  }
});

test("any change to resource or Decision bytes including whitespace rejects", () => {
  for (const key of ["resource_content", "decision_content"]) {
    const f = fixture(); f.canonical[key] += " "; rejects(f, "ERR_GITHUB_SELECTION_DIGEST");
  }
  const digestMismatch = fixture(); digestMismatch.selection.resource_digest = "sha256:" + "0".repeat(64);
  digestMismatch.context.inputs = clone(digestMismatch.selection);
  rejects(digestMismatch, "ERR_GITHUB_SELECTION_DIGEST");
});

test("frozen record binds product SHA, action choices and controller pins", () => {
  const f = fixture(); f.frozen.product_repository.head_sha = "e".repeat(40);
  rejects(f, "ERR_GITHUB_SELECTION_FROZEN_DIGEST");
  const choices = fixture(); choices.frozen.allowed_actions = ["reject"]; reseal(choices);
  rejects(choices, "ERR_GITHUB_SELECTION_ACTION");
  const unknown = fixture(); unknown.selection.action = "execute"; unknown.context.inputs = clone(unknown.selection); rejects(unknown);
});

test("canonical closed Decision schema rejects unknown fields and closed states", () => {
  for (const mutate of [
    (d) => { d.actor_id = "50976390"; },
    (d) => { d.gate.owner = "Kucell"; },
    (d) => { d.status = "canceled"; },
    (d) => { d.selected_option = "approve"; },
    (d) => { d.gate.resource_ref = "scope:other"; },
    (d) => { d.options = ["reject", "request_revision"]; },
    (d) => { d.options = ["approve", "approve"]; },
  ]) {
    const f = fixture(), d = JSON.parse(f.canonical.decision_content);
    mutate(d); f.canonical.decision_content = JSON.stringify(d); reseal(f); rejects(f);
  }
});

test("duplicate JSON keys including escaped aliases and invalid JSON reject", () => {
  for (const raw of ['{"fixture_only":true,"fixture_only":false}', '{"a":1,"\\u0061":2}',
    '{"a":1,}', '{"a":1} trailing', '[1,2]', '{"a":1e999}']) {
    const f = fixture(); f.canonical.resource_content = raw; reseal(f);
    rejects(f, "ERR_GITHUB_SELECTION_JSON");
  }
  const decision = fixture();
  decision.canonical.decision_content = decision.canonical.decision_content.replace('"schema_version": 1',
    '"schema_version": 1, "schema_version": 1');
  reseal(decision); rejects(decision, "ERR_GITHUB_SELECTION_JSON");
});

test("known consumed run and selection keys reject replay", () => {
  const e = inspectGitHubSelection(fixture());
  const run = fixture(); run.canonical.consumed_run_keys = [e.replay.run_key];
  rejects(run, "ERR_GITHUB_SELECTION_REPLAY");
  const selection = fixture(); selection.canonical.consumed_selection_keys = [e.replay.selection_key];
  rejects(selection, "ERR_GITHUB_SELECTION_REPLAY");
});

test("fresh run or opposite choice cannot bypass a consumed selection", () => {
  const e = inspectGitHubSelection(fixture());
  const f = fixture(); f.context.run_id = "900000000000000002";
  f.selection.action = "reject"; f.context.inputs = clone(f.selection);
  f.canonical.consumed_selection_keys = [e.replay.selection_key];
  rejects(f, "ERR_GITHUB_SELECTION_REPLAY");
  f.canonical.consumed_selection_keys = [];
  const changed = inspectGitHubSelection(f);
  assert.equal(changed.replay.selection_key, e.replay.selection_key);
  assert.notEqual(changed.replay.run_key, e.replay.run_key);
});

test("a consumed repository run cannot be reused for another frozen operation", () => {
  const e = inspectGitHubSelection(fixture()), f = fixture();
  f.frozen.operation_id = "OP-synthetic-002"; f.selection.operation_id = "OP-synthetic-002";
  reseal(f); f.canonical.consumed_run_keys = [e.replay.run_key];
  rejects(f, "ERR_GITHUB_SELECTION_REPLAY");
});

test("duplicate, missing and malformed consumption observations reject", () => {
  const e = inspectGitHubSelection(fixture());
  const f = fixture(); f.canonical.consumed_run_keys = [e.replay.run_key, e.replay.run_key]; rejects(f);
  const missing = fixture(); delete missing.canonical.consumed_selection_keys; rejects(missing);
  const malformed = fixture(); malformed.canonical.consumed_selection_keys = ["not-a-digest"]; rejects(malformed);
});

test("audit reference is deterministic and ignores object insertion order", () => {
  const f = fixture(), a = inspectGitHubSelection(f);
  const reverse = (v) => v && typeof v === "object" ? Array.isArray(v) ? v.map(reverse) :
    Object.fromEntries(Object.entries(v).reverse().map(([k, value]) => [k, reverse(value)])) : v;
  assert.equal(inspectGitHubSelection(reverse(f)).audit_ref, a.audit_ref);
  assert.equal(inspectGitHubSelection(f).replay.run_key, a.replay.run_key);
});

test("persisted evidence is closed, versioned and tamper-evident but unauthenticated", () => {
  const e = clone(inspectGitHubSelection(fixture()));
  e.selection.action = "reject";
  assert.throws(() => inspectStructuralEvidence(e), { code: "ERR_GITHUB_SELECTION_AUDIT_DIGEST" });
  const flag = clone(inspectGitHubSelection(fixture())); flag.execution_authorized = true;
  assert.throws(() => inspectStructuralEvidence(flag), { code: "ERR_GITHUB_SELECTION_SCHEMA" });
  const extra = clone(inspectGitHubSelection(fixture())); extra.subject.owner = true;
  assert.throws(() => inspectStructuralEvidence(extra), { code: "ERR_GITHUB_SELECTION_SCHEMA" });
  const old = clone(inspectGitHubSelection(fixture())); old.schema_version = 0;
  assert.throws(() => inspectStructuralEvidence(old), { code: "ERR_GITHUB_SELECTION_SCHEMA" });
});

test("evidence schema closes every object and fixes all authority discriminants", () => {
  function walk(s) {
    if (s.type === "object") {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
  }
  walk(schema);
  assert.equal(schema.properties.authentication.const, "NOT_ESTABLISHED");
  assert.equal(schema.properties.authority.const, "none");
  assert.equal(schema.properties.execution_authorized.const, false);
  assert.equal(schema.properties.canonical_mutation.const, false);
});

test("immutable comparison policy is configurable and never implies Owner", () => {
  const f = fixture();
  f.frozen.subject_id = "700000001";
  f.frozen.product_repository = { id: "700000002", name: "synthetic-org/product", head_sha: "c".repeat(40) };
  f.frozen.governance_repository = { id: "700000003", name: "synthetic-org/governance", revision: "d".repeat(40) };
  f.frozen.controller.workflow_ref = "synthetic-org/governance/.github/workflows/synthetic-controller.yml@refs/heads/synthetic";
  for (const k of ["sender_id", "actor_id", "triggering_actor_id"]) f.context[k] = "700000001";
  f.context.repository_id = "700000003"; f.context.repository = "synthetic-org/governance";
  f.context.workflow_ref = f.frozen.controller.workflow_ref;
  reseal(f);
  const e = inspectGitHubSelection(f);
  assert.equal(e.subject.account_id, "700000001");
  assert.equal(e.authentication, "NOT_ESTABLISHED");
  assert.equal(e.authority, "none");
});

test("resealed audit envelopes still reject contradictory provenance and replay bindings", () => {
  for (const mutate of [
    (e) => { e.subject.account_id = "700000001"; },
    (e) => { e.provenance.sender_id = "700000001"; },
    (e) => { e.provenance.actor_id = "700000001"; },
    (e) => { e.provenance.triggering_actor_id = "700000001"; },
    (e) => { e.provenance.repository_id = "700000003"; },
    (e) => { e.provenance.repository = "synthetic-org/other"; },
    (e) => { e.product_repository.id = e.governance_repository.id; },
    (e) => { e.product_repository.name = e.governance_repository.name; },
    (e) => { e.controller.workflow_path = ".github/workflows/other.yml"; },
    (e) => { e.controller.ref = "refs/heads/other"; },
    (e) => { e.replay.run_key = "sha256:" + "0".repeat(64); },
    (e) => { e.replay.selection_key = "sha256:" + "0".repeat(64); },
    (e) => { e.provenance.run_id = "900000000000000002"; },
    (e) => { e.selection.operation_id = "OP-other"; },
    (e) => { e.governance_repository.revision = "e".repeat(40); },
  ]) {
    const e = clone(inspectGitHubSelection(fixture()));
    mutate(e);
    const { audit_ref, ...body } = e;
    e.audit_ref = digest(stable(body));
    assert.throws(() => inspectStructuralEvidence(e), (error) => error instanceof GitHubSelectionError &&
      ["ERR_GITHUB_SELECTION_EVIDENCE_BINDING", "ERR_GITHUB_SELECTION_EVIDENCE_REPLAY"].includes(error.code));
  }
});
