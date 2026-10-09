"use strict";

/**
 * C lane: SCRATCH-ONLY proof-of-contract for FAE-008 / Next Action Advisor.
 * Pure, provider-neutral, no FS/network/Host/Dispatch/approval side effects.
 * Observed input MUST come from trustworthy read adapters; this module cannot
 * certify a backend or mint execution authority from any source material.
 */
const SCHEMA_VERSION = "1.0.0";
const CONTRACT_STAGE = "scratch-unreleased";
const SOURCE_NAMES = Object.freeze([
  "project", "tasks", "missions", "decisions", "waitpoints",
  "ci", "reviews", "health", "ownership", "host",
]);
const GOVERNED = new Set(["project", "tasks", "missions", "decisions", "waitpoints", "health", "ownership"]);
const STATUS = new Set(["observed", "not_observed", "stale", "conflict", "unavailable"]);
const SUPPORT = Object.freeze([
  "sync_available", "manual_resume_available", "local_executor_proven",
  "automatic_dispatch_supported_for_this_sink",
]);
const MODES = new Set(["M0", "M1", "M2", "M3"]);
const RISK = new Set(["low", "medium", "high", "critical"]);
const PRIORITY = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });
const BLOCKED_CI = new Set(["failure", "failed", "error", "timed_out", "cancelled", "action_required"]);
const BLOCKED_REVIEW = new Set(["changes_requested", "rejected"]);
const UNKNOWN = "INSUFFICIENT_EVIDENCE";

function plain(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function string(v) { return typeof v === "string" && v.trim() ? v.trim() : null; }
function list(v) { return Array.isArray(v) ? v : []; }
function unique(v) { return [...new Set(v.filter(string))]; }
function utc(s) {
  if (typeof s !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s)) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
function freezeDeep(v) {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) freezeDeep(x);
    Object.freeze(v);
  }
  return v;
}
function token(v) {
  if (!plain(v)) return null;
  const value = string(v.value);
  if (!value) return null;
  if (v.domain === "governance_store" && ["git", "filesystem"].includes(v.store_kind)) {
    const valid = v.store_kind === "git" ? /^[0-9a-f]{40}$/.test(value) : /^[0-9a-f]{64}$/.test(value);
    return valid ? { domain: "governance_store", store_kind: v.store_kind, value } : null;
  }
  if (v.domain === "product_commit" && /^[0-9a-f]{40}$/.test(value)) {
    return { domain: "product_commit", store_kind: "git", value };
  }
  return null;
}
function sameToken(a, b) {
  return !!a && !!b && a.domain === b.domain && a.store_kind === b.store_kind && a.value === b.value;
}
function reason(arr, value) { if (!arr.includes(value)) arr.push(value); }
function records(source, state) { return state === "observed" && Array.isArray(source?.records) ? source.records : []; }

function observeSource(name, raw, project, revision, head, now) {
  const source = plain(raw) ? raw : {};
  let state = STATUS.has(source.status) ? source.status : "not_observed";
  const rev = token(source.revision);
  const ttl = source.max_age_seconds;
  const at = utc(source.observed_at);
  if (state === "observed") {
    if (!string(source.origin_ref) || !string(source.source_ref) || !string(source.project_ref)
      || !Number.isFinite(at) || !Number.isFinite(ttl) || ttl <= 0 || !rev) state = "not_observed";
    else if (source.project_ref !== project || at > now) state = "conflict";
    else if (now - at > ttl * 1000) state = "stale";
    else if (GOVERNED.has(name) && (!revision || !sameToken(rev, revision))) state = revision ? "conflict" : "not_observed";
    else if ((name === "ci" || name === "reviews") && (!head || !sameToken(rev, {domain:"product_commit",store_kind:"git",value:head}))) state = "stale";
    else if (!GOVERNED.has(name) && name !== "ci" && name !== "reviews" && rev.domain === "governance_store" && (!revision || !sameToken(rev, revision))) state = "conflict";
  }
  return {
    status: state,
    source_ref: string(source.source_ref),
    origin_ref: string(source.origin_ref),
    revision: rev,
    observed_at: string(source.observed_at),
    max_age_seconds: Number.isFinite(ttl) && ttl > 0 ? ttl : null,
  };
}

function observeBackend(raw, project, mode, now) {
  const b = plain(raw) ? raw : {};
  const values = new Set(["not_verified", "local_single_writer_only", "shared_atomic_fenced_proven"]);
  const base = {
    value: "not_verified", backend_ref: null, mode_ref: null,
    project_ref: project, proof_ref: null, verified_by_ref: null,
    affected_effect_sink_refs: [], observed_at: null, expires_at: null,
  };
  if (!values.has(b.value) || b.value === "not_verified") return base;
  const at = utc(b.observed_at), expiry = utc(b.expires_at);
  const proof = string(b.proof_ref), verifier = string(b.verified_by_ref);
  const scope = list(b.affected_effect_sink_refs).filter(string);
  if (!string(b.backend_ref) || !proof || !verifier || !string(b.mode_ref)
      || b.project_ref !== project || b.mode_ref !== mode
      || !Number.isFinite(at) || !Number.isFinite(expiry) || at > now || expiry <= now
      || !scope.length) return base;
  return {
    value: b.value, backend_ref: b.backend_ref, mode_ref: b.mode_ref,
    project_ref: project, proof_ref: proof, verified_by_ref: verifier,
    affected_effect_sink_refs: unique(scope), observed_at: b.observed_at, expires_at: b.expires_at,
  };
}

function observeSupport(name, raw, project, now, backend) {
  const s = plain(raw) ? raw : {};
  const empty = {
    value: null, mode: MODES.has(s.mode) ? s.mode : null,
    project_ref: project, task_ref: null, operation_ref: null, sink_ref: null,
    origin_ref: null, proof_refs: [], observed_at: null, expires_at: null,
    source_revision: null, evidence_status: "not_observed", reason_codes: ["support_not_observed"],
  };
  if (s.value !== true && s.value !== false) return empty;
  const at = utc(s.observed_at), expiry = utc(s.expires_at);
  const rev = token(s.source_revision);
  const ttl = s.max_age_seconds;
  const mustScopeSink = name === "automatic_dispatch_supported_for_this_sink";
  if (!MODES.has(s.mode) || s.project_ref !== project || !string(s.origin_ref)
      || !string(s.proof_refs?.[0]) || !rev || !Number.isFinite(at)
      || !Number.isFinite(expiry) || !Number.isFinite(ttl) || ttl <= 0
      || !string(s.task_ref) || !string(s.operation_ref)
      || (mustScopeSink && !string(s.sink_ref)) || at > now || expiry <= now
      || now - at > ttl * 1000) return empty;
  if (name === "local_executor_proven" && !["M0", "M1"].includes(s.mode)) return empty;
  if (mustScopeSink && s.value === true) {
    if (!string(s.verified_by_ref) || !string(s.effect_admission_proof_ref)
        || !backend.affected_effect_sink_refs.includes(s.sink_ref)
        || (s.mode === "M2" || s.mode === "M3") && backend.value !== "shared_atomic_fenced_proven"
        || (s.mode === "M0" || s.mode === "M1") && backend.value === "not_verified") return empty;
  }
  return {
    value: s.value, mode: s.mode, project_ref: project,
    task_ref: s.task_ref, operation_ref: s.operation_ref, sink_ref: string(s.sink_ref),
    origin_ref: s.origin_ref, proof_refs: unique(s.proof_refs),
    observed_at: s.observed_at, expires_at: s.expires_at,
    source_revision: rev, evidence_status: "observed", reason_codes: [],
  };
}

function matchingTask(record, project, revision) {
  return plain(record) && string(record.task_ref) && string(record.source_ref)
    && record.project_ref === project && !!revision && sameToken(token(record.governance_revision), revision);
}
function currentRecord(record, observedSource, now) {
  const at = utc(record?.observed_at);
  const ttl = observedSource.max_age_seconds;
  return Number.isFinite(at) && at <= now && Number.isFinite(ttl) && ttl > 0
    && now - at <= ttl * 1000;
}
function authorityOwner(value, task, now) {
  return plain(value) && value.owner_ref === task.owner_ref
    && string(value.lease_ref) && string(value.fencing_token)
    && string(value.proof_ref) && string(value.verified_by_ref)
    && Number.isFinite(utc(value.expires_at)) && utc(value.expires_at) > now;
}
function latest(items) {
  return items.slice().sort((a,b)=>utc(b.observed_at)-utc(a.observed_at))[0] || null;
}
function rank(task, failingCI) {
  const family = failingCI ? 0 : task.category === "regression" ? 2 : task.category === "improvement" ? 3 : 1;
  return [family, task.on_critical_path === true ? 0 : 1,
    Object.hasOwn(PRIORITY, task.priority) ? PRIORITY[task.priority] : 4,
    task.task_ref];
}
function compare(a,b) {
  const x=a.rank, y=b.rank;
  for (let i=0;i<x.length;i++) if (x[i] !== y[i]) return x[i]<y[i]?-1:1;
  return 0;
}
function pairedGate(task, decisions, waitpoints, now, revision) {
  const pending = [], problems = [], evidence = [];
  const ref=string(task.approval_resource_ref), digest=string(task.plan_digest);
  if (!ref || !digest) { reason(problems,"approval_scope_not_observed"); return {pending,problems,evidence,hard:false,approval_required:false}; }
  const ds=decisions.filter(d=>d.project_ref===task.project_ref && d.task_ref===task.task_ref
    && d.mission_ref===task.mission_ref && d.resource_ref===ref && d.plan_digest===digest
    && sameToken(token(d.governance_revision),revision)
    && string(d.source_ref) && string(d.decision_id));
  const blocked = ds.find(d=>["rejected","revoked","expired"].includes(d.status)
    || (d.status==="approved" && Number.isFinite(utc(d.expires_at)) && utc(d.expires_at)<=now));
  if (blocked) {reason(problems,"decision_rejected_revoked_or_expired");evidence.push(blocked.source_ref);return {pending,problems,evidence,hard:true,approval_required:false};}
  const approved=ds.find(d=>d.status==="approved" && d.action===task.gate_action
    && d.owner_ref===task.owner_ref && utc(d.expires_at)>now);
  for (const d of ds.filter(d=>["open","pending"].includes(d.status))) pending.push(d.decision_id);
  if (approved) evidence.push(approved.source_ref);
  if (!approved) reason(problems,"matching_approved_decision_not_observed");
  const wp=approved && waitpoints.find(w=>w.project_ref===task.project_ref
    && w.task_ref===task.task_ref && w.mission_ref===task.mission_ref
    && w.resource_ref===ref && w.plan_digest===digest && w.decision_id===approved.decision_id
    && sameToken(token(w.governance_revision),revision)
    && w.status==="released" && w.action===task.gate_action && string(w.owner_workflow)
    && string(w.released_by) && Number.isFinite(utc(w.released_at)) && utc(w.released_at)<=now
    && string(w.source_ref));
  if (wp) evidence.push(wp.source_ref); else reason(problems,"matching_released_waitpoint_not_observed");
  return {pending,problems,evidence,hard:false,approval_required:!wp};
}

/** Builds ONLY a presentation DTO. No output field can authorize effects. */
function buildNextActionProjection(input) {
  if (!plain(input) || !string(input.project_ref) || !Number.isFinite(utc(input.observed_at)))
    throw new TypeError("Expected project_ref and UTC observed_at");
  const project = input.project_ref.trim();
  const now = utc(input.observed_at);
  const revision = token(input.governance_revision);
  const head = string(input.task_head_sha) && /^[0-9a-f]{40}$/.test(input.task_head_sha)
    ? input.task_head_sha : null;
  const src = plain(input.sources) ? input.sources : {};
  const observed = Object.fromEntries(SOURCE_NAMES.map(name=>[
    name, observeSource(name,src[name],project,revision,head,now),
  ]));
  const backend=observeBackend(input.backend_consistency,project,input.mode,now);
  const support=Object.fromEntries(SUPPORT.map(name=>[
    name,observeSupport(name,input.support?.[name],project,now,backend),
  ]));
  const warnings=[];
  for (const [name,s] of Object.entries(observed)) if (s.status!=="observed") warnings.push(`${name}:${s.status}`);
  if (!revision) warnings.push("governance_revision_not_verified");
  if (!head) warnings.push("task_head_not_verified");

  const taskRows=records(src.tasks,observed.tasks.status), missionRows=records(src.missions,observed.missions.status);
  const decisionRows=records(src.decisions,observed.decisions.status), waitRows=records(src.waitpoints,observed.waitpoints.status);
  const ciRows=records(src.ci,observed.ci.status), reviewRows=records(src.reviews,observed.reviews.status);
  const allTasks=new Map(taskRows.filter(t=>matchingTask(t,project,revision)).map(t=>[t.task_ref,t]));
  const missions=new Map(missionRows.filter(m=>m.project_ref===project && revision
    && sameToken(token(m.governance_revision),revision) && string(m.mission_ref) && string(m.source_ref))
    .map(m=>[m.mission_ref,m]));
  const results=[]; const seen=new Set();
  const foreignTaskRefs=taskRows.filter(t=>plain(t) && string(t.task_ref) && t.project_ref!==project)
    .map(t=>t.task_ref);
  if(foreignTaskRefs.length)warnings.push("cross_project_task_evidence_rejected");
  for (const task of taskRows) {
    if (!string(task.task_ref) || seen.has(task.task_ref) || !matchingTask(task,project,revision)) continue;
    seen.add(task.task_ref);
    if (["done","completed","cancelled","rejected","archived"].includes(task.status)) continue;
    const hard=[], drift=[], missing=[], deferred=[], needsApproval=[];
    const refs=[task.source_ref];
    const missingSources=SOURCE_NAMES.filter(n=>observed[n].status!=="observed");
    for(const name of missingSources) {
      if(observed[name].status==="conflict") reason(drift,`source_revision_or_project_conflict:${name}`);
      else reason(missing,`source_${name}_${observed[name].status}`);
    }
    const mission=missions.get(task.mission_ref);
    if (!mission) reason(missing,"mission_not_observed"); else refs.push(mission.source_ref);
    const deps=unique(list(task.dependencies));
    if(deps.includes(task.task_ref))reason(hard,"dependency_cycle_self");
    for(const d of deps){const dep=allTasks.get(d);if(!dep || !["done","completed"].includes(dep.status)
      || dep.verification_status!=="verified")reason(missing,`dependency_not_verified:${d}`);else refs.push(dep.source_ref);}
    if (!RISK.has(task.risk_tier)) reason(missing,"risk_unknown");
    if(!string(task.scope?.branch) || !string(task.scope?.repository) || !list(task.scope?.allowed_paths).length
      || !list(task.scope?.allowed_operations).length) reason(missing,"scope_unknown");
    if(!list(task.validation_plan?.tests).length)reason(missing,"validation_plan_unknown");
    if(!plain(task.estimated_budget) || !string(task.estimated_budget.source_ref))reason(missing,"budget_unknown");
    if(!Number.isFinite(utc(task.expires_at)))reason(missing,"expiry_unknown");
    else if (utc(task.expires_at)<=now)reason(hard,"task_scope_expired");
    const currentCI=latest(ciRows.filter(c=>c.project_ref===project && c.task_ref===task.task_ref
      && string(c.source_ref) && c.head_sha===head && currentRecord(c,observed.ci,now)));
    const oldCI=ciRows.some(c=>c.task_ref===task.task_ref && c.head_sha!==head);
    if(!currentCI)reason(missing,oldCI?"ci_old_head":"ci_not_observed");
    else {refs.push(currentCI.source_ref);if(BLOCKED_CI.has(currentCI.status))reason(hard,`ci_${currentCI.status}`);
      else if(!["success","passed"].includes(currentCI.status))reason(missing,`ci_${currentCI.status||"unknown"}`);}
    const currentReview=latest(reviewRows.filter(r=>r.project_ref===project && r.task_ref===task.task_ref
      && r.head_sha===head && string(r.source_ref) && currentRecord(r,observed.reviews,now)));
    if(!currentReview)reason(missing,"review_not_observed_or_old_head");
    else {refs.push(currentReview.source_ref);if(BLOCKED_REVIEW.has(currentReview.status))reason(hard,`review_${currentReview.status}`);
      else if(currentReview.status!=="approved" || currentReview.independent!==true || currentReview.dismissed===true)
        reason(missing,"independent_review_not_verified");}
    const gate=pairedGate(task,decisionRows,waitRows,now,revision);refs.push(...gate.evidence);
    if(gate.hard)hard.push(...gate.problems);else if(gate.approval_required)needsApproval.push(...gate.problems);
    const health=observed.health.status==="observed" ? src.health.value:null;
    if(health?.health?.status==="blocked" || health?.reconciliation?.can_resume===false)reason(hard,"health_blocks_execution");
    else if(!health || !["healthy","degraded"].includes(health.health?.status))reason(missing,"health_not_verified");
    const liveOwner=observed.ownership.status==="observed" ? src.ownership.value:null;
    if(!authorityOwner(liveOwner,task,now))reason(missing,"live_owner_lease_fence_not_verified");
    const host=observed.host.status==="observed"?src.host.value:null;
    if(host && host.status==="offline")reason(deferred,"host_offline");
    else if(!host || host.synthetic===true || !string(host.capability_proof_ref)
      || !string(host.verified_by_ref))reason(missing,"host_not_proven");
    const mode=MODES.has(task.runtime_mode)?task.runtime_mode:input.mode;
    const automatic=task.requires_auto_dispatch===true;
    if (automatic && mode === "M2") {
      const s=support.automatic_dispatch_supported_for_this_sink;
      if(s.value===false && s.mode==="M2" && s.sink_ref===task.sink_ref)reason(hard,"m2_automatic_sink_unsupported");
      else if(s.value!==true || s.mode!=="M2" || s.task_ref!==task.task_ref
        || s.operation_ref!==task.operation_ref || s.sink_ref!==task.sink_ref)reason(missing,"m2_auto_sink_unproven");
    }
    if (automatic && ["M0","M1"].includes(mode)) {
      const s=support.local_executor_proven;
      if(s.value!==true || s.mode!==mode || s.task_ref!==task.task_ref)reason(missing,"local_executor_unproven");
    }
    const status=hard.length?"BLOCKED":drift.length?"RECONCILIATION_REQUIRED":missing.length?UNKNOWN
      :deferred.length?"DEFERRED":needsApproval.length?"APPROVAL_REQUIRED":"ADVICE_READY";
    const reasons=unique([...hard,...drift,...missing,...deferred,...needsApproval]);
    const candidate={
      project_ref:project,governance_revision:revision,task_ref:task.task_ref,
      mission_ref:mission?task.mission_ref:null,reason:currentCI && BLOCKED_CI.has(currentCI.status)
        ?"Observed exact-head CI failed; investigate the reported validation." :"Observed unfinished, sourced Task.",
      source_refs:unique(refs),prerequisites:deps,risk_tier:RISK.has(task.risk_tier)?task.risk_tier:"unknown",
      scope:{repository:string(task.scope?.repository),branch:string(task.scope?.branch),
        allowed_paths:unique(list(task.scope?.allowed_paths)),allowed_operations:unique(list(task.scope?.allowed_operations))},
      validation_plan:{tests:unique(list(task.validation_plan?.tests))},
      required_host_capabilities:unique(list(task.required_host_capabilities)),
      advice_status:status,missing_decision_refs:gate.pending,missing_waitpoint_refs:gate.problems.includes("matching_released_waitpoint_not_observed")?[]:[],
      evidence_status:status==="ADVICE_READY"?"observed":"incomplete",
      blocking_reasons:reasons,estimated_budget:plain(task.estimated_budget)?{
        tokens:task.estimated_budget.tokens??null,cost_amount:task.estimated_budget.cost_amount??null,
        currency:string(task.estimated_budget.currency),source_ref:string(task.estimated_budget.source_ref)}:null,
      stop_conditions:unique(list(task.stop_conditions)),expires_at:string(task.expires_at),
      recommended_action:status==="ADVICE_READY"?"PRESENT_ONLY":"RECONCILE_OR_REQUEST_SCOPED_APPROVAL",
      approval_request_draft:{kind:"approval_request_draft_only",resource_ref:string(task.approval_resource_ref),
        plan_digest:string(task.plan_digest),task_ref:task.task_ref,mission_ref:mission?task.mission_ref:null,
        observed_pending_decision_refs:gate.pending,write_permitted:false},
      execution_authorized:false,
    };
    results.push({candidate,rank:rank(task,currentCI&&BLOCKED_CI.has(currentCI.status))});
  }
  results.sort(compare);
  const recommendations=results.slice(0,3).map(x=>x.candidate);
  if(!recommendations.length)warnings.push("goal_or_task_not_observed");
  const anyBlocked=foreignTaskRefs.length>0 || recommendations.some(c=>c.advice_status==="BLOCKED");
  const drift=recommendations.some(c=>c.advice_status==="RECONCILIATION_REQUIRED")
    || Object.values(observed).some(x=>x.status==="conflict");
  const project_status=anyBlocked?"BLOCKED":drift?"RECONCILIATION_REQUIRED":warnings.length || recommendations.some(c=>c.advice_status!=="ADVICE_READY")?"DEGRADED":"OBSERVED";
  const source_snapshot_vector={
    project:{project_ref:project,...observed.project},
    governance:{binding_ref:string(input.governance_binding_ref),revision,observed_at:observed.tasks.observed_at,
      status:observed.tasks.status,origin_ref:observed.tasks.origin_ref},
    task_plan:{task_refs:unique(recommendations.map(r=>r.task_ref)),
      mission_refs:unique(recommendations.map(r=>r.mission_ref)),
      plan_digests:unique(recommendations.map(r=>r.approval_request_draft.plan_digest))},
    product:{repository_ref:string(input.repository_ref),task_head_sha:head},
    ci:{checked_head_sha:observed.ci.status==="observed"?head:null,...observed.ci},
    review:{reviewed_head_sha:observed.reviews.status==="observed"?head:null,...observed.reviews},
    ownership:{...observed.ownership,backend_consistency:backend},host:{...observed.host},
  };
  return freezeDeep({schema_version:SCHEMA_VERSION,contract_stage:CONTRACT_STAGE,
    project_ref:project,governance_revision:revision,generated_at:input.observed_at,
    project_status,source_status:Object.fromEntries(Object.entries(observed).map(([k,v])=>[k,v.status])),
    source_snapshot_vector,scoped_support:support,warnings, recommendations,
    execution_authorized:false});
}

module.exports={SCHEMA_VERSION,CONTRACT_STAGE,buildNextActionProjection};
