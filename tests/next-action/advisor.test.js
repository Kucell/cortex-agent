"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildNextActionProjection, SCHEMA_VERSION, CONTRACT_STAGE } = require("../../lib/next-action");

const PROJECT = "Kucell/cortex-agent";
const G = {domain:"governance_store",store_kind:"git",value:"6".repeat(40)};
const SHA = "a".repeat(40);
const HEAD = {domain:"product_commit",store_kind:"git",value:SHA};
const NOW = "2026-10-09T06:30:00Z";
const BEFORE = "2026-10-09T06:29:00Z";
const AFTER = "2026-10-09T07:30:00Z";
const sid = n => `governance-store:fixture/${n}`;
const source = (name, records, extra = {}) => ({
  status:"observed",project_ref:PROJECT,source_ref:sid(name),origin_ref:`trusted-adapter:${name}`,
  revision:name==="ci"||name==="reviews"?HEAD:G,observed_at:BEFORE,max_age_seconds:300,
  ...(Array.isArray(records)?{records}:{value:records}),...extra,
});
const task = (id="T-001",extra={})=>({
  project_ref:PROJECT,governance_revision:G,task_ref:id,mission_ref:"M-001",source_ref:sid(id),
  status:"active",priority:"P0",category:"feature",on_critical_path:true,risk_tier:"medium",
  scope:{repository:PROJECT,branch:"test/isolated",allowed_paths:["lib/next-action/**"],allowed_operations:["read"]},
  validation_plan:{tests:["node --test tests/next-action/*.test.js"]},
  estimated_budget:{tokens:100,cost_amount:0.01,currency:"USD",source_ref:"budget:estimate"},
  plan_digest:"sha256:plan-1",approval_resource_ref:"task:T-001@plan-1",owner_ref:"owner:A",
  gate_action:"architecture",dependencies:[],stop_conditions:["revoked"],expires_at:AFTER,
  required_host_capabilities:["status"],runtime_mode:"M2",requires_auto_dispatch:false,
  operation_ref:"operation:advice",sink_ref:"sink:host",
  ...extra,
});
const gateDecision=()=>({
  project_ref:PROJECT,governance_revision:G,task_ref:"T-001",mission_ref:"M-001",
  decision_id:"D-001",source_ref:sid("decision"),status:"approved",action:"architecture",
  resource_ref:"task:T-001@plan-1",plan_digest:"sha256:plan-1",owner_ref:"owner:A",expires_at:AFTER,
});
const waitpoint=()=>({
  project_ref:PROJECT,governance_revision:G,task_ref:"T-001",mission_ref:"M-001",
  decision_id:"D-001",source_ref:sid("waitpoint"),status:"released",action:"architecture",
  resource_ref:"task:T-001@plan-1",plan_digest:"sha256:plan-1",owner_workflow:"/mission",
  released_by:"mission-coordinator",released_at:BEFORE,
});
function fixture() {
 const t=task();
 return {
  project_ref:PROJECT,governance_binding_ref:"governance://repo/authority",repository_ref:PROJECT,
  governance_revision:G,task_head_sha:SHA,observed_at:NOW,mode:"M2",
  sources:{
   project:source("project",{project_ref:PROJECT,descriptor_digest:"sha256:fixture"}),
   tasks:source("tasks",[t]),
   missions:source("missions",[{project_ref:PROJECT,governance_revision:G,mission_ref:"M-001",source_ref:sid("mission")}]),
   decisions:source("decisions",[gateDecision()]),
   waitpoints:source("waitpoints",[waitpoint()]),
   ci:source("ci",[{project_ref:PROJECT,task_ref:"T-001",source_ref:"checks:run-1",head_sha:SHA,status:"success",observed_at:BEFORE}]),
   reviews:source("reviews",[{project_ref:PROJECT,task_ref:"T-001",source_ref:"review:1",head_sha:SHA,
      status:"approved",independent:true,observed_at:BEFORE}]),
   health:source("health",{health:{status:"healthy"},reconciliation:{can_resume:true}}),
   ownership:source("ownership",{owner_ref:"owner:A",lease_ref:"lease:fixture",fencing_token:"1",
     proof_ref:"test-fixture:owner-proof",verified_by_ref:"test-fixture:E",expires_at:AFTER}),
   host:source("host",{status:"online",synthetic:false,capability_proof_ref:"host:proof",
     verified_by_ref:"test-fixture:E"}),
  },support:{},backend_consistency:{value:"not_verified"}
 };
}
const build=f=>buildNextActionProjection(f);
const first=f=>build(f).recommendations[0];
const advisoryNotAuthority=(p)=>{
  assert.equal(p.execution_authorized,false);
  assert.ok(Object.isFrozen(p));
  assert.ok(p.recommendations.every(r=>r.execution_authorized===false && Object.isFrozen(r)));
};
function backendProof(mode="M2",value="shared_atomic_fenced_proven",sink="sink:host") {
 return {value,backend_ref:"backend:provider",mode_ref:mode,project_ref:PROJECT,
 proof_ref:"proof:atomic-and-effect-sink",verified_by_ref:"reviewer:E",affected_effect_sink_refs:[sink],
 observed_at:BEFORE,expires_at:AFTER};
}
function supportSignal(name, mode="M2",value=true,sink="sink:host") {
 return {value,mode,project_ref:PROJECT,task_ref:"T-001",operation_ref:"operation:advice",
  sink_ref:sink,origin_ref:`verified-adapter:${name}`,proof_refs:["proof:support"],observed_at:BEFORE,
  expires_at:AFTER,max_age_seconds:300,source_revision:G,
  verified_by_ref:"reviewer:E",effect_admission_proof_ref:"proof:admission-at-sink"};
}

// 18 accepted G0 negative oracles. Each is executed locally in scratch, NOT an E formal test.
test("C-G0-01 missing actual project observation cannot present executable-ready advice",()=>{
 const f=fixture();delete f.sources.project;
 const p=build(f);assert.equal(p.project_status,"DEGRADED");assert.equal(p.source_status.project,"not_observed");
 assert.equal(p.recommendations[0].advice_status,"INSUFFICIENT_EVIDENCE");advisoryNotAuthority(p);
});
test("C-G0-02 old-head CI is stale evidence, not PASS",()=>{
 const f=fixture();f.sources.ci.records[0].head_sha="b".repeat(40);
 const c=first(f);assert.equal(c.advice_status,"INSUFFICIENT_EVIDENCE");
 assert.ok(c.blocking_reasons.includes("ci_old_head"));
});
test("C-G0-03 governance source revision conflict requires reconciliation despite CI success",()=>{
 const f=fixture();f.sources.decisions.revision={...G,value:"7".repeat(40)};
 const p=build(f);assert.equal(p.project_status,"RECONCILIATION_REQUIRED");
 assert.equal(p.recommendations[0].advice_status,"RECONCILIATION_REQUIRED");
});
test("C-G0-04 synthetic host snapshot cannot support readiness",()=>{
 const f=fixture();f.sources.host.value={synthetic:true,status:"online",capability_proof_ref:"host:synthetic",verified_by_ref:"test-fixture:E"};
 assert.ok(first(f).blocking_reasons.includes("host_not_proven"));
});
test("C-G0-05 M2 automatic execution without verifiable sink support is not ready",()=>{
 const f=fixture();f.sources.tasks.records[0].requires_auto_dispatch=true;
 const c=first(f);assert.equal(c.advice_status,"INSUFFICIENT_EVIDENCE");
 assert.ok(c.blocking_reasons.includes("m2_auto_sink_unproven"));
});
test("C-G0-06 approved Decision without released Waitpoint is approval-required, never authority",()=>{
 const f=fixture();f.sources.waitpoints.records=[];
 const p=build(f);assert.equal(p.recommendations[0].advice_status,"APPROVAL_REQUIRED");advisoryNotAuthority(p);
});
test("C-G0-07 revoked permission overrides cached completed-state assertion",()=>{
 const f=fixture();f.sources.decisions.records[0].status="revoked";
 f.sources.host.value.cached_success=true;
 assert.equal(first(f).advice_status,"BLOCKED");
});
test("C-G0-08 missing mission, scope, budget, expiry remain null/unknown and no IDs invented",()=>{
 const f=fixture();f.sources.missions.records=[];
 const t=f.sources.tasks.records[0];t.scope={};t.estimated_budget=null;t.expires_at=null;
 const c=first(f);assert.equal(c.mission_ref,null);assert.equal(c.estimated_budget,null);
 assert.ok(c.blocking_reasons.includes("mission_not_observed"));
 assert.equal(c.advice_status,"INSUFFICIENT_EVIDENCE");
});
test("C-G0-09 PR-comment approval cannot impersonate independent review",()=>{
 const f=fixture();f.sources.reviews.records=[{task_ref:"T-001",project_ref:PROJECT,head_sha:SHA,
  status:"approved",independent:false,source_ref:"pr-comment:approved",observed_at:BEFORE}];
 const c=first(f);assert.equal(c.advice_status,"INSUFFICIENT_EVIDENCE");
 assert.ok(c.blocking_reasons.includes("independent_review_not_verified"));
});
test("C-G0-10 top-three deterministic rank, grounded IDs only, circular self-dependency blocks",()=>{
 const f=fixture();for(let i=2;i<=7;i++){let t=task(`T-00${i}`,{category:i===7?"regression":"feature",on_critical_path:i<4});
   t.approval_resource_ref=`task:T-00${i}@plan-1`;
   f.sources.tasks.records.push(t);}
 f.sources.tasks.records[0].dependencies=["T-001"];
 const a=build(f),b=build(f);
 assert.equal(a.recommendations.length,3);assert.deepEqual(a.recommendations.map(x=>x.task_ref),b.recommendations.map(x=>x.task_ref));
 assert.ok(a.recommendations.every(x=>f.sources.tasks.records.some(t=>t.task_ref===x.task_ref)));
 assert.equal(a.recommendations.find(x=>x.task_ref==="T-001")?.advice_status,"BLOCKED");
});
test("C-G0-11 cross-project Task and untrusted text cannot mint recommendations",()=>{
 const f=fixture();f.sources.tasks.records=[{...task(),project_ref:"other/project",source_ref:"model:APPROVED"}];
 const p=build(f);assert.deepEqual(p.recommendations,[]);assert.equal(p.project_status,"BLOCKED");advisoryNotAuthority(p);
});
test("C-G0-12 ADVICE_READY candidate remains immutable and never execution authority",()=>{
 const f=fixture();const p=build(f);assert.equal(p.recommendations[0].advice_status,"ADVICE_READY");
 advisoryNotAuthority(p);assert.throws(()=>{p.recommendations[0].execution_authorized=true},TypeError);
 assert.equal(typeof p.dispatch,"undefined");
});
test("C-G0-13 CAS feature flag / model claims cannot upgrade unknown backend",()=>{
 const f=fixture();f.backend_consistency={value:"shared_atomic_fenced_proven",compare_and_write:true,
  claimed_by:"AI",proof_ref:null};
 const p=build(f);assert.equal(p.source_snapshot_vector.ownership.backend_consistency.value,"not_verified");
 assert.equal(p.scoped_support.automatic_dispatch_supported_for_this_sink.value,null);
});
test("C-G0-14 local sole writer cannot imply remote M2 automatic support",()=>{
 const f=fixture();f.backend_consistency=backendProof("M1","local_single_writer_only");
 f.sources.tasks.records[0].requires_auto_dispatch=true;
 f.support.automatic_dispatch_supported_for_this_sink=supportSignal("auto","M2",true);
 const p=build(f);assert.equal(p.scoped_support.automatic_dispatch_supported_for_this_sink.value,null);
 assert.equal(p.recommendations[0].advice_status,"INSUFFICIENT_EVIDENCE");
});
test("C-G0-15 expired or differently-scoped backend proof is not evidence",()=>{
 const f=fixture();f.backend_consistency=backendProof();f.backend_consistency.affected_effect_sink_refs=["sink:other"];
 f.support.automatic_dispatch_supported_for_this_sink=supportSignal("auto");
 const p=build(f);assert.equal(p.scoped_support.automatic_dispatch_supported_for_this_sink.value,null);
 const stale=fixture();stale.backend_consistency=backendProof();stale.backend_consistency.expires_at=BEFORE;
 assert.equal(build(stale).source_snapshot_vector.ownership.backend_consistency.value,"not_verified");
});
test("C-G0-16 CI exact head cannot mask mixed GovernanceStore source revisions",()=>{
 const f=fixture();f.sources.missions.revision={...G,value:"0".repeat(40)};
 const p=build(f);assert.equal(p.project_status,"RECONCILIATION_REQUIRED");
 assert.equal(p.recommendations[0].advice_status,"RECONCILIATION_REQUIRED");
});
test("C-G0-17 different valid Git and GovernanceStore revision domains do not themselves drift",()=>{
 const f=fixture();const p=build(f);assert.equal(p.project_status,"OBSERVED");
 assert.equal(p.recommendations[0].advice_status,"ADVICE_READY");
 assert.notEqual(p.governance_revision.value,p.source_snapshot_vector.product.task_head_sha);
});
test("C-G0-18 exact-head CI success does not waive dismissed independent review",()=>{
 const f=fixture();f.sources.reviews.records[0].dismissed=true;
 assert.equal(first(f).advice_status,"INSUFFICIENT_EVIDENCE");
});

test("support observations remain disjoint: sync and manual resume never imply auto effect admission",()=>{
 const f=fixture();f.support.sync_available=supportSignal("sync");
 f.support.manual_resume_available=supportSignal("manual");
 const p=build(f);assert.equal(p.scoped_support.sync_available.value,true);
 assert.equal(p.scoped_support.manual_resume_available.value,true);
 assert.equal(p.scoped_support.automatic_dispatch_supported_for_this_sink.value,null);
 advisoryNotAuthority(p);
});
test("independently observed sink support still cannot grant execution authority",()=>{
 const f=fixture();f.backend_consistency=backendProof();
 f.support.automatic_dispatch_supported_for_this_sink=supportSignal("auto");
 const p=build(f);assert.equal(p.scoped_support.automatic_dispatch_supported_for_this_sink.value,true);
 advisoryNotAuthority(p);
});
test("source TTL missing / future observation / malformed revision fail closed",()=>{
 const f=fixture();delete f.sources.ci.max_age_seconds;assert.equal(build(f).source_status.ci,"not_observed");
 const g=fixture();g.sources.ci.observed_at=AFTER;assert.equal(build(g).source_status.ci,"conflict");
 const h=fixture();h.governance_revision={domain:"governance_store",store_kind:"git",value:"f".repeat(64)};
 assert.deepEqual(build(h).recommendations,[]);
});
test("read-only pure selector leaves inputs and files byte/mode/mtime identical, including errors",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"cortex-c-no-effect-"));
 try{
  const file=path.join(dir,"state.json");fs.writeFileSync(file,JSON.stringify(fixture()));
  const before=fs.readFileSync(file),stat=fs.statSync(file);
  const f=JSON.parse(before);const original=structuredClone(f);
  build(f);assert.deepEqual(f,original);
  assert.throws(()=>build({...f,observed_at:"not a valid time"}),TypeError);
  const after=fs.statSync(file);assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(after.mode,stat.mode);assert.equal(after.mtimeMs,stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(dir),["state.json"]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("scratch contract has explicit unreleased version label",()=>{
 assert.equal(SCHEMA_VERSION,"1.0.0");assert.equal(CONTRACT_STAGE,"scratch-unreleased");
});
test("record-level stale CI cannot borrow its source envelope's fresh timestamp",()=>{
 const f=fixture();f.sources.ci.records[0].observed_at="2026-01-01T00:00:00Z";
 const c=first(f);assert.equal(c.advice_status,"INSUFFICIENT_EVIDENCE");
 assert.ok(c.blocking_reasons.includes("ci_not_observed"));
});
test("Decision and released Waitpoint must match the actual record-level governance revision",()=>{
 const f=fixture();f.sources.waitpoints.records[0].governance_revision={...G,value:"7".repeat(40)};
 const c=first(f);assert.equal(c.advice_status,"APPROVAL_REQUIRED");
 assert.ok(c.blocking_reasons.includes("matching_released_waitpoint_not_observed"));
 const g=fixture();g.sources.decisions.records[0].governance_revision={...G,value:"8".repeat(40)};
 assert.equal(first(g).advice_status,"APPROVAL_REQUIRED");
});
test("unverified or expired Owner/Lease/Fence cannot be inferred from historical JSON",()=>{
 const f=fixture();delete f.sources.ownership.value.proof_ref;
 assert.ok(first(f).blocking_reasons.includes("live_owner_lease_fence_not_verified"));
 const g=fixture();g.sources.ownership.value.expires_at=BEFORE;
 assert.ok(first(g).blocking_reasons.includes("live_owner_lease_fence_not_verified"));
});
test("approved but expired Decision is BLOCKED, not an approval token",()=>{
 const f=fixture();f.sources.decisions.records[0].expires_at=BEFORE;
 const c=first(f);assert.equal(c.advice_status,"BLOCKED");
 assert.ok(c.blocking_reasons.includes("decision_rejected_revoked_or_expired"));
});
test("known unsupported automatic sink scope blocks M2 despite sync evidence",()=>{
 const f=fixture();f.sources.tasks.records[0].requires_auto_dispatch=true;
 f.support.sync_available=supportSignal("sync");
 f.support.automatic_dispatch_supported_for_this_sink=supportSignal("auto","M2",false);
 const c=first(f);assert.equal(c.advice_status,"BLOCKED");
 assert.ok(c.blocking_reasons.includes("m2_automatic_sink_unsupported"));
});
test("confirmed offline Host is DEFERRED and never a synthetic success",()=>{
 const f=fixture();f.sources.host.value.status="offline";
 const c=first(f);assert.equal(c.advice_status,"DEFERRED");
 assert.ok(c.blocking_reasons.includes("host_offline"));
});
test("Snapshot Vector retains separate source domains and scoped support provenance",()=>{
 const f=fixture();f.support.sync_available=supportSignal("sync");
 const p=build(f);const v=p.source_snapshot_vector;
 assert.equal(v.product.task_head_sha,SHA);
 assert.deepEqual(v.governance.revision,G);
 assert.equal(v.ci.checked_head_sha,SHA);
 assert.equal(v.task_plan.task_refs[0],"T-001");
 assert.equal(p.scoped_support.sync_available.origin_ref,"verified-adapter:sync");
 assert.equal(p.execution_authorized,false);
});


// E review PR #53 / #6082663508: FilesystemGovernanceStore returns
// {store_kind:"filesystem", value:"sha256:<64 lowercase hex>"}. The Store
// revision is NOT the gsr1:filesystem:sha256:<64hex> correlation identifier.
const FS_REVISION = Object.freeze({
  domain:"governance_store",store_kind:"filesystem",value:`sha256:${"e".repeat(64)}`,
});
function withFilesystemRevision(mode, revision=FS_REVISION) {
  const f=fixture();
  f.mode=mode;
  f.governance_revision=revision;
  f.sources.tasks.records[0].runtime_mode=mode;
  for (const name of ["project","tasks","missions","decisions","waitpoints","health","ownership","host"])
    f.sources[name].revision=revision;
  for (const name of ["tasks","missions","decisions","waitpoints"])
    for (const record of f.sources[name].records) record.governance_revision=revision;
  return f;
}
for (const mode of ["M0","M1"]) {
  test(`E-FS-01 ${mode}: accepts exact sha256-prefixed FilesystemGovernanceStore revision`,()=>{
    const p=build(withFilesystemRevision(mode));
    assert.deepEqual(p.governance_revision,FS_REVISION);
    assert.deepEqual(p.source_snapshot_vector.governance.revision,FS_REVISION);
    assert.equal(p.source_status.project,"observed");
    assert.equal(p.source_status.tasks,"observed");
    assert.equal(p.source_status.decisions,"observed");
    assert.equal(p.source_status.waitpoints,"observed");
    assert.equal(p.recommendations.length,1);
    assert.equal(p.recommendations[0].advice_status,"ADVICE_READY");
    advisoryNotAuthority(p);
  });
  test(`E-FS-02 ${mode}: rejects invalid bare 64-hex filesystem revision`,()=>{
    const bare={...FS_REVISION,value:"e".repeat(64)};
    const p=build(withFilesystemRevision(mode,bare));
    assert.equal(p.governance_revision,null);
    assert.equal(p.source_status.tasks,"not_observed");
    assert.deepEqual(p.recommendations,[]);
    assert.ok(p.warnings.includes("governance_revision_not_verified"));
    advisoryNotAuthority(p);
  });
}
test("E-FS-03 rejects gsr1 correlation identifier and uppercase filesystem digest as Store revision",()=>{
  for (const bad of [`gsr1:filesystem:sha256:${"e".repeat(64)}`,`sha256:${"E".repeat(64)}`]) {
    const p=build(withFilesystemRevision("M0",{...FS_REVISION,value:bad}));
    assert.equal(p.governance_revision,null);
    assert.deepEqual(p.recommendations,[]);
    advisoryNotAuthority(p);
  }
});
