"use strict";

// All source handles in this file are minted by this local TEST-ONLY WeakMap.
// These synthetic fixtures are not GitHub identity/Owner/approval evidence.
// The production entry must compose its fixed platform source and bound store.
// Fake-store cases test controller state logic; the final Linux case separately
// uses the real hardened local Git batch store. Neither proves remote CAS,
// server-side hard expiry, a real Owner appointment, Host execution, or L3 PASS.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createCanonicalControl } = require("../../lib/governance/canonical-control");
const R = require("../../lib/governance/canonical-records");
const schema = require("../../lib/governance/canonical-control.schema.json");
const { stable, digest, json, parse } = R;
const clone = value => JSON.parse(JSON.stringify(value));
const UUID = "11111111-1111-4111-8111-111111111111";
const TIME = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const SAME = value => JSON.stringify(value);
function relation() { return { task_ids: [], mission_ids: [], run_ids: [], queue_ids: [],
  session_ids: [], artifact_refs: [], worktree_paths: [] }; }
function revision(n) { return { store_kind: "git", value: n.toString(16).padStart(40, "0") }; }
function sourceFixture() {
  const handles = new WeakMap();
  return { issue(data) { const handle = Object.freeze({}); handles.set(handle, clone(data)); return handle; },
    resolve(handle) { assert.ok(handles.has(handle), "unknown synthetic handle"); return clone(handles.get(handle)); } };
}
function memoryStore(binding) {
  let generation = 0, records = new Map(), revisionValue = null;
  const handles = new WeakMap();
  const store = {
    binding: clone(binding), prepareCount: 0, publishCount: 0, nextOutcome: null, hook: null,
    current() { return { revision: clone(revisionValue), records: new Map(records) }; },
    edit(key, value) { records.set(key, typeof value === "string" ? value : json(value)); revisionValue = revision(++generation); },
    async readSnapshot(keys) {
      const result = Object.create(null);
      for (const k of keys) result[k] = records.has(k) ? { content: records.get(k), sha256: digest(records.get(k)).slice(7) } : null;
      return { revision: clone(revisionValue), records: result, effect_authority: false };
    },
    async prepareBatch(request) {
      store.prepareCount++;
      if (!eq(request.expected_revision, revisionValue)) { const e = new Error("REVISION_CONFLICT"); e.code = "REVISION_CONFLICT"; throw e; }
      const handle = Object.freeze({}), next = new Map(records);
      for (const item of request.writes) next.set(item.key, item.content);
      const candidate = revision(generation + 1);
      handles.set(handle, { base: clone(revisionValue), next, candidate, used: false });
      if (store.hook) { const hook = store.hook; store.hook = null; await hook(); }
      return { handle, evidence: { base_revision: clone(request.expected_revision), prepared_commit: candidate.value, prepared_tree: "e".repeat(40), writes_sha256: digest(JSON.stringify(request.writes)).slice(7) }, effect_authority: false };
    },
    async publishPrepared(handle) {
      store.publishCount++;
      const p = handles.get(handle); assert.ok(p && !p.used); p.used = true;
      if (!eq(p.base, revisionValue)) return { status: "CONFLICT", evidence: { observed_revision: clone(revisionValue) } };
      const outcome = store.nextOutcome; store.nextOutcome = null;
      if (outcome === "UNKNOWN_NO_COMMIT") return { status: "UNKNOWN", evidence: { publication: "UNKNOWN" } };
      records = p.next; revisionValue = revision(++generation);
      if (outcome === "THROW_AFTER_COMMIT") throw new Error("transport closed");
      if (outcome === "MALFORMED_AFTER_COMMIT") return { status: "unexpected-success" };
      if (outcome === "EMPTY_AFTER_COMMIT") return null;
      if (outcome === "WRONG_CANDIDATE_AFTER_COMMIT") return { status: "PUBLISHED", evidence: { published_revision: revision(999) } };
      if (outcome === "INVALID_REVISION_AFTER_COMMIT") return { status: "PUBLISHED", evidence: { published_revision: { store_kind: "git", value: "wrong" } } };
      if (outcome === "UNKNOWN_AFTER_COMMIT") return { status: "UNKNOWN", evidence: { publication: "UNKNOWN" } };
      return { status: "PUBLISHED", evidence: { published_revision: clone(revisionValue) } };
    }
  };
  return store;
}
function eq(a,b) { return stable(a) === stable(b); }
function fixture(options = {}) {
  const backend = { kind: "github-ref", repository_id: "700000003", repository: "synthetic/governance", authority_ref: "refs/heads/cortex-authority/" + UUID };
  const decision = { schema_version: 1, decision_id: "D-control", type: "architecture", status: "open",
    requested_by: "synthetic-requester", prompt: "Synthetic control validation only", options: ["approve","reject","request_revision"],
    selected_option: null, resolved_by: null, resolved_at: null, rationale: "",
    gate: { action: "architecture", resource_ref: "scope:control" }, relations: relation(), created_at: TIME, updated_at: TIME };
  const waitpoint = { schema_version: 1, waitpoint_id: "WP-control", status: "blocked", owner_workflow: "/mission",
    reason: "Synthetic control validation", gate: clone(decision.gate), decision_id: decision.decision_id,
    evidence_refs: [], release_note: null, released_by: null, released_at: null, expires_at: FUTURE,
    relations: relation(), created_at: TIME, updated_at: TIME };
  const scope = { schema_version: 1, kind: "canonical-control-scope", project_id: UUID,
    resource_ref: "scope:control", decision_id: "D-control", waitpoint_id: "WP-control", owner_workflow: "/mission",
    owner_generation: 1, task_ids: [], mission_ids: [], dependencies: [], valid_from: TIME, expires_at: FUTURE,
    execution_authorized: false };
  const initial = [
    ["decisions/D-control.json", decision], ["waitpoints/WP-control.json", waitpoint], ["scopes/control.json", scope],
    ["decisions/index.json", { decisions: [{ decision_id: "D-control", path: ".agent/decisions/D-control.json", type: "architecture",
      status: "open", gate_action: "architecture", resource_ref: "scope:control", updated_at: TIME }] }],
    ["waitpoints/index.json", { waitpoints: [{ waitpoint_id: "WP-control", path: ".agent/waitpoints/WP-control.json", status: "blocked",
      owner_workflow: "/mission", gate_action: "architecture", resource_ref: "scope:control", decision_id: "D-control", updated_at: TIME }] }]
  ];
  if (options.dependency) {
    const task = { task_id: "T-dependency", title: "Synthetic prerequisite", description: "No actual test execution asserted",
      status: options.dependency, stage: options.dependency === "completed" ? "done" : "validate", priority: "P2",
      acceptance_criteria: ["Synthetic state"], dependencies: [], subtasks: [], required_artifacts: [],
      artifacts: [{ kind: "validation", ref: "fixture:validation", status: "final" }, { kind: "review", ref: "fixture:review", status: "final" }],
      gates: [{ from_stage: "review", to_stage: "done", status: "passed", required_artifacts: [], evidence_refs: ["fixture:review"] }],
      created_at: TIME, updated_at: TIME };
    initial.push(["tasks/T-dependency.json", task]);
    scope.dependencies.push({ task_id: task.task_id, digest: digest(json(task)) });
  }
  const manifest = { schema_version: 1, kind: "github-control-bootstrap", project_id: UUID, owner_account_id: "700000001",
    product_repository: { id: "700000002", name: "synthetic/product", head_sha: "c".repeat(40) }, backend,
    controller: { workflow_path: ".github/workflows/control.yml", ref: "refs/heads/controller", source_bundle_digest: "sha256:"+"b".repeat(64) },
    project_root_binding: { kind: "isolated-root", reference: "synthetic:root", digest: "sha256:"+"a".repeat(64) },
    owner_workflow: "/mission", initial_records: initial.map(([key,v]) => ({ key, content: json(v), sha256: digest(json(v)) })),
    selections: [{ resource_ref: "scope:control", resource_key: "scopes/control.json", decision_id: "D-control",
      decision_key: "decisions/D-control.json", operation_id: "OP-control", operation: "review",
      allowed_actions: ["approve","reject","request_revision"] }],
    operations: ["bootstrap","resolve_decision","release_waitpoint","revoke_owner"], max_control_transactions: 8,
    valid_from: TIME, expires_at: FUTURE, bootstrap_expected_revision: null, max_initializations: 1 };
  const deployment = { repository_id: backend.repository_id, repository: backend.repository,
    workflow_path: manifest.controller.workflow_path, ref: manifest.controller.ref,
    workflow_sha: "a".repeat(40), source_bundle_digest: manifest.controller.source_bundle_digest };
  const platformSource = sourceFixture(), store = options.storeFactory ? options.storeFactory(backend) : memoryStore(backend);
  const controller = createCanonicalControl({ store, platformSource });
  const f = { manifest, deployment, platformSource, store, controller, run: 100 };
  f.context = () => ({ repository_id: backend.repository_id, repository: backend.repository,
    sender_id: manifest.owner_account_id, actor_id: manifest.owner_account_id, triggering_actor_id: manifest.owner_account_id,
    event_name: "workflow_dispatch", run_id: String(++f.run), run_attempt: 1 });
  f.issue = data => platformSource.issue(data);
  f.base = () => ({ manifest_digest: digest(stable(manifest)), deployment: clone(deployment), context: f.context() });
  f.bootstrapData = () => ({ kind: "github-bootstrap-source-v1", request: "bootstrap", ...f.base(),
    manifest: clone(manifest), action: "appoint_owner" });
  f.boot = () => controller.bootstrap(f.issue(f.bootstrapData()));
  f.get = async key => parse((await store.readSnapshot([key])).records[key].content);
  f.selectionData = async (action = "approve") => {
    const s = await store.readSnapshot(["scopes/control.json","decisions/D-control.json"]), t = manifest.selections[0];
    const frozen = { schema_version: 1, project_id: UUID, subject_id: manifest.owner_account_id,
      product_repository: clone(manifest.product_repository),
      governance_repository: { id: backend.repository_id, name: backend.repository, revision: s.revision.value },
      controller: { workflow_path: deployment.workflow_path, ref: deployment.ref,
        workflow_ref: backend.repository + "/" + deployment.workflow_path + "@" + deployment.ref,
        workflow_sha: deployment.workflow_sha, script_digest: deployment.source_bundle_digest },
      resource_ref: t.resource_ref, resource_digest: digest(s.records[t.resource_key].content),
      decision_id: t.decision_id, decision_digest: digest(s.records[t.decision_key].content),
      operation_id: t.operation_id, operation: t.operation, allowed_actions: clone(t.allowed_actions) };
    const selection = { project_id: UUID, resource_ref: frozen.resource_ref, resource_digest: frozen.resource_digest,
      frozen_digest: digest(stable(frozen)), operation_id: frozen.operation_id, action };
    const base = f.base();
    return { kind: "github-selection-source-v1", request: "resolve_decision", ...base, frozen, selection,
      context: { ...base.context, workflow_ref: frozen.controller.workflow_ref, workflow_sha: frozen.controller.workflow_sha,
        script_digest: frozen.controller.script_digest, ref: frozen.controller.ref, inputs: clone(selection) } };
  };
  f.resolve = async action => controller.resolveDecision(f.issue(await f.selectionData(action)));
  f.releaseData = async () => {
    const d = await f.get("decisions/D-control.json");
    const key = d.relations.artifact_refs.find(v => v.startsWith(".agent/control/audit/")).slice(7);
    const s = await store.readSnapshot([key,"scopes/control.json"]);
    return { kind: "github-waitpoint-release-source-v1", request: "release_waitpoint", ...f.base(), action: "release_waitpoint",
      project_id: UUID, resource_ref: "scope:control", resource_digest: digest(s.records["scopes/control.json"].content),
      operation_id: "OP-control", decision_audit_ref: key, decision_audit_digest: digest(s.records[key].content),
      expected_revision: s.revision.value };
  };
  f.release = async () => controller.releaseOwningWaitpoint(f.issue(await f.releaseData()));
  f.revokeData = async () => {
    const s = await store.readSnapshot(["control/owner.json"]);
    return { kind: "github-owner-revocation-source-v1", request: "revoke_owner", ...f.base(), action: "revoke_owner",
      project_id: UUID, operation_id: "revoke-owner:" + UUID, expected_revision: s.revision.value,
      expected_owner_generation: parse(s.records["control/owner.json"].content).generation };
  };
  f.revoke = async () => controller.revokeOwner(f.issue(await f.revokeData()));
  return f;
}
async function rejects(work, code) {
  await assert.rejects(work, error => !code || error.code === code, code);
}
test("bootstrap initializes canonical identity/Owner once, not a runtime writer", async () => {
  const f = fixture(), result = await f.boot();
  assert.equal(result.status,"PUBLISHED"); assert.equal(result.execution_authorized,false);
  const owner = await f.get("control/owner.json");
  assert.equal(owner.role,"project_approver"); assert.equal(owner.execution_authorized,false);
  assert.equal(owner.bootstrap.source_audit_ref,"control/bootstrap.json");
  const before = f.store.prepareCount;
  await rejects(() => f.boot(),"CONTROL_BOOTSTRAP_ALREADY_INITIALIZED");
  assert.equal(f.store.prepareCount,before);
});
test("resolve atomically changes only Decision/index, source/audit/journal and both replay markers", async () => {
  const f = fixture(); await f.boot();
  const before = f.store.current(), result = await f.resolve();
  assert.equal(result.status,"PUBLISHED"); assert.equal(result.effect_permitted,false);
  const after = f.store.current();
  const changed = [...after.records.keys()].filter(k => before.records.get(k)!==after.records.get(k));
  assert.equal(changed.filter(k => k.startsWith("control/replay/")).length,2);
  assert.equal(changed.filter(k => k.startsWith("control/audit/")).length,1);
  assert.equal(changed.filter(k => k.startsWith("control/sources/")).length,1);
  assert.ok(changed.includes("decisions/D-control.json") && changed.includes("decisions/index.json") && changed.includes("control/journal.json"));
  assert.equal(changed.length,7);
  assert.equal(await f.get("waitpoints/WP-control.json").then(v=>v.status),"blocked");
  const d = await f.get("decisions/D-control.json"); assert.equal(d.status,"approved");
  assert.equal(d.relations.artifact_refs.length,1);
});
test("release is a separate authenticated request, fresh revision and owning workflow transaction", async () => {
  const f=fixture(); await f.boot();
  const selection=await f.selectionData(); await f.controller.resolveDecision(f.issue(selection));
  await rejects(() => f.controller.releaseOwningWaitpoint(f.issue(selection)),"CONTROL_SOURCE_KIND");
  const before=f.store.current(), result=await f.release(); assert.equal(result.status,"PUBLISHED");
  assert.equal(result.execution_authorized,false);
  const after=f.store.current(), changed=[...after.records.keys()].filter(k=>before.records.get(k)!==after.records.get(k));
  assert.equal(changed.includes("decisions/D-control.json"),false);
  assert.equal(changed.filter(k=>k.startsWith("control/replay/")).length,2);
  const w=await f.get("waitpoints/WP-control.json");
  assert.equal(w.status,"released"); assert.equal(w.released_by,"workflow:/mission");
  await rejects(() => f.release(),"CONTROL_REPLAY_OR_EXISTING_RECORD");
});
test("reject and request_revision leave Waitpoint blocked", async () => {
  for(const action of ["reject","request_revision"]) {
    const f=fixture();await f.boot();await f.resolve(action);
    assert.equal((await f.get("waitpoints/WP-control.json")).status,"blocked");
    await rejects(()=>f.release(),"CONTROL_DECISION_PROVENANCE");
  }
});
test("caller JSON and unknown source handles cannot enter canonical controller", async () => {
  const f=fixture();
  await rejects(()=>f.controller.bootstrap(f.bootstrapData()));
  assert.equal(f.store.prepareCount,0);
  assert.throws(()=>createCanonicalControl({store:f.store}),{code:"CONTROL_SOURCE_REQUIRED"});
});
test("preexisting ref, resolved initial Decision, extra fields and unknown seed paths reject before prepare", async () => {
  for(const mutate of [
    f=>{f.store.edit("control/unrelated.json",{});},
    f=>{const row=f.manifest.initial_records[0],d=parse(row.content);d.status="approved";d.selected_option="approve";
      d.resolved_by="forged";d.resolved_at=TIME;row.content=json(d);row.sha256=digest(row.content);},
    f=>{const row=f.manifest.initial_records[0],d=parse(row.content);d.actor_id="700000001";row.content=json(d);row.sha256=digest(row.content);},
    f=>{f.manifest.initial_records.push({key:"leases/forged.json",content:"{}",sha256:digest("{}")});}
  ]) {const f=fixture();mutate(f);await rejects(()=>f.boot());assert.equal(f.store.prepareCount,0);}
});
test("shared closed manifest rejects unknown fields, crossed bindings and invalid operation bounds", async () => {
  const mutations = [
    m => { m.unreviewed = true; },
    m => { m.backend.unreviewed = true; },
    m => { m.controller.unreviewed = true; },
    m => { m.project_root_binding.unreviewed = true; },
    m => { m.product_repository.unreviewed = true; },
    m => { m.selections[0].unreviewed = true; },
    m => { m.initial_records[0].unreviewed = true; },
    m => { m.backend.authority_ref = "refs/heads/cortex-authority/22222222-2222-4222-8222-222222222222"; },
    m => { m.backend.authority_ref = "refs/heads/controller"; },
    m => { m.controller.ref = m.backend.authority_ref; },
    m => { m.product_repository.id = m.backend.repository_id; },
    m => { m.product_repository.head_sha = "0".repeat(40); },
    m => { m.selections[0].decision_key = "decisions/D-other.json"; },
    m => { m.selections[0].resource_key = "scopes/other.json"; },
    m => { m.selections[0].resource_ref = "scope:other"; },
    m => { m.selections[0].operation = "host"; },
    m => { m.selections[0].allowed_actions.push("approve"); },
    m => { m.selections.push(clone(m.selections[0])); },
    m => { m.max_control_transactions = 9; },
    m => { m.max_control_transactions = 1; },
    m => { m.operations.push("runtime"); },
    m => { m.valid_from = m.expires_at; },
    m => { m.project_root_binding.reference = "bad\nroot"; },
    m => { m.initial_records[0].sha256 = "sha256:" + "0".repeat(64); }
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f.manifest);
    assert.throws(() => R.validateManifest(f.manifest));
    await rejects(() => f.boot()); assert.equal(f.store.prepareCount, 0);
  }
  const f = fixture(); const m = R.validateManifest(f.manifest);
  assert.equal(m.backend.authority_ref, "refs/heads/cortex-authority/" + UUID);
  await f.boot();
  const changed = clone(f.manifest); changed.unreviewed = true;
  f.store.edit("control/manifest.json", changed);
  await rejects(() => f.resolve(), "CONTROL_SCHEMA");
});

test("owner absent/revoked, deployment mismatch and manifest mismatch reject before write", async () => {
  for(const mutate of [
    async f=>{const o=await f.get("control/owner.json");o.status="revoked";f.store.edit("control/owner.json",o);},
    async f=>{f.store.edit("control/owner.json","null");},
    async f=>{f.deployment.workflow_sha="f".repeat(40);},
    async f=>{f.manifest.owner_account_id="800000001";}
  ]) {const f=fixture();await f.boot();await mutate(f);const before=f.store.prepareCount;await rejects(()=>f.resolve());assert.equal(f.store.prepareCount,before);}
});
test("duplicate JSON keys and unsupported schema keywords fail closed", () => {
  for(const raw of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"a":1,}','{"a":1e999}']) assert.throws(()=>parse(raw));
  assert.throws(()=>R.validate({type:"string",not:{}},"a"),{code:"CONTROL_UNSUPPORTED_SCHEMA"});
  assert.throws(()=>R.validate(schema.$defs.owner,{schema_version:1}));
});
test("changed resource or Decision and stale revision cannot replay a selection", async () => {
  for(const key of ["scopes/control.json","decisions/D-control.json"]) {
    const f=fixture();await f.boot();const data=await f.selectionData();
    const v=await f.get(key);v.updated_at=TIME;f.store.edit(key,v);
    const before=f.store.prepareCount;
    await rejects(()=>f.controller.resolveDecision(f.issue(data)));assert.equal(f.store.prepareCount,before);
  }
  const f=fixture();await f.boot();const data=await f.selectionData();await f.controller.resolveDecision(f.issue(data));
  const before=f.store.prepareCount;await rejects(()=>f.controller.resolveDecision(f.issue(data)));
  assert.equal(f.store.prepareCount,before);
});
test("repository-run replay key cannot authorize another selection",async()=>{
  const f=fixture();await f.boot();const data=await f.selectionData();await f.controller.resolveDecision(f.issue(data));
  const changed=clone(data);changed.selection.action="reject";changed.context.inputs=clone(changed.selection);
  await rejects(()=>f.controller.resolveDecision(f.issue(changed)));
});
test("two contenders from one revision never split Decision/audit/replay", async () => {
  const f=fixture();await f.boot();
  const a=await f.selectionData(),b=clone(a);b.context.run_id="999";b.selection.action="reject";b.context.inputs=clone(b.selection);
  const results=await Promise.allSettled([f.controller.resolveDecision(f.issue(a)),f.controller.resolveDecision(f.issue(b))]);
  assert.equal(results.filter(r=>r.status==="fulfilled"&&r.value.status==="PUBLISHED").length,1);
  const d=await f.get("decisions/D-control.json");assert.ok(["approved","rejected"].includes(d.status));
  const current=f.store.current();
  assert.equal([...current.records.keys()].filter(k=>k.startsWith("control/audit/")).length,2);
  assert.equal([...current.records.keys()].filter(k=>k.startsWith("control/replay/")).length,4);
});
test("dependency state is re-read and unaccepted or changed digest blocks release",async()=>{
  const blocked=fixture({dependency:"active"});await blocked.boot();await blocked.resolve();
  await rejects(()=>blocked.release(),"CONTROL_DEPENDENCY_UNACCEPTED");
  const good=fixture({dependency:"completed"});await good.boot();await good.resolve();assert.equal((await good.release()).status,"PUBLISHED");
  const noncanonical=fixture({dependency:"completed"});
  const taskRow=noncanonical.manifest.initial_records.find(r=>r.key==="tasks/T-dependency.json");
  taskRow.content=JSON.stringify(parse(taskRow.content),null,2)+"\n";taskRow.sha256=digest(taskRow.content);
  const scopeRow=noncanonical.manifest.initial_records.find(r=>r.key==="scopes/control.json"),scope=parse(scopeRow.content);
  scope.dependencies[0].digest=taskRow.sha256;scopeRow.content=json(scope);scopeRow.sha256=digest(scopeRow.content);
  await noncanonical.boot();await noncanonical.resolve();assert.equal((await noncanonical.release()).status,"PUBLISHED");
  const changed=fixture({dependency:"completed"});await changed.boot();await changed.resolve();
  const t=await changed.get("tasks/T-dependency.json");t.status="canceled";changed.store.edit("tasks/T-dependency.json",t);
  await rejects(()=>changed.release(),"CONTROL_DEPENDENCY_UNACCEPTED");
});
test("owning workflow, independent audit and expiry are checked on release",async()=>{
  for(const mutate of [
    async f=>{const w=await f.get("waitpoints/WP-control.json");w.owner_workflow="/other";f.store.edit("waitpoints/WP-control.json",w);},
    async f=>{const w=await f.get("waitpoints/WP-control.json");w.expires_at="2000-01-01T00:00:00.000Z";f.store.edit("waitpoints/WP-control.json",w);},
    async f=>{const d=await f.get("decisions/D-control.json");d.relations.artifact_refs=[];f.store.edit("decisions/D-control.json",d);}
  ]) {const f=fixture();await f.boot();await f.resolve();await mutate(f);const before=f.store.prepareCount;await rejects(()=>f.release());assert.equal(f.store.prepareCount,before);}
});
test("journal/source tampering and an invented owner generation reject",async()=>{
  for(const mutate of [
    async f=>{const j=await f.get("control/journal.json");j.audit_digest="sha256:"+"0".repeat(64);f.store.edit("control/journal.json",j);},
    async f=>{const o=await f.get("control/owner.json");o.generation=2;const r=await f.get("control/project.json");r.owner_digest=digest(json(o));
      f.store.edit("control/owner.json",o);f.store.edit("control/project.json",r);},
    async f=>{const b=await f.get("control/bootstrap.json");b.context.actor_id="800000001";f.store.edit("control/bootstrap.json",b);}
  ]) {const f=fixture();await f.boot();await mutate(f);const before=f.store.prepareCount;await rejects(()=>f.resolve());assert.equal(f.store.prepareCount,before);}
});
test("UNKNOWN after or before commit quarantines controller and never retries publication",async()=>{
  for(const outcome of ["UNKNOWN_NO_COMMIT","UNKNOWN_AFTER_COMMIT","THROW_AFTER_COMMIT","MALFORMED_AFTER_COMMIT","EMPTY_AFTER_COMMIT","INVALID_REVISION_AFTER_COMMIT","WRONG_CANDIDATE_AFTER_COMMIT"]) {
    const f=fixture();await f.boot();f.store.nextOutcome=outcome;let reconciliations=0;
    f.store.reconcilePrepared=async()=>{reconciliations++;throw new Error("synthetic readback unavailable");};
    const result=await f.resolve();assert.equal(result.status,"UNKNOWN");assert.equal(result.canonical_mutation,null);
    assert.equal(reconciliations,1);assert.equal(result.evidence.receipt.publication,"UNKNOWN");
    assert.equal(result.evidence.receipt.repository_id,f.manifest.backend.repository_id);
    assert.equal(typeof result.evidence.receipt.prepared_commit,"string");
    assert.equal(Object.hasOwn(result.evidence.receipt,"content"),false);
    const count=f.store.publishCount;await rejects(()=>f.resolve(),"CONTROL_QUARANTINED");assert.equal(f.store.publishCount,count);
  }
  const f=fixture();await f.boot();f.store.nextOutcome="UNKNOWN_AFTER_COMMIT";let reconciliations=0;
  f.store.reconcilePrepared=async()=>{
    reconciliations++;return {status:"PUBLISHED",evidence:{published_revision:f.store.current().revision}};
  };
  const result=await f.resolve();assert.equal(result.status,"PUBLISHED");assert.equal(result.evidence.receipt.reconciled,true);
  assert.equal(reconciliations,1);const count=f.store.publishCount;
  await rejects(()=>f.resolve(),"CONTROL_QUARANTINED");assert.equal(f.store.publishCount,count);
});
test("revoke atomically advances Owner generation and blocks later release/resolve",async()=>{
  const f=fixture();await f.boot();await f.resolve();
  const release=await f.releaseData(), result=await f.revoke();assert.equal(result.status,"PUBLISHED");
  const owner=await f.get("control/owner.json");assert.equal(owner.status,"revoked");assert.equal(owner.generation,2);
  assert.equal((await f.get("control/project.json")).owner_digest,digest(json(owner)));
  assert.equal(result.execution_authorized,false);
  await rejects(()=>f.controller.releaseOwningWaitpoint(f.issue(release)));
  await rejects(()=>f.resolve(),"OWNER_UNVERIFIED");
});
test("revoke wins a publication race and old release candidate conflicts atomically",async()=>{
  const f=fixture();await f.boot();await f.resolve();
  const release=await f.releaseData(), revoke=f.issue(await f.revokeData());
  const other=createCanonicalControl({store:f.store,platformSource:f.platformSource});
  f.store.hook=async()=>{assert.equal((await other.revokeOwner(revoke)).status,"PUBLISHED");};
  const result=await f.controller.releaseOwningWaitpoint(f.issue(release));assert.equal(result.status,"CONFLICT");
  assert.equal((await f.get("waitpoints/WP-control.json")).status,"blocked");
  assert.equal((await f.get("control/owner.json")).status,"revoked");
});
test("control budget reserves its last transaction for revoke",async()=>{
  const f=fixture();f.manifest.max_control_transactions=3;await f.boot();await f.resolve();
  await rejects(()=>f.release(),"CONTROL_REVOCATION_SLOT_RESERVED");
  assert.equal((await f.revoke()).status,"PUBLISHED");
});
test("legacy records are not migrated or promoted into an Owner",async()=>{
  const f=fixture();f.store.edit("decisions/D-control.json",parse(f.manifest.initial_records[0].content));
  const before=f.store.current();await rejects(()=>f.resolve());
  assert.equal(SAME([...f.store.current().records]),SAME([...before.records]));
  assert.equal(f.store.prepareCount,0);
});
test("real Linux local Git batch runs bootstrap, resolve, release, revoke with the same controller", {skip:process.platform!=="linux"},async(t)=>{
  const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");
  const {createGitTransactionStore,GIT_TRANSACTION_REF}=require("../../lib/governance/git-transaction-store");
  const git=fs.realpathSync("/usr/bin/git"),base=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"cortex-control-"));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const repo=path.join(base,"repo.git"),template=path.join(base,"empty-template");fs.mkdirSync(template);
  const originalSpawn=cp.spawnSync;
  const allowed=new Set(["init","cat-file","ls-tree","hash-object","mktree","commit-tree","update-ref","merge-base"]);
  const spawn=t.mock.method(cp,"spawnSync",(executable,args,options)=>{
    assert.equal(executable,git);assert.equal(options.shell,false);
    assert.ok(options.cwd===base||options.cwd===repo);
    assert.equal(args.filter(arg=>allowed.has(arg)).length,1);
    assert.equal(args.some(arg=>["fetch","push","clone","pull","remote","submodule"].includes(arg)),false);
    return originalSpawn(executable,args,{...options,env:{...options.env,GIT_ALLOW_PROTOCOL:"file",GIT_PROTOCOL_FROM_USER:"0"}});
  });
  t.after(()=>spawn.mock.restore());
  const env={PATH:"/usr/bin:/bin",HOME:base,XDG_CONFIG_HOME:base,LANG:"C",LC_ALL:"C",TZ:"UTC",
    GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_REPLACE_OBJECTS:"1"};
  const initialized=cp.spawnSync(git,["-c","core.hooksPath=/dev/null","init","--bare","--object-format=sha1","--initial-branch=unused","--template="+template,repo],
    {cwd:base,env,shell:false,encoding:"utf8",timeout:2000,maxBuffer:1048576});
  assert.equal(initialized.status,0,initialized.stderr);
  const primitive=createGitTransactionStore({repo,ref:GIT_TRANSACTION_REF,gitExecutable:git});
  const f=fixture({storeFactory:binding=>Object.freeze({binding,...primitive})});
  const revisions=[];
  for(const action of [()=>f.boot(),()=>f.resolve(),()=>f.release(),()=>f.revoke()]) {
    const r=await action();assert.equal(r.status,"PUBLISHED");assert.equal(r.execution_authorized,false);revisions.push(r.evidence.published_revision.value);
  }
  assert.equal(new Set(revisions).size,4);
  assert.equal((await f.get("control/owner.json")).status,"revoked");
  assert.equal((await f.get("waitpoints/WP-control.json")).status,"released");
});
