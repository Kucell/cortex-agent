"use strict";

// Read-only interpretation of real Decision and Waitpoint records. Matching
// committed records is observation, never Owner authentication or effect admission.
const decisionSchema = require("../../templates/_shared/.agent/decisions/decision.schema.json");
const waitpointSchema = require("../../templates/_shared/.agent/waitpoints/waitpoint.schema.json");
const { supportedSchema, matches, iso } = require("./advisory-plan.js");

function validCanonicalRecord(kind, value) {
  const schema = kind === "decision" ? decisionSchema : kind === "waitpoint" ? waitpointSchema : null;
  return !!schema && supportedSchema(schema) && matches(schema, value);
}
function sameRevision(a, b) {
  return !!a && !!b && a.domain === "governance_store" && b.domain === a.domain
    && a.store_kind === "git" && b.store_kind === a.store_kind && a.value === b.value;
}
function pairedCanonicalGate(task, decisions, waitpoints, now, revision) {
  const pending = [], problems = [], evidence = [];
  const outcome = (code, hard = false, approval = false) => {
    if (code) problems.push(code);
    return { pending, problems, evidence, hard, approval_required: approval };
  };
  const plan = task.canonical_plan;
  if (!plan || plan.contract !== "canonical-advisory-plan-v1"
      || !/^[0-9a-f]{64}$/.test(plan.sha256 || "")
      || plan.resource_ref !== task.approval_resource_ref || plan.sha256 !== task.plan_digest
      || plan.pair_namespace_complete !== true) return outcome("canonical_pair_namespace_not_observed");
  const created = iso(plan.created_at), expiry = iso(plan.expires_at);
  if (created === null || expiry === null || created > now || expiry <= created) return outcome("canonical_plan_validity_invalid");
  if (expiry <= now) return outcome("canonical_plan_expired", true);
  const scoped = (row) => row && row.project_ref === task.project_ref
    && sameRevision(row.governance_revision, revision) && typeof row.source_ref === "string"
    && row.source_ref.length > 0 && row.canonical_record;
  // Count every record naming the exact resource, including rejected or released
  // alternatives. Do not select the newest or first approved candidate.
  const ds = decisions.filter(scoped).filter((row) => row.canonical_record.gate?.resource_ref === plan.resource_ref);
  const ws = waitpoints.filter(scoped).filter((row) => row.canonical_record.gate?.resource_ref === plan.resource_ref);
  if (ds.length > 1 || ws.length > 1) return outcome("canonical_pair_ambiguous", true);
  if (!ds.length || !ws.length) return outcome("canonical_pair_missing", false, true);
  const d = ds[0].canonical_record, w = ws[0].canonical_record;
  evidence.push(ds[0].source_ref, ws[0].source_ref);
  if (!validCanonicalRecord("decision", d) || !validCanonicalRecord("waitpoint", w)) return outcome("canonical_pair_schema_invalid");
  if (d.decision_id !== plan.decision_id || w.waitpoint_id !== plan.waitpoint_id
      || w.decision_id !== d.decision_id) return outcome("canonical_pair_id_mismatch");
  const relationsMatch = (record) => record.relations.task_ids.length === 1
    && record.relations.task_ids[0] === task.task_ref
    && record.relations.mission_ids.length === 1 && record.relations.mission_ids[0] === task.mission_ref
    && record.relations.artifact_refs.includes(plan.resource_ref);
  if (d.type !== "approval" || d.gate.action !== plan.action || w.gate.action !== plan.action
      || plan.action !== "external_side_effect" || w.owner_workflow !== plan.owner_workflow
      || plan.owner_workflow !== "/mission" || !relationsMatch(d) || !relationsMatch(w)) return outcome("canonical_pair_scope_mismatch");
  const dc = iso(d.created_at), du = iso(d.updated_at), wc = iso(w.created_at), wu = iso(w.updated_at);
  if ([dc, du, wc, wu].some((value) => value === null || value > now)
      || dc < created || wc < created || du < dc || wu < wc) return outcome("canonical_pair_chronology_invalid");
  if (["rejected", "revision_requested", "canceled", "superseded"].includes(d.status)
      || d.superseded_by_decision_id != null) return outcome("canonical_decision_not_approved", true);
  if (d.status === "open") {
    pending.push(d.decision_id);
    return outcome("canonical_decision_open", false, true);
  }
  if (d.status !== "approved" || d.selected_option !== "approve" || !d.options.includes("approve")
      || typeof d.resolved_by !== "string" || !d.resolved_by.trim()) return outcome("canonical_decision_selection_invalid", true);
  const resolved = iso(d.resolved_at);
  if (resolved === null || resolved < dc || resolved > du || resolved > now) return outcome("canonical_decision_resolution_invalid");
  // Decision schema has no expires_at. Its resolution, plan validity, and the
  // Waitpoint deadline are distinct; never copy the latter into a fake Decision.
  if (["canceled", "expired", "blocked"].includes(w.status)) return outcome("canonical_waitpoint_blocks", true);
  if (w.status !== "released") return outcome("canonical_waitpoint_not_released", false, true);
  const released = iso(w.released_at), deadline = iso(w.expires_at);
  if (released === null || released < resolved || released < wc || released > wu || released > now
      || typeof w.released_by !== "string" || !w.released_by.trim()
      || !w.evidence_refs.includes(plan.resource_ref)) return outcome("canonical_waitpoint_release_invalid");
  if (deadline === null || deadline <= released) return outcome("canonical_waitpoint_deadline_missing_or_invalid");
  if (deadline <= now) return outcome("canonical_waitpoint_expired", true);
  return outcome(null);
}

module.exports = Object.freeze({ validCanonicalRecord, pairedCanonicalGate });
