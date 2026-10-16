"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { prepareAdvisoryPlan, validateAdvisoryPlan, sha256 } = require("../../lib/next-action/advisory-plan.js");
const { readCanonicalPlanSources } = require("../../lib/next-action/canonical-plan-source.js");
const { pairedCanonicalGate } = require("../../lib/next-action/canonical-pair.js");
const { buildNextActionProjection } = require("../../lib/next-action/index.js");
const NOW = "2026-10-16T12:00:00.000Z";
const CREATED = "2026-10-16T10:00:00.000Z";
const EXPIRES = "2026-10-16T14:00:00.000Z";
const REV = { domain: "governance_store", store_kind: "git", value: "a".repeat(40) };
const clone = (value) => JSON.parse(JSON.stringify(value));
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const gitBlob = (text) => crypto.createHash("sha1").update("blob " + Buffer.byteLength(text) + "\0").update(text).digest("hex");
function fixture() {
  const contract = { schema_version: 2, mission_id: "M-A", proposal_hash: "0123456789abcdef",
    generated_at: CREATED, states: { current: "done", transitions: [] }, milestones: [], gates: [] };
  const contractText = json(contract);
  const taskText = json({ task_id: "T-A", status: "active", dependencies: [], validation_commands: ["node --test fixture-only.test.js"] });
  const plan = { schema_version: 1, plan_id: "AP-A", project_id: "alpha", task_id: "T-A", mission_id: "M-A",
    task_source: { path: "tasks/T-A.json", git_blob: gitBlob(taskText) },
    mission_contract: { path: "missions/M-A/validation-contract.json", sha256: sha256(contractText) },
    scope: { repository: "fixture/alpha", branch: "main", product_commit: "b".repeat(40),
      allowed_paths: ["lib/**"], allowed_operations: ["prepare_patch"] },
    risk_tier: "medium", validation_commands: ["node --test fixture-only.test.js"],
    estimated_budget: { tokens: 1000, cost_amount: 0.25, currency: "USD" },
    required_host_capabilities: ["runtime.reason"], stop_conditions: ["Stop on scope drift"],
    created_at: CREATED, expires_at: EXPIRES,
    approval: { action: "external_side_effect", owner_workflow: "/mission", decision_id: "D-A", waitpoint_id: "WP-A" } };
  const draft = prepareAdvisoryPlan(json(plan));
  const relations = { task_ids: ["T-A"], mission_ids: ["M-A"], run_ids: [], queue_ids: [],
    session_ids: [], artifact_refs: [draft.resource_ref], worktree_paths: [] };
  const d = { schema_version: 1, decision_id: "D-A", type: "approval", status: "approved",
    requested_by: "fixture-requester", prompt: "Review the exact fixture plan", options: ["approve", "reject"],
    selected_option: "approve", resolved_by: "fixture-reviewer", resolved_at: "2026-10-16T10:30:00.000Z",
    rationale: "Fixture only", gate: { action: "external_side_effect", resource_ref: draft.resource_ref },
    relations, created_at: CREATED, updated_at: "2026-10-16T10:30:00.000Z" };
  const w = { schema_version: 1, waitpoint_id: "WP-A", status: "released", owner_workflow: "/mission",
    reason: "Fixture pair", gate: clone(d.gate), decision_id: "D-A", evidence_refs: [draft.resource_ref],
    relations: clone(relations), created_at: CREATED, updated_at: "2026-10-16T10:45:00.000Z",
    released_at: "2026-10-16T10:45:00.000Z", released_by: "fixture-owner", expires_at: EXPIRES };
  const files = new Map([[plan.mission_contract.path, contractText], [draft.path, draft.content],
    ["decisions/D-A.json", json(d)], ["waitpoints/WP-A.json", json(w)]]);
  const tasks = { project_ref: "project:alpha", source_ref: "binding:fixture#tasks", origin_ref: "fixture:tasks",
    revision: REV, observed_at: NOW, max_age_seconds: 300, status: "observed",
    read_receipts: [{ key: "tasks/T-A.json", revision: REV, blob: gitBlob(taskText) }], reason_codes: ["canonical_scope_artifact_not_mapped"],
    records: [{ project_ref: "project:alpha", governance_revision: REV, task_ref: "T-A", source_ref: "fixture:task",
      status: "active", priority: "P1", owner_ref: "fixture-owner", dependencies: [], validation_plan: { tests: ["node --test fixture-only.test.js"] },
      mission_ref: null, verification_status: null }] };
  return { contract, plan, draft, d, w, files, tasks };
}
function storeFor(f, hooks = {}) {
  const token = () => hooks.revision ? hooks.revision() : { store_kind: "git", value: REV.value };
  const blob = (text) => crypto.createHash("sha1").update("blob " + Buffer.byteLength(text) + "\0").update(text).digest("hex");
  return { kind: "git", getRevision: token,
    listEntries(namespace) {
      const entries = [...f.files].filter(([key]) => key.startsWith(namespace + "/"))
        .map(([key, text]) => ({ key, type: "blob", mode: "100644", blob: blob(text) }));
      if (hooks.entries) hooks.entries(namespace, entries);
      return { revision: token(), entries };
    },
    readText(key, options) {
      const content = f.files.get(key);
      if (typeof content !== "string" || Buffer.byteLength(content) > options.max_bytes) throw new Error("fixture read limit");
      if (hooks.read) hooks.read(key);
      return { ok: true, exists: true, revision: token(), blob: blob(content), content };
    },
  };
}
function read(f, hooks = {}) {
  return readCanonicalPlanSources({ store: storeFor(f, hooks), project_ref: "project:alpha",
    governance_binding_ref: "binding:fixture", observed_at: NOW, expected_revision: REV, tasks: f.tasks });
}
function gate(result) {
  return pairedCanonicalGate(result.tasks.records[0], result.decisions.records, result.waitpoints.records, Date.parse(NOW), REV);
}
function replacePlan(f, edit) {
  edit(f.plan);
  f.draft = prepareAdvisoryPlan(json(f.plan));
  f.files.set(f.draft.path, f.draft.content);
}
function setDecision(f) { f.files.set("decisions/" + f.d.decision_id + ".json", json(f.d)); }
function setWaitpoint(f) { f.files.set("waitpoints/" + f.w.waitpoint_id + ".json", json(f.w)); }

test("pure plan draft returns exact full-byte digest and no write/execute permission", () => {
  const f = fixture(), before = json(f.plan), draft = prepareAdvisoryPlan(json(f.plan));
  assert.equal(json(f.plan), before); assert.equal(draft.status, "DRAFT_PREPARED");
  assert.equal(draft.sha256, sha256(draft.content)); assert.match(draft.sha256, /^[0-9a-f]{64}$/);
  assert.equal(draft.path, "missions/M-A/advisory-plans/AP-A.json");
  assert.equal(draft.resource_ref, "artifact:" + draft.path + "#sha256:" + draft.sha256);
  assert.equal(draft.write_permitted, false); assert.equal(draft.execution_authorized, false);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(draft.content), "plan_digest"), false);
  let touched = 0;
  const objectInput = { get scope() { touched++; return {}; }, toJSON() { touched++; return f.plan; } };
  assert.throws(() => prepareAdvisoryPlan(objectInput), /ERR_ADVISOR_PLAN_TEXT/);
  assert.equal(touched, 0);
  assert.throws(() => prepareAdvisoryPlan(" ".repeat(1024 * 1024 + 1)), /ERR_ADVISOR_PLAN_TEXT/);
});
test("plan draft rejects unknown authority fields and missing scope/budget/capabilities", () => {
  const f = fixture();
  for (const edit of [
    (p) => { p.execution_authorized = true; }, (p) => { p.scope = {}; }, (p) => { delete p.estimated_budget; },
    (p) => { p.required_host_capabilities = []; }, (p) => { p.approval.owner_workflow = "/user"; },
    (p) => { p.mission_contract.sha256 = "0123456789abcdef"; },
  ]) { const p = clone(f.plan); edit(p); assert.throws(() => prepareAdvisoryPlan(json(p))); }
});
test("plan validation rejects unsafe IDs/paths, future-invalid interval and nonfinite budget", () => {
  const f = fixture();
  for (const edit of [
    (p) => { p.task_id = "T-..A"; }, (p) => { p.scope.allowed_paths = ["../private"]; },
    (p) => { p.scope.allowed_paths = ["C:/private"]; },
    (p) => { p.scope.branch = "main.lock"; }, (p) => { p.scope.branch = "feature with spaces"; },
    (p) => { p.scope.branch = "@"; }, (p) => { p.expires_at = p.created_at; },
    (p) => { p.estimated_budget.cost_amount = Infinity; }, (p) => { p.estimated_budget.tokens = 0.5; },
  ]) { const p = clone(f.plan); edit(p); assert.throws(() => validateAdvisoryPlan(p)); }
});
test("committed scope maps Task/Mission identity and canonical pair without invented Decision expiry", () => {
  const f = fixture(), result = read(f), paired = gate(result);
  assert.equal(result.status, "observed"); assert.equal(result.execution_authorized, false);
  assert.equal(result.tasks.records[0].mission_ref, "M-A");
  assert.equal(result.tasks.records[0].plan_digest, f.draft.sha256);
  assert.deepEqual(result.tasks.records[0].canonical_plan.task_source, f.plan.task_source);
  assert.ok(result.tasks.records[0].canonical_plan.task_source_ref.endsWith("#git-blob:" + f.plan.task_source.git_blob));
  assert.equal(result.tasks.records[0].estimated_budget.reservation_observed, false);
  assert.deepEqual(paired.problems, []); assert.equal(paired.approval_required, false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.decisions.records[0].canonical_record, "expires_at"), false);
});
test("Mission contract done/gates remain identity-only and cannot verify completion", () => {
  const result = read(fixture());
  assert.equal(result.missions.records[0].identity_only, true);
  assert.equal(result.missions.records[0].verification_status, null);
  assert.equal(result.tasks.records[0].verification_status, null);
});
test("canonical projection remains diagnostic with unobserved Host/lease/CI/project", () => {
  const result = read(fixture());
  const projection = buildNextActionProjection({ project_ref: "project:alpha", governance_revision: REV, observed_at: NOW,
    sources: { tasks: result.tasks, missions: result.missions, decisions: result.decisions, waitpoints: result.waitpoints } });
  const row = projection.recommendations[0];
  assert.equal(row.advice_status, "INSUFFICIENT_EVIDENCE"); assert.equal(row.execution_authorized, false);
  for (const code of ["source_project_not_observed", "ci_not_observed", "live_owner_lease_fence_not_verified", "host_not_proven"]) {
    assert.ok(row.blocking_reasons.includes(code), code);
  }
  for (const code of ["scope_unknown", "mission_not_observed", "matching_approved_decision_not_observed"]) {
    assert.ok(!row.blocking_reasons.includes(code), code);
  }
});
test("plan path identity and explicit project mismatch discard scope mapping", () => {
  for (const edit of [(f) => { replacePlan(f, (p) => { p.project_id = "beta"; }); },
    (f) => { const raw = f.files.get(f.draft.path); f.files.delete(f.draft.path); f.files.set("missions/M-B/advisory-plans/AP-A.json", raw); }]) {
    const f = fixture(); edit(f); const result = read(f);
    assert.equal(result.status, "unavailable"); assert.equal(result.tasks.records[0].mission_ref, null);
  }
});
test("Mission contract digest/path/identity are independently required", () => {
  for (const edit of [(f) => { f.files.set(f.plan.mission_contract.path, f.files.get(f.plan.mission_contract.path) + " "); },
    (f) => { f.files.delete(f.plan.mission_contract.path); },
    (f) => { f.contract.mission_id = "M-B"; const raw = json(f.contract); f.files.set(f.plan.mission_contract.path, raw); replacePlan(f, (p) => { p.mission_contract.sha256 = sha256(raw); }); }]) {
    const f = fixture(); edit(f); const result = read(f);
    assert.equal(result.status, "unavailable"); assert.deepEqual(result.missions.records, []);
  }
});
test("two active plans for one Task conflict without selecting latest", () => {
  const f = fixture(), p = clone(f.plan); p.plan_id = "AP-B";
  const second = prepareAdvisoryPlan(json(p)); f.files.set(second.path, second.content);
  const result = read(f); assert.equal(result.status, "conflict");
  assert.deepEqual(result.reason_codes, ["ERR_ADVISOR_PLAN_AMBIGUOUS"]); assert.equal(result.tasks.records[0].mission_ref, null);
});
test("raw whitespace edit changes resource digest and cannot reuse old pair", () => {
  const f = fixture(); f.files.set(f.draft.path, f.draft.content + " ");
  const result = read(f); assert.equal(result.status, "observed");
  assert.notEqual(result.tasks.records[0].plan_digest, f.draft.sha256);
  assert.deepEqual(gate(result).problems, ["canonical_pair_missing"]);
});
test("expired and future plan validity are distinct from Waitpoint expiry", () => {
  const f = fixture(), result = read(f), task = clone(result.tasks.records[0]);
  task.canonical_plan.expires_at = "2026-10-16T11:00:00.000Z";
  assert.deepEqual(pairedCanonicalGate(task, result.decisions.records, result.waitpoints.records, Date.parse(NOW), REV).problems, ["canonical_plan_expired"]);
  task.canonical_plan.expires_at = EXPIRES; task.canonical_plan.created_at = "2026-10-16T13:00:00.000Z";
  assert.deepEqual(pairedCanonicalGate(task, result.decisions.records, result.waitpoints.records, Date.parse(NOW), REV).problems, ["canonical_plan_validity_invalid"]);
});
test("duplicate Decision or Waitpoint for the same resource blocks unique-pair observation", () => {
  for (const kind of ["decision", "waitpoint"]) {
    const f = fixture();
    if (kind === "decision") { f.d.decision_id = "D-B"; setDecision(f); }
    else { f.w.waitpoint_id = "WP-B"; setWaitpoint(f); }
    const result = read(f); assert.equal(result.status, "observed");
    assert.deepEqual(gate(result).problems, ["canonical_pair_ambiguous"]); assert.equal(gate(result).hard, true);
  }
});
test("rejected/canceled/superseded Decision cannot be approved by a released Waitpoint", () => {
  for (const status of ["rejected", "canceled", "superseded"]) {
    const f = fixture(); f.d.status = status;
    if (status === "rejected") f.d.selected_option = "reject";
    if (status === "superseded") { f.d.selected_option = null; f.d.superseded_by_decision_id = "D-B"; }
    setDecision(f); const result = read(f); assert.equal(result.status, "observed");
    assert.deepEqual(gate(result).problems, ["canonical_decision_not_approved"]); assert.equal(gate(result).hard, true);
  }
});
test("open Decision stays pending even with contradictory released Waitpoint", () => {
  const f = fixture(); Object.assign(f.d, { status: "open", selected_option: null, resolved_by: null, resolved_at: null });
  setDecision(f); const paired = gate(read(f));
  assert.deepEqual(paired.pending, ["D-A"]); assert.equal(paired.approval_required, true);
});
test("approved Decision with reject or unknown selected option is blocked", () => {
  for (const value of ["reject", "other"]) {
    const f = fixture(); f.d.selected_option = value; setDecision(f);
    assert.deepEqual(gate(read(f)).problems, ["canonical_decision_selection_invalid"]);
  }
});
test("Waitpoint owner_workflow must match the plan independently of provenance labels", () => {
  const f = fixture(); f.w.owner_workflow = "/user"; f.w.workflow_gate = "mission"; setWaitpoint(f);
  assert.deepEqual(gate(read(f)).problems, ["canonical_pair_scope_mismatch"]);
});
test("cross-Task or cross-Mission pair relations cannot match the exact resource alone", () => {
  for (const kind of ["task_ids", "mission_ids"]) {
    const f = fixture(); f.d.relations[kind] = [kind === "task_ids" ? "T-B" : "M-B"]; setDecision(f);
    assert.deepEqual(gate(read(f)).problems, ["canonical_pair_scope_mismatch"]);
  }
});
test("Waitpoint release before resolution, missing release digest and future resolution are rejected", () => {
  const a = fixture(); a.w.released_at = CREATED; setWaitpoint(a);
  assert.deepEqual(gate(read(a)).problems, ["canonical_waitpoint_release_invalid"]);
  const b = fixture(); b.w.evidence_refs = ["other"]; setWaitpoint(b);
  assert.deepEqual(gate(read(b)).problems, ["canonical_waitpoint_release_invalid"]);
  const c = fixture(); c.d.resolved_at = "2026-10-16T13:00:00.000Z"; setDecision(c);
  assert.deepEqual(gate(read(c)).problems, ["canonical_decision_resolution_invalid"]);
});
test("missing, invalid and elapsed Waitpoint deadline do not mint Decision expiry", () => {
  for (const value of [null, "2026-10-16T10:00:00.000Z", "2026-10-16T11:00:00.000Z"]) {
    const f = fixture(); f.w.expires_at = value; setWaitpoint(f);
    const code = value === "2026-10-16T11:00:00.000Z" ? "canonical_waitpoint_expired" : "canonical_waitpoint_deadline_missing_or_invalid";
    assert.deepEqual(gate(read(f)).problems, [code]);
  }
});
test("unknown Decision authority or fake Decision expires_at fails actual closed schema", () => {
  for (const key of ["execution_authorized", "expires_at"]) {
    const f = fixture(); f.d[key] = key === "expires_at" ? EXPIRES : true; setDecision(f);
    const result = read(f); assert.equal(result.status, "unavailable");
    assert.deepEqual(result.reason_codes, ["ERR_ADVISOR_PAIR_SCHEMA"]); assert.equal(result.tasks.records[0].mission_ref, null);
  }
});
test("malformed pair filename cannot hide behind canonical record IDs", () => {
  const f = fixture(); f.files.set("decisions/D-B.json", json(f.d));
  assert.deepEqual(read(f).reason_codes, ["ERR_ADVISOR_PAIR_SCHEMA"]);
});
test("namespace symlink/gitlink/duplicate nodes fail closed before mapping", () => {
  for (const edit of [(entries) => { entries[0].mode = "120000"; },
    (entries) => { entries[0].type = "commit"; }, (entries) => { entries.push(clone(entries[0])); }]) {
    const result = read(fixture(), { entries(namespace, entries) { if (namespace === "missions") edit(entries); } });
    assert.equal(result.status, "unavailable"); assert.equal(result.tasks.records[0].mission_ref, null);
  }
});
test("namespace entry and plan count budgets fail closed", () => {
  const many = fixture();
  for (let i = 0; i < 513; i++) many.files.set("missions/notes/" + i + ".md", "");
  assert.deepEqual(read(many).reason_codes, ["ERR_ADVISOR_PLAN_NAMESPACE_LIMIT"]);
  const plans = fixture();
  for (let i = 0; i < 32; i++) { const p = clone(plans.plan); p.plan_id = "AP-" + i; const d = prepareAdvisoryPlan(json(p)); plans.files.set(d.path, d.content); }
  assert.deepEqual(read(plans).reason_codes, ["ERR_ADVISOR_PLAN_LIMIT"]);
});
test("oversized per-file and aggregate raw reads are bounded", () => {
  const a = fixture(); a.files.set(a.draft.path, a.draft.content + " ".repeat(1024 * 1024));
  assert.equal(read(a).status, "unavailable");
  const b = fixture();
  for (let i = 0; i < 6; i++) { const d = clone(b.d); d.decision_id = "D-" + i; d.prompt = "x".repeat(750000); b.files.set("decisions/" + d.decision_id + ".json", json(d)); }
  assert.equal(read(b).status, "unavailable");
});
test("mid-read revision change rejects all plan sources and never retains mapped scope", () => {
  const f = fixture(); let changed = false;
  const result = read(f, { read() { changed = true; }, revision() { return { store_kind: "git", value: (changed ? "c" : "a").repeat(40) }; } });
  assert.equal(result.status, "conflict"); assert.deepEqual(result.reason_codes, ["governance_snapshot_changed"]);
  assert.equal(result.tasks.records[0].mission_ref, null); assert.deepEqual(result.decisions.records, []);
});
test("missing namespace stays explicitly unobserved; Filesystem token cannot stand in for snapshot", () => {
  const f = fixture(); f.files.clear(); assert.equal(read(f).status, "not_observed");
  const store = storeFor(f); store.kind = "filesystem";
  const result = readCanonicalPlanSources({ store, project_ref: "project:alpha", governance_binding_ref: "binding:fixture",
    observed_at: NOW, expected_revision: REV, tasks: f.tasks });
  assert.equal(result.status, "unavailable"); assert.equal(result.execution_authorized, false);
});

test("full Task Git blob binding rejects changed bytes, missing receipt or duplicate receipt", () => {
  for (const edit of [(f) => { f.tasks.read_receipts[0].blob = gitBlob('{"task_id":"T-A","status":"blocked"}'); },
    (f) => { f.tasks.read_receipts = []; },
    (f) => { f.tasks.read_receipts[0].revision = { store_kind: "git", value: REV.value }; },
    (f) => { f.tasks.read_receipts.push(clone(f.tasks.read_receipts[0])); }]) {
    const f = fixture(); edit(f); const result = read(f);
    assert.equal(result.status, "conflict");
    assert.deepEqual(result.reason_codes, ["ERR_ADVISOR_TASK_VERSION_CONFLICT"]);
    assert.equal(result.tasks.records[0].mission_ref, null);
  }
});
test("plan cannot overwrite newer canonical Task validation commands with a weaker plan", () => {
  const f = fixture(); f.tasks.records[0].validation_plan.tests.push("node --test additional-required.test.js");
  const result = read(f); assert.equal(result.status, "conflict");
  assert.deepEqual(result.reason_codes, ["ERR_ADVISOR_TASK_VALIDATION_CONFLICT"]);
  assert.deepEqual(result.tasks.records[0].validation_plan.tests, ["node --test fixture-only.test.js", "node --test additional-required.test.js"]);
});
