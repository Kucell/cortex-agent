"use strict";

// INERT PROTOTYPE ONLY. There is deliberately no RuntimeWriter authenticator,
// production namespace adapter, remote authority, Host or live dispatch path.
// Caller JSON below describes a synthetic identity; it NEVER authenticates one.
// Every record and receipt is marked effect_authority:false. The strict entry
// accepts only this module's private, process-local brand and constructs its own
// inert port. Neither that brand nor Git CAS grants physical effect authority.
// A future live source, sink-side fence, hard expiry and Host isolation require
// separate reviewed implementations. Client clocks and ref CAS prove none of them.
const R = require("../governance/canonical-records");
const { createOperation, transition } = require("./operation-lifecycle");
const { clone, freeze, stable, digest, json, parse, epoch } = R;
const K = Object.freeze(Object.fromEntries([
  "project", "owner", "writer", "decision", "waitpoint", "scope", "task", "dependency",
  "budget", "lease", "reservation", "replay", "ack", "outcome", "journal"
].map(k => [k, "inert-runtime-v1/" + k + ".json"])));
const OPTIONAL = new Set(["reservation", "replay", "ack", "outcome"]);
const brands = new WeakSet();
const STATES = ["RESERVED", "DISPATCHING", "ACKNOWLEDGED", "COMPLETED", "REVOKED", "UNKNOWN"];
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function check(ok, code) { if (!ok) fail(code); }
function exact(v, keys) {
  check(v && typeof v === "object" && !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Object.getOwnPropertySymbols(v).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(v)).every(d => Object.hasOwn(d,"value") && d.enumerable) &&
    stable(Object.keys(v).sort()) === stable([...keys].sort()), "INERT_FIELDS");
}
function text(v) { check(typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/.test(v), "INERT_ID"); }
function integer(v, min = 0) { check(Number.isSafeInteger(v) && v >= min && v <= 1000000, "INERT_INTEGER"); }
function hash(v) { check(typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v), "INERT_DIGEST"); }
function rev(v) { exact(v, ["store_kind", "value"]); check(v.store_kind === "git" && typeof v.value === "string" && /^[a-f0-9]{40}$/.test(v.value) && !/^0+$/.test(v.value), "INERT_REVISION"); }
function same(a, b) { return stable(a) === stable(b); }
function envelope(kind, fields) { return { schema_version: 1, kind: "inert-" + kind + "-v1", effect_authority: false, ...fields }; }
function fields(v, kind, names) {
  exact(v, ["schema_version", "kind", "effect_authority", ...names]);
  check(v.schema_version === 1 && v.kind === "inert-" + kind + "-v1" && v.effect_authority === false, "INERT_RECORD_KIND");
}
function fixtureIdentity(input) {
  const v = clone(input);
  fields(v, "writer-fixture", ["project_id", "writer_id", "instance_id", "repository_id", "workflow_path", "workflow_sha", "run_id", "run_attempt", "owner_generation", "writer_generation"]);
  for (const k of ["project_id", "writer_id", "instance_id", "repository_id", "workflow_path", "run_id"]) text(v[k]);
  check(v.writer_id.startsWith("synthetic:") && v.instance_id.startsWith("synthetic:") && v.run_id.startsWith("synthetic:"), "INERT_IDENTITY_ONLY");
  check(typeof v.workflow_sha === "string" && /^[a-f0-9]{40}$/.test(v.workflow_sha) && !/^0+$/.test(v.workflow_sha), "INERT_CODE_BINDING");
  for (const k of ["run_attempt", "owner_generation", "writer_generation"]) integer(v[k], 1);
  return freeze(v);
}
function request(input) {
  const v = clone(input); exact(v, ["operation_id", "attempt_nonce", "task_id"]);
  Object.values(v).forEach(text);
  check(/^[a-f0-9]{32}$/.test(v.attempt_nonce), "INERT_NONCE");
  return freeze(v);
}
function validateRecords(s) {
  const { project: p, owner: o, writer: w, decision: d, waitpoint: wp, scope: sc,
    task: t, dependency: dep, budget: b, lease: l, journal: j } = s;
  fields(p, "project", ["project_id", "repository_id", "status"]); text(p.project_id); text(p.repository_id);
  fields(o, "owner", ["subject_id", "generation", "status"]); text(o.subject_id); integer(o.generation, 1);
  fields(w, "writer", ["writer_id", "instance_id", "run_id", "run_attempt", "generation", "owner_generation", "repository_id", "workflow_path", "workflow_sha", "status"]);
  for (const k of ["writer_id", "instance_id", "run_id", "repository_id", "workflow_path"]) text(w[k]);
  integer(w.run_attempt, 1);
  integer(w.generation, 1); integer(w.owner_generation, 1);
  check(typeof w.workflow_sha === "string" && /^[a-f0-9]{40}$/.test(w.workflow_sha), "INERT_CODE_BINDING");
  fields(d, "decision", ["decision_id", "scope_digest", "approver_id", "owner_generation", "status"]);
  text(d.decision_id); hash(d.scope_digest); text(d.approver_id); integer(d.owner_generation, 1);
  fields(wp, "waitpoint", ["waitpoint_id", "decision_id", "scope_digest", "released_by", "status"]);
  for (const k of ["waitpoint_id", "decision_id", "released_by"]) text(wp[k]); hash(wp.scope_digest);
  fields(sc, "scope", ["project_id", "task_id", "task_digest", "owner_generation", "writer_generation", "units", "valid_from", "expires_at", "action"]);
  text(sc.project_id); text(sc.task_id); hash(sc.task_digest);
  for (const k of ["owner_generation", "writer_generation", "units"]) integer(sc[k], 1);
  check(Number.isFinite(epoch(sc.valid_from)) && epoch(sc.valid_from) < epoch(sc.expires_at), "INERT_TIME");
  fields(t, "task", ["task_id", "status", "input", "dependency_id", "dependency_digest"]);
  text(t.task_id); text(t.dependency_id); hash(t.dependency_digest); exact(t.input, ["fixture_value"]);
  check(typeof t.input.fixture_value === "string" && /^[a-z0-9_-]{1,64}$/.test(t.input.fixture_value), "INERT_INPUT");
  fields(dep, "dependency", ["task_id", "status", "test_ref", "review_ref"]);
  for (const k of ["task_id", "test_ref", "review_ref"]) text(dep[k]);
  fields(b, "budget", ["limit", "held", "spent"]); Object.values({ limit:b.limit, held:b.held, spent:b.spent }).forEach(v => integer(v));
  check(b.held <= b.limit && b.spent <= b.held, "INERT_BUDGET");
  fields(l, "lease", ["fence", "operation_id", "attempt_nonce", "instance_id", "status"]); integer(l.fence);
  for (const k of ["operation_id", "attempt_nonce", "instance_id"]) if (l[k] !== null) text(l[k]);
  fields(j, "journal", ["events"]); check(Array.isArray(j.events) && j.events.length <= 16, "INERT_JOURNAL");
  let previous = null;
  for (const event of j.events) {
    exact(event, ["sequence", "action", "at", "before_revision", "writes_digest", "previous_digest"]);
    check(event.sequence === j.events.indexOf(event) + 1 && event.previous_digest === previous && Number.isFinite(epoch(event.at)), "INERT_JOURNAL");
    text(event.action); rev(event.before_revision); hash(event.writes_digest); previous = digest(json(event));
  }
  if (s.reservation) {
    const a = s.reservation;
    fields(a, "reservation", ["request", "identity", "input", "input_digest", "scope_digest", "fence", "units", "state", "reserved_at"]);
    request(a.request); fixtureIdentity(a.identity); exact(a.input, ["fixture_value"]);
    hash(a.input_digest); hash(a.scope_digest); integer(a.fence, 1); integer(a.units, 1);
    check(STATES.includes(a.state) && digest(json(a.input)) === a.input_digest && Number.isFinite(epoch(a.reserved_at)), "INERT_RESERVATION");
  }
  if (s.replay) {
    fields(s.replay, "replay", ["request_digest", "instance_id"]); hash(s.replay.request_digest); text(s.replay.instance_id);
  }
  if (s.ack) {
    fields(s.ack, "ack", ["runtime_ack", "operation", "events"]);
    validateAck(s.ack.runtime_ack); check(Array.isArray(s.ack.events) && s.ack.events.length >= 3 && s.ack.events.length <= 4, "INERT_OPERATION_EVENTS");
    // Deterministic reconstruction below also detects forged Operation fields.
    check(s.reservation, "INERT_ACK_WITHOUT_RESERVATION");
    check(["ACKNOWLEDGED","COMPLETED","REVOKED","UNKNOWN"].includes(s.reservation.state), "INERT_ACK_STATE");
    const a = s.reservation, ack = s.ack.runtime_ack;
    check(ack.project_id === a.identity.project_id && ack.operation_id === a.request.operation_id &&
      ack.attempt_nonce === a.request.attempt_nonce, "INERT_ACK_BINDING");
    const expected = operationModel(s.reservation, s.ack.runtime_ack, s.ack.events[0].at, s.outcome);
    check(same(expected, s.ack), "INERT_OPERATION_MAPPING");
  }
  if (s.outcome) {
    fields(s.outcome, "outcome", ["candidate", "review", "accepted_at"]);
    validateCandidate(s.outcome.candidate); validateReview(s.outcome.review, s.outcome.candidate);
    check(Number.isFinite(epoch(s.outcome.accepted_at)), "INERT_TIME");
    check(s.ack && s.reservation && s.reservation.state === "COMPLETED", "INERT_PARTIAL_OUTCOME");
    const a = s.reservation, c = s.outcome.candidate, r = s.outcome.review;
    check(c.operation_id === a.request.operation_id && c.attempt_nonce === a.request.attempt_nonce &&
      c.ack_digest === digest(json(s.ack.runtime_ack)) && c.content_digest === a.input_digest && c.actual_units <= a.units &&
      r.reviewer_id !== a.identity.writer_id && r.reviewer_id !== a.identity.instance_id, "INERT_OUTCOME_BINDING");
  }
  check(Boolean(s.reservation) === Boolean(s.replay), "INERT_PARTIAL_RESERVATION");
  if (!s.reservation) check(!s.ack && !s.outcome && b.held === 0 && b.spent === 0 && l.status === "idle", "INERT_PARTIAL_RESERVATION");
  else {
    check(s.replay.request_digest === digest(json(s.reservation.request)) && s.replay.instance_id === s.reservation.identity.instance_id && b.held === s.reservation.units, "INERT_PARTIAL_RESERVATION");
    if (["ACKNOWLEDGED", "COMPLETED"].includes(s.reservation.state)) check(s.ack, "INERT_ACK_REQUIRED");
    if (s.reservation.state === "COMPLETED") check(s.outcome && b.spent === s.outcome.candidate.actual_units, "INERT_OUTCOME_REQUIRED");
    else check(!s.outcome && b.spent === 0, "INERT_PARTIAL_OUTCOME");
  }
}
function validateAck(a) {
  fields(a, "runtime-ack", ["project_id", "operation_id", "attempt_nonce", "runtime_ref", "run_id", "session_id", "workspace_id"]);
  for (const k of ["project_id", "operation_id", "attempt_nonce", "runtime_ref", "run_id", "session_id", "workspace_id"]) text(a[k]);
  check(a.runtime_ref === "synthetic:fixed-port" && [a.run_id, a.session_id, a.workspace_id].every(v => v.startsWith("synthetic:")) && new Set([a.run_id, a.session_id, a.workspace_id]).size === 3, "INERT_RUNTIME_IDENTITIES");
}
function validateCandidate(c) {
  fields(c, "candidate", ["ack_digest", "operation_id", "attempt_nonce", "content_digest", "actual_units"]);
  hash(c.ack_digest); hash(c.content_digest); text(c.operation_id); text(c.attempt_nonce); integer(c.actual_units);
}
function validateReview(v, c) {
  fields(v, "review", ["reviewer_id", "candidate_digest", "tests", "review"]); text(v.reviewer_id); hash(v.candidate_digest);
  check(v.reviewer_id.startsWith("synthetic:") && v.candidate_digest === digest(json(c)) && v.tests === "passed" && v.review === "approved", "INERT_REVIEW_REJECTED");
}
function operationModel(a, ack, at, outcome = null) {
  // Only fixture relations actually supplied by the fixed inert RuntimePort are
  // mapped. No placeholder run/session/workspace and no existing lifecycle writes.
  validateAck(ack);
  let operation = createOperation({ operation_id: a.request.operation_id, attempt: 1, kind: "synthetic",
    relations: { task_id: a.request.task_id, run_id: ack.run_id, session_id: ack.session_id, workspace_id: ack.workspace_id },
    actor: { kind: "synthetic", effect_authority: false }, owner: a.identity.writer_id, workflow: "synthetic:strict-entry",
    target_revision: a.scope_digest, created_at: at });
  const events = [];
  for (const to of ["inspected", "authorized", "executing"]) {
    const next = transition(operation, to, { at, readiness: { readiness_id: "synthetic:readiness" }, authorization: { authorization_id: "synthetic:authorization" } });
    operation = next.operation; events.push(next.event);
  }
  if (outcome) {
    const next = transition(operation, "succeeded", { at: outcome.accepted_at, evidence_refs: [outcome.candidate.content_digest] });
    operation = next.operation; events.push(next.event);
  }
  return envelope("ack", { runtime_ack: ack, operation, events });
}
function createInertAdmissionPrototype(options) {
  // Dependencies are trusted test assembly, not an authentication boundary.
  exact(options, ["store", "writerFixture"]);
  const identity = fixtureIdentity(options.writerFixture), store = options.store;
  check(store && store.effect_authority === false && store.ref === "refs/cortex/state" &&
    ["readSnapshot", "prepareBatch", "publishPrepared"].every(k => typeof store[k] === "function"), "INERT_LOCAL_STORE_REQUIRED");
  const io = Object.freeze(Object.fromEntries(["readSnapshot", "prepareBatch", "publishPrepared"].map(k => [k, store[k].bind(store)])));
  const handles = new WeakMap(), issued = new Map(); let quarantined = false;
  function handle(a) { const h = Object.freeze(Object.create(null)); handles.set(h, freeze(clone(a))); issued.set(digest(json(a.request)),a.fence); return h; }
  function bound(h) { const a = h && typeof h === "object" ? handles.get(h) : null; check(a, "INERT_HANDLE"); return a; }
  async function read() {
    check(!quarantined, "INERT_QUARANTINED");
    const snap = await io.readSnapshot(Object.values(K)); rev(snap.revision);
    check(snap.effect_authority === false, "INERT_STORE_AUTHORITY"); const values = {};
    for (const [name, key] of Object.entries(K)) {
      check(Object.hasOwn(snap.records, key), "INERT_INCOMPLETE_SNAPSHOT");
      const r = snap.records[key];
      if (r === null) { check(OPTIONAL.has(name), "INERT_RECORD_MISSING"); values[name] = null; continue; }
      check(r && typeof r.content === "string" && r.sha256 === digest(r.content).slice(7), "INERT_RECORD_DIGEST");
      values[name] = parse(r.content);
    }
    validateRecords(values); return { revision: Object.freeze({store_kind:"git",value:snap.revision.value}), values };
  }
  function gates(s) {
    const { project:p, owner:o, writer:w, decision:d, waitpoint:wp, scope:sc, task:t, dependency:dep } = s.values;
    check(p.status === "active" && p.project_id === identity.project_id && p.repository_id === identity.repository_id, "INERT_PROJECT_BINDING");
    check(o.status === "active" && o.generation === identity.owner_generation && o.subject_id !== identity.writer_id, "INERT_OWNER_CHANGED");
    check(w.status === "active" && w.writer_id === identity.writer_id && w.generation === identity.writer_generation &&
      w.owner_generation === identity.owner_generation && ["instance_id", "run_id", "run_attempt", "repository_id", "workflow_path", "workflow_sha"].every(k => w[k] === identity[k]), "INERT_WRITER_CHANGED");
    check(sc.project_id === identity.project_id && sc.task_id === t.task_id && sc.task_digest === digest(json(t)) &&
      sc.owner_generation === o.generation && sc.writer_generation === w.generation && sc.action === "synthetic", "INERT_SCOPE_CHANGED");
    const now = Date.now(); check(Number.isSafeInteger(now) && epoch(sc.valid_from) <= now && now < epoch(sc.expires_at), "INERT_EXPIRED");
    check(d.status === "approved" && d.scope_digest === digest(json(sc)) && d.approver_id === o.subject_id && d.owner_generation === o.generation, "INERT_DECISION");
    check(wp.status === "released" && wp.decision_id === d.decision_id && wp.waitpoint_id !== d.decision_id && wp.scope_digest === d.scope_digest && wp.released_by === "synthetic:owning-workflow", "INERT_WAITPOINT");
    check(t.status === "ready" && dep.task_id === t.dependency_id && digest(json(dep)) === t.dependency_digest && dep.status === "completed" && dep.test_ref !== dep.review_ref, "INERT_DEPENDENCY");
  }
  function current(s, a, states) {
    gates(s); const r = s.values.reservation, l = s.values.lease;
    check(r && same(r.request, a.request) && same(r.identity, identity) && same(r.identity, a.identity) &&
      r.scope_digest === a.scope_digest && r.scope_digest === digest(json(s.values.scope)) && r.input_digest === a.input_digest &&
      r.input_digest === digest(json(s.values.task.input)) && r.fence === a.fence && r.units === s.values.scope.units, "INERT_RESERVATION_CHANGED");
    check(l.fence === r.fence && l.status === "held" && l.operation_id === r.request.operation_id && l.attempt_nonce === r.request.attempt_nonce && l.instance_id === identity.instance_id, "INERT_OLD_FENCE");
    check(states.includes(r.state), "INERT_NOT_REPLAYABLE"); return r;
  }
  function result(status, extra = {}) { return freeze({ status, effect_authority: false, execution_authorized: false, ...extra }); }
  async function publish(s, changes, action, validate) {
    check(!quarantined, "INERT_QUARANTINED"); if (validate) validate(s);
    const events = s.values.journal.events; check(events.length < 16, "INERT_JOURNAL_FULL");
    const writes = Object.entries(changes).map(([name,v]) => ({ key: K[name], content: json(v) }));
    const event = { sequence: events.length + 1, action, at: new Date(Date.now()).toISOString(), before_revision: s.revision,
      writes_digest: digest(json(writes)), previous_digest: events.length ? digest(json(events[events.length - 1])) : null };
    writes.push({ key: K.journal, content: json(envelope("journal", { events: [...events, event] })) });
    let prepared;
    try { prepared = await io.prepareBatch({ expected_revision: s.revision, writes, transaction_id: digest(json(event)).slice(7) }); }
    catch (e) { if (e.code === "REVISION_CONFLICT") return result("CONFLICT"); throw e; }
    // Latest gates and expected H are checked again after preparation, before CAS.
    const latest = await read();
    if (!same(latest.revision, s.revision)) return result("CONFLICT");
    if (validate) validate(latest);
    let publication;
    try { publication = await io.publishPrepared(prepared.handle); } catch (_) { publication = null; }
    if (publication && publication.status === "CONFLICT") return result("CONFLICT");
    if (!publication || publication.status !== "PUBLISHED" || publication.effect_authority !== false ||
      !publication.evidence || !same(publication.evidence.published_revision, { store_kind:"git", value:prepared.evidence.prepared_commit })) {
      quarantined = true;
      return result("UNKNOWN", { budget_held: true, recovery_required: true, prepared_commit: prepared.evidence.prepared_commit });
    }
    return result("PUBLISHED", { revision: publication.evidence.published_revision });
  }
  async function reserve(input) {
    const req = request(input), s = await read(); gates(s); const v = s.values;
    check(req.task_id === v.task.task_id, "INERT_TASK_BINDING");
    if (v.reservation) {
      check(same(v.reservation.request, req), "INERT_SINGLE_OPERATION");
      current(s, v.reservation, ["RESERVED"]);
      check(issued.get(digest(json(req))) === v.reservation.fence, "INERT_RECOVERY_REQUIRED");
      return result("REVALIDATED", { handle:handle(v.reservation) });
    }
    check(v.budget.limit - v.budget.held >= v.scope.units && v.lease.status === "idle" && v.lease.fence < 1000000, "INERT_BUDGET_OR_LEASE");
    const a = envelope("reservation", { request:req, identity, input:clone(v.task.input), input_digest:digest(json(v.task.input)),
      scope_digest:digest(json(v.scope)), fence:v.lease.fence + 1, units:v.scope.units, state:"RESERVED", reserved_at:new Date(Date.now()).toISOString() });
    const out = await publish(s, { reservation:a, replay:envelope("replay", { request_digest:digest(json(req)), instance_id:identity.instance_id }),
      budget:{ ...v.budget, held:v.scope.units }, lease:{ ...v.lease, fence:a.fence, operation_id:req.operation_id,
        attempt_nonce:req.attempt_nonce, instance_id:identity.instance_id, status:"held" } }, "reserve", gates);
    return out.status === "PUBLISHED" ? result("PUBLISHED", { revision:out.revision, handle:handle(a) }) : out;
  }
  async function revalidate(h) { const a = bound(h), s = await read(); current(s, a, ["RESERVED", "DISPATCHING", "ACKNOWLEDGED"]); return result("REVALIDATED", { revision:s.revision }); }
  async function claimDispatch(h) {
    const a = bound(h), s = await read(), r = current(s, a, ["RESERVED"]);
    const out = await publish(s, { reservation:{ ...r, state:"DISPATCHING" } }, "dispatch", x => current(x,a,["RESERVED"]));
    return out.status === "PUBLISHED" ? result("PUBLISHED", { payload:{ schema_version:1, kind:"inert-runtime-input-v1", effect_authority:false,
      project_id:identity.project_id, operation_id:r.request.operation_id, attempt_nonce:r.request.attempt_nonce, runtime_ref:"synthetic:fixed-port", input:r.input } }) : out;
  }
  async function markUnknown(h) {
    const a = bound(h), s = await read(), r = s.values.reservation;
    check(r && same(r.request,a.request) && same(r.identity,a.identity) && r.fence === a.fence, "INERT_RESERVATION_CHANGED");
    check(["DISPATCHING","ACKNOWLEDGED","REVOKED","UNKNOWN"].includes(r.state), "INERT_UNKNOWN_STATE");
    if (r.state === "UNKNOWN") return result("UNKNOWN", { budget_held:true, recovery_required:true });
    const out = await publish(s, { reservation:{...r,state:"UNKNOWN"} }, "unknown", null);
    return result("UNKNOWN", { budget_held:true, recovery_required:true, recorded:out.status === "PUBLISHED" });
  }
  async function acknowledge(h, input) {
    const a = bound(h); let ack;
    try {
      ack = freeze(clone(input)); validateAck(ack);
      check(ack.project_id === identity.project_id && ack.operation_id === a.request.operation_id && ack.attempt_nonce === a.request.attempt_nonce, "INERT_ACK_BINDING");
    } catch (_) { return markUnknown(h); }
    const s = await read(), r = current(s,a,["DISPATCHING"]), model = operationModel(r,ack,new Date(Date.now()).toISOString());
    return publish(s, { reservation:{...r,state:"ACKNOWLEDGED"}, ack:model }, "ack", x => current(x,a,["DISPATCHING"]));
  }
  async function acceptOutcome(h, candidateInput, reviewInput) {
    const a = bound(h), candidate = freeze(clone(candidateInput)), review = freeze(clone(reviewInput));
    validateCandidate(candidate); validateReview(review,candidate);
    const s = await read(), r = current(s,a,["ACKNOWLEDGED"]), v = s.values;
    check(candidate.operation_id === r.request.operation_id && candidate.attempt_nonce === r.request.attempt_nonce &&
      candidate.ack_digest === digest(json(v.ack.runtime_ack)) && candidate.content_digest === r.input_digest && candidate.actual_units <= r.units &&
      review.reviewer_id !== identity.writer_id && review.reviewer_id !== identity.instance_id, "INERT_OUTCOME_BINDING");
    const outcome = envelope("outcome", { candidate,review,accepted_at:new Date(Date.now()).toISOString() });
    // Conservative prototype accounting: spent is settled WITHIN held ceiling.
    // No release/refund/reuse API exists, including after an uncertain commit.
    // Canonical Task is never among the write set.
    return publish(s, { reservation:{...r,state:"COMPLETED"}, outcome,
      ack:operationModel(r,v.ack.runtime_ack,v.ack.events[0].at,outcome), budget:{...v.budget,spent:candidate.actual_units} },
    "outcome", x => current(x,a,["ACKNOWLEDGED"]));
  }
  async function revoke(h) {
    const a = bound(h), s = await read(), r = s.values.reservation, v = s.values;
    check(r && same(r.request,a.request) && same(r.identity,a.identity) && r.fence === a.fence, "INERT_RESERVATION_CHANGED");
    check(!["COMPLETED","REVOKED","UNKNOWN"].includes(r.state), "INERT_NOT_REVOCABLE");
    check(v.owner.generation === a.identity.owner_generation && v.writer.writer_id === a.identity.writer_id &&
      v.writer.generation === a.identity.writer_generation && v.writer.owner_generation === a.identity.owner_generation &&
      ["instance_id","run_id","run_attempt","repository_id","workflow_path","workflow_sha"].every(k => v.writer[k] === a.identity[k]) &&
      v.lease.fence === a.fence && v.lease.operation_id === a.request.operation_id &&
      v.lease.attempt_nonce === a.request.attempt_nonce && v.lease.instance_id === a.identity.instance_id &&
      v.lease.status === "held", "INERT_REVOKE_OWNERSHIP_CHANGED");
    integer(v.lease.fence + 1,1); integer(v.writer.generation + 1,1);
    return publish(s, { reservation:{...r,state:"REVOKED"}, lease:{...v.lease,fence:v.lease.fence + 1,status:"revoked"},
      writer:{...v.writer,generation:v.writer.generation + 1,status:"revoked"} }, "revoke", null);
  }
  const api = Object.freeze({ reserve,revalidate,claimDispatch,acknowledge,acceptOutcome,revoke,markUnknown,
    effect_authority:false, evidence_level:"SYNTHETIC_ONLY" }); brands.add(api); return api;
}
module.exports = Object.freeze({ createInertAdmissionPrototype, isInertAdmissionPrototype:value => brands.has(value), INERT_KEYS:K });
