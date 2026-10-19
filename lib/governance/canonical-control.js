"use strict";

// Unactivated canonical controller. Public methods accept opaque handles from
// the fixed platform-source singleton composed by the protected entry, never
// caller-supplied authority JSON. Constructor dependencies are trusted code:
// supplying arbitrary JavaScript does NOT establish authentication. The entry
// must import the pinned source/store directly, with no caller-selectable loader.
// Installation/Owner schema adoption and first initialization require the
// separate deployment approval. The default platform source is unconfigured.
// This controller changes canonical control state only. It cannot issue a
// runtime permit, lease, dispatch, Host call, or physical-effect authorization.
// Client expiry observations are not a GitHub server-side hard expiry fence.
// The remote authority ref must have the independently approved exclusive-writer
// and protected-deployment trust boundary. Hashes validate data integrity, not
// authorship against an administrator able to rewrite the entire ref/history.
const R = require("./canonical-records");
const schemas = require("./canonical-control.schema.json").$defs;
const decisionSchema = require("../../templates/_shared/.agent/decisions/decision.schema.json");
const waitpointSchema = require("../../templates/_shared/.agent/waitpoints/waitpoint.schema.json");
const decisionIndexSchema = require("../../templates/_shared/.agent/decisions/index.schema.json");
const waitpointIndexSchema = require("../../templates/_shared/.agent/waitpoints/index.schema.json");
const taskSchema = require("../../templates/_shared/.agent/tasks/task.schema.json");
const { inspectGitHubSelection } = require("./github-selection");
const { check, clone, parse, stable, digest, freeze, epoch, validate, record, json } = R;
const P = Object.freeze({ identity: "control/identity.json", owner: "control/owner.json",
  registration: "control/project.json", manifest: "control/manifest.json",
  bootstrap: "control/bootstrap.json", journal: "control/journal.json",
  decisions: "decisions/index.json", waitpoints: "waitpoints/index.json" });
const FIXED = Object.freeze([P.identity, P.owner, P.registration, P.manifest, P.bootstrap, P.journal]);
const ACTIONS = Object.freeze({ approve: "approved", reject: "rejected", request_revision: "revision_requested" });
const CONTROL_OPERATIONS = ["bootstrap", "resolve_decision", "release_waitpoint", "revoke_owner"];
function eq(a, b) { return stable(a) === stable(b); }
function ref(key) { return ".agent/" + key; }
function unref(value) {
  check(typeof value === "string" && value.startsWith(".agent/control/audit/"), "CONTROL_AUDIT_REFERENCE");
  return safeKey(value.slice(7));
}
function safeKey(value) {
  check(typeof value === "string" && value.length <= 240 &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value) &&
    value.split("/").every(p => p.length <= 80 && p !== "." && p !== ".." && !p.endsWith(".lock")), "CONTROL_PATH");
  return value;
}
function decisionKey(id) { check(/^D-[A-Za-z0-9][A-Za-z0-9._-]{0,125}$/.test(id), "CONTROL_ID"); return safeKey("decisions/" + id + ".json"); }
function waitpointKey(id) { check(/^WP-[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/.test(id), "CONTROL_ID"); return safeKey("waitpoints/" + id + ".json"); }
function taskKey(id) { check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/.test(id), "CONTROL_ID"); return safeKey("tasks/" + id + ".json"); }
function validRevision(value, nullable = false) {
  if (nullable && value === null) return;
  check(value && eq(Object.keys(value).sort(), ["store_kind", "value"]) &&
    value.store_kind === "git" && /^[a-f0-9]{40}$/.test(value.value) && !/^0+$/.test(value.value), "CONTROL_REVISION");
}
function content(snapshot, key) {
  check(Object.hasOwn(snapshot.records, key), "CONTROL_INCOMPLETE_SNAPSHOT");
  const r = snapshot.records[key]; check(r && typeof r.content === "string", "CONTROL_RECORD_MISSING");
  check(r.sha256 === digest(r.content).slice(7) || r.sha256 === digest(r.content), "CONTROL_RECORD_DIGEST");
  return r.content;
}
function value(snapshot, key, schema) { const text = content(snapshot, key); return schema ? record(schema, text) : parse(text); }
function missing(snapshot, keys) {
  for (const k of keys) check(Object.hasOwn(snapshot.records, k) && snapshot.records[k] === null, "CONTROL_REPLAY_OR_EXISTING_RECORD");
}
function sourcePath(data) { return "control/sources/" + digest(json(data)).slice(7) + ".json"; }
function auditPath(action, project, op, base) {
  return "control/audit/" + digest(stable({ version: 1, action, project, op, base })).slice(7) + ".json";
}
function replayKeys(f, c) {
  return {
    run_key: digest(stable({ version: 1, repository_id: f.governance_repository.id, run_id: c.run_id })),
    selection_key: digest(stable({ version: 1, project_id: f.project_id, repository_id: f.governance_repository.id,
      revision: f.governance_repository.revision, resource_ref: f.resource_ref, resource_digest: f.resource_digest,
      decision_id: f.decision_id, decision_digest: f.decision_digest, operation_id: f.operation_id,
      frozen_digest: digest(stable(f)) }))
  };
}
function replayPaths(keys) { return ["control/replay/runs/" + keys.run_key.slice(7) + ".json",
  "control/replay/selections/" + keys.selection_key.slice(7) + ".json"]; }
function narrowContext(c) {
  const out = {};
  for (const k of Object.keys(schemas.audit.properties.context.properties)) out[k] = c[k];
  return validate(schemas.audit.properties.context, out);
}
function readSource(source, handle, kind) {
  const data = clone(source.resolve(handle));
  check(data.kind === kind, "CONTROL_SOURCE_KIND");
  check(/^sha256:[a-f0-9]{64}$/.test(data.manifest_digest), "CONTROL_SOURCE_MANIFEST");
  narrowContext(data.context);
  check(data.context.run_attempt === 1 && data.context.event_name === "workflow_dispatch", "CONTROL_SOURCE_ATTEMPT");
  return data;
}
function indexNext(current, kind, resource, key) {
  const field = kind === "decision" ? "decisions" : "waitpoints";
  const id = kind + "_id";
  const schema = kind === "decision" ? decisionIndexSchema : waitpointIndexSchema;
  validate(schema, current);
  check(new Set(current[field].map(v => v[id])).size === current[field].length, "CONTROL_AMBIGUOUS_INDEX");
  check(current[field].filter(v => v[id] === resource[id]).length === 1, "CONTROL_INDEX_BINDING");
  const row = { [id]: resource[id], path: ref(key), status: resource.status,
    gate_action: resource.gate.action, resource_ref: resource.gate.resource_ref, updated_at: resource.updated_at };
  if (kind === "decision") row.type = resource.type;
  else { row.owner_workflow = resource.owner_workflow; row.decision_id = resource.decision_id; }
  return validate(schema, { [field]: current[field].map(v => v[id] === resource[id] ? row : v) });
}
function verifyIndex(index, kind, resource, key) {
  const field = kind === "decision" ? "decisions" : "waitpoints", id = kind + "_id";
  validate(kind === "decision" ? decisionIndexSchema : waitpointIndexSchema, index);
  check(new Set(index[field].map(v => v[id])).size === index[field].length, "CONTROL_AMBIGUOUS_INDEX");
  const rows = index[field].filter(v => v[id] === resource[id]);
  check(rows.length === 1 && rows[0].path === ref(key) && rows[0].status === resource.status &&
    rows[0].gate_action === resource.gate.action && rows[0].resource_ref === resource.gate.resource_ref &&
    rows[0].updated_at === resource.updated_at && (kind === "decision" ? rows[0].type === resource.type :
      rows[0].owner_workflow === resource.owner_workflow && rows[0].decision_id === resource.decision_id),
  "CONTROL_INDEX_BINDING");
}
function sameRelations(a, b) {
  return ["task_ids", "mission_ids"].every(k => eq([...a[k]].sort(), [...b[k]].sort()));
}
function checkAt(at, lower, upper) {
  check(Number.isFinite(epoch(at)) && Number.isFinite(epoch(lower)) && Number.isFinite(epoch(upper)) &&
    epoch(lower) <= epoch(at) && epoch(at) < epoch(upper), "CONTROL_EXPIRED_OR_INVALID_TIME");
}
function initialSchema(key, obj) {
  if (/^decisions\/D-[A-Za-z0-9_.-]+\.json$/.test(key) && key !== P.decisions) {
    validate(decisionSchema, obj); check(key === decisionKey(obj.decision_id) && obj.status === "open", "CONTROL_INITIAL_DECISION");
    check(obj.relations.artifact_refs.every(r => !r.startsWith(".agent/control/")), "CONTROL_INITIAL_AUDIT");
  } else if (/^waitpoints\/WP-[A-Za-z0-9_.-]+\.json$/.test(key) && key !== P.waitpoints) {
    validate(waitpointSchema, obj); check(key === waitpointKey(obj.waitpoint_id) &&
      ["pending", "blocked"].includes(obj.status) && obj.released_by == null && obj.released_at == null, "CONTROL_INITIAL_WAITPOINT");
  } else if (key === P.decisions) validate(decisionIndexSchema, obj);
  else if (key === P.waitpoints) validate(waitpointIndexSchema, obj);
  else if (/^scopes\/[A-Za-z0-9_-]+\.json$/.test(key)) validate(schemas.scope, obj);
  else if (/^tasks\/[A-Za-z0-9_.-]+\.json$/.test(key)) {
    validate(taskSchema, obj); check(key === taskKey(obj.task_id), "CONTROL_INITIAL_TASK");
  } else check(false, "CONTROL_INITIAL_PATH_FORBIDDEN");
}
function validateInitial(m) {
  check(Array.isArray(m.initial_records) && m.initial_records.length >= 3 && m.initial_records.length <= 16, "CONTROL_INITIAL_RECORDS");
  const records = new Map();
  for (const row of m.initial_records) {
    check(eq(Object.keys(row).sort(), ["content", "key", "sha256"]), "CONTROL_INITIAL_RECORDS");
    safeKey(row.key); check(!records.has(row.key) && digest(row.content) === row.sha256, "CONTROL_INITIAL_DIGEST");
    const obj = parse(row.content); initialSchema(row.key, obj); records.set(row.key, obj);
  }
  check(records.has(P.decisions) && records.has(P.waitpoints), "CONTROL_INITIAL_INDEX");
  for (const [key, obj] of records) {
    if (obj.decision_id && key.startsWith("decisions/")) verifyIndex(records.get(P.decisions), "decision", obj, key);
    if (obj.waitpoint_id && key.startsWith("waitpoints/")) verifyIndex(records.get(P.waitpoints), "waitpoint", obj, key);
    if (key.startsWith("scopes/")) {
      check(new Set(obj.dependencies.map(d => d.task_id)).size === obj.dependencies.length, "CONTROL_INITIAL_DEPENDENCY");
      for (const id of obj.task_ids) check(records.has(taskKey(id)), "CONTROL_INITIAL_TASK");
      for (const dependency of obj.dependencies) check(records.has(taskKey(dependency.task_id)) &&
        m.initial_records.find(r => r.key === taskKey(dependency.task_id)).sha256 === dependency.digest, "CONTROL_INITIAL_DEPENDENCY");
      check(obj.project_id === m.project_id && obj.owner_generation === 1 && obj.owner_workflow === m.owner_workflow, "CONTROL_INITIAL_SCOPE");
      const d = records.get(decisionKey(obj.decision_id)), w = records.get(waitpointKey(obj.waitpoint_id));
      check(d && w && w.decision_id === d.decision_id && eq(d.gate, w.gate) &&
        d.gate.resource_ref === obj.resource_ref && w.owner_workflow === obj.owner_workflow &&
        sameRelations(d.relations, obj) && sameRelations(w.relations, obj), "CONTROL_INITIAL_SCOPE");
    }
  }
  for (const [field, kind] of [["decisions", "decision"], ["waitpoints", "waitpoint"]]) {
    for (const row of records.get(P[field])[field]) {
      const key = row.path.slice(7); check(records.has(key), "CONTROL_INITIAL_INDEX");
      verifyIndex(records.get(P[field]), kind, records.get(key), key);
    }
  }
  return records;
}
function canonicalRoot(snapshot, data, binding, at) {
  const registration = value(snapshot, P.registration, schemas.registration);
  const identity = value(snapshot, P.identity, schemas.identity);
  const owner = value(snapshot, P.owner, schemas.owner);
  const mText = content(snapshot, P.manifest), m = R.validateManifest(parse(mText));
  validateInitial(m);
  const boot = value(snapshot, P.bootstrap, schemas.bootstrap);
  const journal = value(snapshot, P.journal, schemas.journal);
  check(registration.project_id === identity.value && registration.project_id === owner.project_id &&
    registration.identity_ref === P.identity && owner.identity_ref === P.identity &&
    registration.owner_ref === P.owner && registration.bootstrap_ref === P.bootstrap &&
    owner.bootstrap.source_audit_ref === P.bootstrap, "OWNER_UNVERIFIED");
  check(registration.identity_digest === digest(content(snapshot, P.identity)) &&
    owner.identity_digest === registration.identity_digest && registration.owner_digest === digest(content(snapshot, P.owner)),
  "OWNER_UNVERIFIED");
  check(registration.manifest_digest === digest(stable(m)) && registration.manifest_digest === data.manifest_digest &&
    owner.bootstrap.manifest_digest === data.manifest_digest && boot.manifest_digest === data.manifest_digest &&
    boot.project_id === m.project_id && m.project_id === identity.value, "OWNER_UNVERIFIED");
  check(eq(registration.backend, owner.backend) && eq(owner.backend, m.backend) && eq(binding, m.backend), "CONTROL_BACKEND_BINDING");
  check(owner.status === "active" && owner.subject.provider === "github" && owner.subject.account_id === m.owner_account_id &&
    owner.subject.account_id === data.context.actor_id && data.context.actor_id === data.context.sender_id &&
    data.context.actor_id === data.context.triggering_actor_id, "OWNER_UNVERIFIED");
  check(eq(boot.deployment, data.deployment) && boot.context.repository_id === m.backend.repository_id &&
    data.context.repository_id === m.backend.repository_id && data.context.repository === m.backend.repository &&
    data.deployment.workflow_path === m.controller.workflow_path && data.deployment.ref === m.controller.ref &&
    data.deployment.source_bundle_digest === m.controller.source_bundle_digest, "CONTROL_DEPLOYMENT_BINDING");
  check(journal.project_id === identity.value && journal.sequence <= m.max_control_transactions, "CONTROL_TRANSACTION_LIMIT");
  checkAt(at, m.valid_from, m.expires_at);
  return { registration, identity, owner, manifest: m, bootstrap: boot, journal };
}
function auditBase(root, data, action, op, base, at, keys) {
  return { schema_version: 1, kind: "canonical-control-audit", project_id: root.manifest.project_id,
    sequence: root.journal ? root.journal.sequence + 1 : 1,
    previous_audit_ref: root.journal ? root.journal.audit_ref : null,
    previous_audit_digest: root.journal ? root.journal.audit_digest : null,
    action, operation_id: op, before_revision: base, source_ref: sourcePath(data), source_digest: digest(json(data)),
    owner_before_digest: root.owner ? digest(json(root.owner)) : null,
    owner_after_digest: root.owner ? digest(json(root.owner)) : root.genesis_owner_digest,
    subject: { provider: "github", account_id: root.manifest.owner_account_id },
    context: narrowContext(data.context), manifest_digest: data.manifest_digest,
    owner_generation: root.owner ? root.owner.generation : 1,
    decision_ref: null, decision_before_digest: null, decision_after_digest: null,
    waitpoint_ref: null, waitpoint_before_digest: null, waitpoint_after_digest: null,
    resource_ref: null, resource_digest: null, ...keys, observed_at: at,
    expiry_semantics: "CLIENT_OBSERVATION_ONLY_NOT_HARD_FENCE", execution_authorized: false, effect_permitted: false };
}
function auditWrites(audit, key) {
  validate(schemas.audit, audit);
  const body = json(audit);
  const journal = validate(schemas.journal, { schema_version: 1, kind: "canonical-control-journal-head",
    project_id: audit.project_id, sequence: audit.sequence, audit_ref: key, audit_digest: digest(body) });
  return [{ key, content: body }, { key: P.journal, content: json(journal) }];
}
function consumption(audit, key) {
  const row = validate(schemas.replay, { schema_version: 1, kind: "canonical-selection-consumption",
    project_id: audit.project_id, run_key: audit.run_key, selection_key: audit.selection_key,
    operation_id: audit.operation_id, decision_id: audit.decision_ref ? audit.decision_ref.slice(10, -5) : null, audit_ref: key });
  return replayPaths(audit).map(path => ({ key: path, content: json(row) }));
}
function createCanonicalControl({ store, platformSource } = {}) {
  check(platformSource && typeof platformSource.resolve === "function", "CONTROL_SOURCE_REQUIRED");
  const source = Object.freeze({ resolve: platformSource.resolve.bind(platformSource) });
  check(store && ["readSnapshot", "prepareBatch", "publishPrepared"].every(k => typeof store[k] === "function"), "CONTROL_STORE_REQUIRED");
  // The bound backend is trusted controller configuration, never a CLI input.
  const binding = clone(store.binding);
  validate(schemas.owner.properties.backend, binding);
  let quarantined = false;
  const read = async keys => {
    check(!quarantined, "CONTROL_QUARANTINED");
    const s = await store.readSnapshot([...new Set(keys)]);
    validRevision(s.revision, true); check(s.records && typeof s.records === "object", "CONTROL_SNAPSHOT");
    return s;
  };
  async function publish(snapshot, writes, id, validity) {
    check(!quarantined, "CONTROL_QUARANTINED");
    const currentTime = () => { for (const [from, until] of validity) checkAt(new Date().toISOString(), from, until); };
    currentTime();
    const prepared = await store.prepareBatch({ expected_revision: snapshot.revision, writes, transaction_id: id });
    const p = clone(prepared.evidence);
    // Preserve the candidate before the only publication attempt. This receipt
    // contains hashes/IDs only, never record bytes, platform inputs or credentials.
    check(/^[a-f0-9]{40}$/.test(p.prepared_commit) && !/^0+$/.test(p.prepared_commit) &&
      /^[a-f0-9]{40}$/.test(p.prepared_tree) && !/^0+$/.test(p.prepared_tree), "CONTROL_PREPARED_CANDIDATE");
    const receipt = { repository_id: binding.repository_id, ref: binding.authority_ref,
      transaction_id: id, base_revision: snapshot.revision, prepared_commit: p.prepared_commit,
      prepared_tree: p.prepared_tree, writes_sha256: digest(JSON.stringify(writes)).slice(7),
      effect_authority: false };
    for (const key of ["repository_id", "transaction_id", "base_revision", "writes_sha256"])
      if (Object.hasOwn(p, key)) check(eq(p[key], receipt[key]), "CONTROL_PREPARED_RECEIPT");
    // The fixture local Git primitive owns a different local ref; only the
    // production remote adapter supplies repository_id and the authority ref.
    if (Object.hasOwn(p, "repository_id")) check(p.ref === receipt.ref, "CONTROL_PREPARED_RECEIPT");
    function safeResult(result) {
      check(result && ["PUBLISHED", "CONFLICT", "UNKNOWN"].includes(result.status), "CONTROL_PUBLISH_RESULT");
      const evidence = result.evidence ? clone(result.evidence) : {};
      for (const key of Object.keys(receipt)) if (Object.hasOwn(evidence, key))
        check(eq(evidence[key], receipt[key]) || (key === "ref" && !Object.hasOwn(evidence, "repository_id")),
          "CONTROL_PUBLISH_RECEIPT");
      const next = { ...receipt, publication: result.status };
      if (result.status === "PUBLISHED") {
        validRevision(evidence.published_revision);
        check(evidence.published_revision.value === receipt.prepared_commit, "CONTROL_PUBLISH_CANDIDATE");
        next.published_revision = evidence.published_revision;
      }
      if (Object.hasOwn(evidence, "observed_revision")) {
        validRevision(evidence.observed_revision, true); next.observed_revision = evidence.observed_revision;
      }
      for (const key of ["publish_attempted", "reconciled"])
        if (typeof evidence[key] === "boolean") next[key] = evidence[key];
      if (["DONE", "UNCONFIRMED"].includes(evidence.scratch_cleanup)) next.scratch_cleanup = evidence.scratch_cleanup;
      return next;
    }
    function output(status, next) {
      return freeze({ status, canonical_mutation: status === "PUBLISHED" ? true : status === "CONFLICT" ? false : null,
        execution_authorized: false, effect_permitted: false, evidence: { ...next, receipt: next } });
    }
    async function uncertain() {
      // Once publication is uncertain this instance can never write again,
      // including when one bounded read-only reconciliation proves publication.
      quarantined = true;
      if (typeof store.reconcilePrepared === "function") {
        try {
          const reconciled = safeResult(await store.reconcilePrepared(prepared.handle));
          if (reconciled.publication === "PUBLISHED")
            return output("PUBLISHED", { ...reconciled, reconciled: true });
        } catch (_) { /* Keep the original candidate receipt and UNKNOWN. */ }
      }
      return output("UNKNOWN", { ...receipt, publication: "UNKNOWN" });
    }
    currentTime();
    let result, next;
    try { result = await store.publishPrepared(prepared.handle); next = safeResult(result); }
    catch (_) { return uncertain(); }
    if (result.status === "UNKNOWN") return uncertain();
    return output(result.status, next);
  }
  async function bootstrap(handle) {
    const data = readSource(source, handle, "github-bootstrap-source-v1"), m = R.validateManifest(data.manifest);
    check(m.kind === "github-control-bootstrap" && m.schema_version === 1 && m.bootstrap_expected_revision === null &&
      m.max_initializations === 1 && eq(m.operations, CONTROL_OPERATIONS), "CONTROL_BOOTSTRAP_MANIFEST");
    check(data.request === "bootstrap", "CONTROL_SOURCE_REQUEST");
    check(Number.isSafeInteger(m.max_control_transactions) && m.max_control_transactions >= 2 && m.max_control_transactions <= 8, "CONTROL_TRANSACTION_LIMIT");
    check(m.project_id && m.owner_account_id === data.context.actor_id && data.action === "appoint_owner" &&
      data.context.actor_id === data.context.sender_id && data.context.actor_id === data.context.triggering_actor_id &&
      digest(stable(m)) === data.manifest_digest && eq(m.backend, binding), "CONTROL_BOOTSTRAP_BINDING");
    const at = new Date().toISOString(); checkAt(at, m.valid_from, m.expires_at);
    check(m.backend.repository_id === data.context.repository_id && m.backend.repository === data.context.repository &&
      m.controller.workflow_path === data.deployment.workflow_path && m.controller.ref === data.deployment.ref &&
      m.controller.source_bundle_digest === data.deployment.source_bundle_digest, "CONTROL_BOOTSTRAP_DEPLOYMENT");
    validateInitial(m);
    const keys = { run_key: digest(stable({ version: 1, repository_id: m.backend.repository_id, run_id: data.context.run_id })),
      selection_key: digest(stable({ version: 1, action: "appoint_owner", manifest_digest: data.manifest_digest })) };
    const op = "bootstrap-" + data.manifest_digest.slice(7, 39), aKey = auditPath("bootstrap", m.project_id, op, null);
    const initialKeys = m.initial_records.map(r => r.key);
    const s = await read([...FIXED, ...initialKeys, aKey, ...replayPaths(keys)]);
    check(s.revision === null, "CONTROL_BOOTSTRAP_ALREADY_INITIALIZED");
    missing(s, [...FIXED, ...initialKeys, aKey, ...replayPaths(keys)]);
    const identity = validate(schemas.identity, { kind: "project_id", value: m.project_id }), identityText = json(identity);
    const boot = validate(schemas.bootstrap, { schema_version: 1, kind: "canonical-owner-bootstrap-source", project_id: m.project_id,
      manifest_digest: data.manifest_digest, deployment: data.deployment, context: narrowContext(data.context),
      action: "appoint_owner", human_presence_verified: false });
    const owner = validate(schemas.owner, { schema_version: 1, kind: "project-owner-binding", project_id: m.project_id,
      identity_ref: P.identity, identity_digest: digest(identityText), subject: { provider: "github", account_id: m.owner_account_id },
      backend: m.backend, bootstrap: { manifest_digest: data.manifest_digest, source_audit_ref: P.bootstrap },
      status: "active", generation: 1, supersedes: null, role: "project_approver", execution_authorized: false });
    const ownerText = json(owner);
    const registration = validate(schemas.registration, { schema_version: 1, kind: "canonical-project-registration",
      project_id: m.project_id, identity_ref: P.identity, identity_digest: digest(identityText), owner_ref: P.owner,
      owner_digest: digest(ownerText), backend: m.backend, manifest_digest: data.manifest_digest, bootstrap_ref: P.bootstrap });
    const audit = { ...auditBase({ manifest: m, genesis_owner_digest: digest(ownerText) }, data, "bootstrap", op, null, at, keys),
      source_ref: P.bootstrap, source_digest: digest(json(boot)) };
    const writes = [
      { key: P.identity, content: identityText }, { key: P.owner, content: ownerText },
      { key: P.registration, content: json(registration) }, { key: P.manifest, content: json(m) },
      { key: P.bootstrap, content: json(boot) }, ...m.initial_records.map(r => ({ key: r.key, content: r.content })),
      ...auditWrites(audit, aKey), ...consumption(audit, aKey)
    ];
    return publish(s, writes, digest(stable({ action: "bootstrap", op })).slice(7), [[m.valid_from, m.expires_at]]);
  }
  async function augment(snapshot, keys) {
    const next = await read([...Object.keys(snapshot.records), ...keys]);
    check(eq(next.revision, snapshot.revision), "CONTROL_READ_CONFLICT");
    return next;
  }
  async function verifyChain(snapshot, root) {
    let s = snapshot, key = root.journal.audit_ref, expected = root.journal.audit_digest;
    const chain = [], seen = new Set(), eventKeys = [];
    while (key !== null) {
      check(chain.length < 8 && !seen.has(key), "CONTROL_AUDIT_CHAIN"); seen.add(key);
      safeKey(key); check(/^control\/audit\/[a-f0-9]{64}\.json$/.test(key), "CONTROL_AUDIT_CHAIN");
      s = await augment(s, [key]);
      const raw = content(s, key); check(digest(raw) === expected, "CONTROL_AUDIT_CHAIN");
      const a = record(schemas.audit, raw);
      check(a.project_id === root.identity.value && a.manifest_digest === root.registration.manifest_digest &&
        a.subject.account_id === root.manifest.owner_account_id && a.subject.provider === "github" &&
        a.context.actor_id === a.subject.account_id && a.context.sender_id === a.subject.account_id &&
        a.context.triggering_actor_id === a.subject.account_id,
      "CONTROL_AUDIT_CHAIN");
      if (a.action !== "bootstrap") {
        check(/^control\/sources\/[a-f0-9]{64}\.json$/.test(a.source_ref), "CONTROL_SOURCE_REFERENCE");
        s = await augment(s, [a.source_ref]);
        check(digest(content(s, a.source_ref)) === a.source_digest, "CONTROL_SOURCE_DIGEST");
        const original = parse(content(s, a.source_ref));
        check(original.manifest_digest === a.manifest_digest && eq(original.deployment, root.bootstrap.deployment) &&
          eq(narrowContext(original.context), a.context), "CONTROL_SOURCE_PROVENANCE");
      } else check(a.source_ref === P.bootstrap && a.source_digest === digest(content(s, P.bootstrap)), "CONTROL_BOOTSTRAP_PROVENANCE");
      chain.push(a); eventKeys.push(key); key = a.previous_audit_ref; expected = a.previous_audit_digest;
      check((key === null) === (expected === null), "CONTROL_AUDIT_CHAIN");
    }
    chain.reverse(); eventKeys.reverse();
    root.ownerAuditRef = eventKeys[0];
    const genesisOwner = { schema_version: 1, kind: "project-owner-binding", project_id: root.manifest.project_id,
      identity_ref: P.identity, identity_digest: root.registration.identity_digest,
      subject: { provider: "github", account_id: root.manifest.owner_account_id }, backend: root.manifest.backend,
      bootstrap: { manifest_digest: root.registration.manifest_digest, source_audit_ref: P.bootstrap },
      status: "active", generation: 1, supersedes: null, role: "project_approver", execution_authorized: false };
    check(chain.length === root.journal.sequence && chain[0].action === "bootstrap" && chain[0].sequence === 1 &&
      chain[0].owner_generation === 1 && chain[0].owner_before_digest === null &&
      chain[0].owner_after_digest === digest(json(genesisOwner)) &&
      chain[0].before_revision === null, "CONTROL_BOOTSTRAP_PROVENANCE");
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i], previous = chain[i - 1];
      check(a.sequence === i + 1 && a.action !== "bootstrap" && previous.action !== "revoke_owner" &&
        a.owner_before_digest === previous.owner_after_digest &&
        a.owner_generation === previous.owner_generation + (a.action === "revoke_owner" ? 1 : 0) &&
        a.before_revision !== null && epoch(a.observed_at) >= epoch(previous.observed_at),
      "CONTROL_AUDIT_CHAIN");
      if (a.action !== "revoke_owner") check(a.owner_after_digest === a.owner_before_digest, "CONTROL_OWNER_TRANSITION");
      else root.ownerAuditRef = eventKeys[i];
    }
    check(chain[chain.length - 1].owner_after_digest === digest(content(s, P.owner)) &&
      chain[chain.length - 1].owner_generation === root.owner.generation, "CONTROL_OWNER_HISTORY");
    return s;
  }
  async function selectionSnapshot(data, extra = []) {
    let first = await read([...FIXED, ...extra]);
    const at = new Date().toISOString(), root = canonicalRoot(first, data, binding, at);
    const release = data.kind === "github-waitpoint-release-source-v1";
    const project = release ? data.project_id : data.frozen.project_id;
    const resourceRef = release ? data.resource_ref : data.frozen.resource_ref;
    const resourceDigest = release ? data.resource_digest : data.frozen.resource_digest;
    const operation = release ? data.operation_id : data.frozen.operation_id;
    const templates = root.manifest.selections.filter(t => t.resource_ref === resourceRef && t.operation_id === operation);
    check(templates.length === 1, "CONTROL_RESOURCE_UNREGISTERED");
    const template = templates[0], dKey = decisionKey(template.decision_id), scopeKey = safeKey(template.resource_key);
    check(template.decision_key === dKey && project === root.identity.value, "CONTROL_SELECTION_BINDING");
    if (!release) {
      const f = data.frozen;
      check(f.decision_id === template.decision_id && f.operation === template.operation && eq(f.allowed_actions, template.allowed_actions) &&
        f.governance_repository.id === binding.repository_id && f.governance_repository.name === binding.repository &&
        eq(f.product_repository, root.manifest.product_repository), "CONTROL_SELECTION_BINDING");
      check(f.controller.workflow_path === data.deployment.workflow_path && f.controller.workflow_sha === data.deployment.workflow_sha &&
        f.controller.ref === data.deployment.ref && f.controller.script_digest === data.deployment.source_bundle_digest, "CONTROL_SELECTION_DEPLOYMENT");
    }
    const matches = root.manifest.initial_records.filter(r => r.key === scopeKey && r.sha256 === resourceDigest);
    check(matches.length === 1, "CONTROL_RESOURCE_UNREGISTERED");
    const scope = record(schemas.scope, matches[0].content), wKey = waitpointKey(scope.waitpoint_id);
    const keys = release ? {
      run_key: digest(stable({ version: 1, repository_id: binding.repository_id, run_id: data.context.run_id })),
      selection_key: digest(stable({ version: 1, action: "release_waitpoint", project_id: project,
        resource_ref: resourceRef, resource_digest: resourceDigest, operation_id: operation,
        decision_audit_ref: data.decision_audit_ref, decision_audit_digest: data.decision_audit_digest }))
    } : replayKeys(data.frozen, data.context);
    let more = await augment(first, [dKey, P.decisions, scopeKey, wKey, P.waitpoints,
      ...scope.dependencies.map(d => taskKey(d.task_id)), ...replayPaths(keys)]);
    check(content(more, scopeKey) === matches[0].content, "CONTROL_RESOURCE_CHANGED");
    more = await verifyChain(more, root);
    const latestAt = new Date().toISOString(), latestRoot = canonicalRoot(more, data, binding, latestAt);
    check(scope.project_id === latestRoot.identity.value && scope.decision_id === template.decision_id &&
      scope.owner_generation === latestRoot.owner.generation && scope.owner_workflow === latestRoot.manifest.owner_workflow, "CONTROL_SCOPE_BINDING");
    checkAt(latestAt, scope.valid_from, scope.expires_at);
    const d = value(more, dKey, decisionSchema), w = value(more, wKey, waitpointSchema);
    verifyIndex(value(more, P.decisions), "decision", d, dKey);
    verifyIndex(value(more, P.waitpoints), "waitpoint", w, wKey);
    check(w.decision_id === d.decision_id && eq(d.gate, w.gate) && d.gate.resource_ref === scope.resource_ref &&
      w.owner_workflow === scope.owner_workflow && sameRelations(d.relations, scope) && sameRelations(w.relations, scope), "CONTROL_GATE_BINDING");
    return { snapshot: more, root: latestRoot, scope, scopeKey, decision: d, dKey, waitpoint: w, wKey, keys, at: latestAt };
  }
  async function resolveDecision(handle) {
    const data = readSource(source, handle, "github-selection-source-v1");
    check(data.request === "resolve_decision", "CONTROL_SOURCE_REQUEST");
    const f = data.frozen, aKey = auditPath("resolve_decision", f.project_id, f.operation_id,
      { store_kind: "git", value: f.governance_repository.revision });
    const c = await selectionSnapshot(data, [aKey, sourcePath(data)]);
    check(c.snapshot.revision.value === f.governance_repository.revision, "CONTROL_REVISION_CONFLICT");
    missing(c.snapshot, [aKey, sourcePath(data), ...replayPaths(c.keys)]);
    check(c.root.journal.sequence < c.root.manifest.max_control_transactions - 1, "CONTROL_REVOCATION_SLOT_RESERVED");
    const evidence = inspectGitHubSelection({ selection: data.selection, frozen: f, context: data.context,
      canonical: { project_id: c.root.identity.value, revision: c.snapshot.revision.value, resource_ref: f.resource_ref,
        resource_content: content(c.snapshot, c.scopeKey), decision_id: f.decision_id, decision_content: content(c.snapshot, c.dKey),
        consumed_run_keys: [], consumed_selection_keys: [] } });
    check(eq(c.keys, { run_key: evidence.replay.run_key, selection_key: evidence.replay.selection_key }), "CONTROL_REPLAY_KEY_MISMATCH");
    check(c.decision.status === "open" && Object.hasOwn(ACTIONS, data.selection.action), "CONTROL_DECISION_NOT_OPEN");
    const next = validate(decisionSchema, { ...c.decision, status: ACTIONS[data.selection.action], selected_option: data.selection.action,
      resolved_by: "github:" + c.root.owner.subject.account_id, resolved_at: c.at, updated_at: c.at,
      rationale: "GitHub selection for frozen resource " + f.resource_digest,
      workflow_gate: "user", relations: { ...c.decision.relations,
        artifact_refs: [...c.decision.relations.artifact_refs, ref(aKey)] } });
    const nextText = json(next);
    const audit = { ...auditBase(c.root, data, "resolve_decision", f.operation_id, c.snapshot.revision, c.at, c.keys),
      decision_ref: c.dKey, decision_before_digest: digest(content(c.snapshot, c.dKey)), decision_after_digest: digest(nextText),
      resource_ref: f.resource_ref, resource_digest: f.resource_digest };
    const writes = [{ key: c.dKey, content: nextText }, { key: P.decisions,
      content: json(indexNext(value(c.snapshot, P.decisions), "decision", next, c.dKey)) },
      { key: audit.source_ref, content: json(data) }, ...auditWrites(audit, aKey), ...consumption(audit, aKey)];
    return publish(c.snapshot, writes, digest(stable({ action: "resolve_decision", audit: aKey })).slice(7),
      [[c.root.manifest.valid_from, c.root.manifest.expires_at], [c.scope.valid_from, c.scope.expires_at]]);
  }
  async function releaseOwningWaitpoint(handle) {
    const data = readSource(source, handle, "github-waitpoint-release-source-v1");
    check(data.request === "release_waitpoint" && data.action === "release_waitpoint", "CONTROL_SOURCE_REQUEST");
    const expectedRevision = { store_kind: "git", value: data.expected_revision }; validRevision(expectedRevision);
    const priorKey = safeKey(data.decision_audit_ref);
    check(/^control\/audit\/[a-f0-9]{64}\.json$/.test(priorKey), "CONTROL_AUDIT_REFERENCE");
    const aKey = auditPath("release_waitpoint", data.project_id, data.operation_id, expectedRevision);
    let c = await selectionSnapshot(data, [priorKey, aKey, sourcePath(data)]);
    check(eq(c.snapshot.revision, expectedRevision), "CONTROL_REVISION_CONFLICT");
    check(c.root.journal.sequence < c.root.manifest.max_control_transactions - 1, "CONTROL_REVOCATION_SLOT_RESERVED");
    missing(c.snapshot, [aKey, sourcePath(data), ...replayPaths(c.keys)]);
    const priorText = content(c.snapshot, priorKey), prior = record(schemas.audit, priorText);
    check(digest(priorText) === data.decision_audit_digest && prior.action === "resolve_decision" &&
      prior.project_id === data.project_id && prior.operation_id === data.operation_id &&
      prior.manifest_digest === data.manifest_digest && prior.decision_ref === c.dKey &&
      prior.decision_after_digest === digest(content(c.snapshot, c.dKey)) &&
      prior.resource_ref === data.resource_ref && prior.resource_digest === data.resource_digest &&
      prior.owner_generation === c.root.owner.generation && c.decision.relations.artifact_refs.includes(ref(priorKey)),
    "CONTROL_DECISION_PROVENANCE");
    const linked = c.decision.relations.artifact_refs.filter(r => /^\.agent\/control\/audit\/[a-f0-9]{64}\.json$/.test(r));
    check(linked.length === 1 && unref(linked[0]) === priorKey, "CONTROL_AMBIGUOUS_DECISION_AUDIT");
    c.snapshot = await augment(c.snapshot, [prior.source_ref, ...replayPaths(prior)]);
    const sourceText = content(c.snapshot, prior.source_ref);
    check(digest(sourceText) === prior.source_digest, "CONTROL_SOURCE_DIGEST");
    const original = parse(sourceText);
    check(original.kind === "github-selection-source-v1" && original.request === "resolve_decision" &&
      original.selection.action === "approve" && original.manifest_digest === data.manifest_digest &&
      original.frozen.resource_digest === data.resource_digest && original.frozen.operation_id === data.operation_id &&
      original.frozen.decision_id === c.decision.decision_id &&
      original.frozen.decision_digest === prior.decision_before_digest && eq(original.deployment, data.deployment),
    "CONTROL_DECISION_PROVENANCE");
    const oldKeys = replayKeys(original.frozen, original.context);
    check(oldKeys.run_key === prior.run_key && oldKeys.selection_key === prior.selection_key, "CONTROL_REPLAY_PROVENANCE");
    for (const key of replayPaths(oldKeys)) {
      const consumed = value(c.snapshot, key, schemas.replay);
      check(consumed.audit_ref === priorKey && consumed.run_key === oldKeys.run_key &&
        consumed.selection_key === oldKeys.selection_key && consumed.operation_id === data.operation_id &&
        consumed.decision_id === c.decision.decision_id, "CONTROL_REPLAY_PROVENANCE");
    }
    check(c.decision.status === "approved" && c.decision.selected_option === "approve" &&
      c.decision.resolved_by === "github:" + c.root.owner.subject.account_id &&
      ["pending", "blocked"].includes(c.waitpoint.status), "CONTROL_WAITPOINT_NOT_RELEASABLE");
    const at = new Date().toISOString(); canonicalRoot(c.snapshot, data, binding, at);
    check(Number.isFinite(epoch(c.decision.resolved_at)) && epoch(c.decision.resolved_at) <= epoch(at), "CONTROL_DECISION_TIME");
    checkAt(at, c.scope.valid_from, c.scope.expires_at);
    if (c.waitpoint.expires_at !== null && c.waitpoint.expires_at !== undefined)
      check(Number.isFinite(epoch(c.waitpoint.expires_at)) && epoch(at) < epoch(c.waitpoint.expires_at), "CONTROL_WAITPOINT_EXPIRED");
    for (const dependency of c.scope.dependencies) {
      const key = taskKey(dependency.task_id), text = content(c.snapshot, key), task = record(taskSchema, text);
      check(digest(text) === dependency.digest && task.task_id === dependency.task_id &&
        task.status === "completed" && task.stage === "done" &&
        task.gates.length > 0 && task.gates.every(g => g.status === "passed" && g.evidence_refs.length > 0) &&
        ["validation", "review"].every(kind => task.artifacts.some(a => a.kind === kind && a.status === "final")), "CONTROL_DEPENDENCY_UNACCEPTED");
    }
    const next = validate(waitpointSchema, { ...c.waitpoint, status: "released", updated_at: at,
      released_at: at, released_by: "workflow:" + c.scope.owner_workflow,
      workflow_gate: "owner", release_note: "Owning workflow revalidated canonical control state; no runtime permit.",
      evidence_refs: [...new Set([...c.waitpoint.evidence_refs, ref(c.dKey), ref(priorKey), ref(aKey)])] });
    const nextText = json(next);
    const audit = { ...auditBase(c.root, data, "release_waitpoint", data.operation_id, c.snapshot.revision, at, c.keys),
      decision_ref: c.dKey, decision_before_digest: digest(content(c.snapshot, c.dKey)),
      decision_after_digest: digest(content(c.snapshot, c.dKey)), waitpoint_ref: c.wKey,
      waitpoint_before_digest: digest(content(c.snapshot, c.wKey)), waitpoint_after_digest: digest(nextText),
      resource_ref: data.resource_ref, resource_digest: data.resource_digest };
    const writes = [{ key: c.wKey, content: nextText }, { key: P.waitpoints,
      content: json(indexNext(value(c.snapshot, P.waitpoints), "waitpoint", next, c.wKey)) },
      { key: audit.source_ref, content: json(data) }, ...auditWrites(audit, aKey), ...consumption(audit, aKey)];
    const validity = [[c.root.manifest.valid_from, c.root.manifest.expires_at], [c.scope.valid_from, c.scope.expires_at]];
    if (c.waitpoint.expires_at != null) validity.push([c.scope.valid_from, c.waitpoint.expires_at]);
    return publish(c.snapshot, writes, digest(stable({ action: "release_waitpoint", audit: aKey })).slice(7), validity);
  }
  async function revokeOwner(handle) {
    const data = readSource(source, handle, "github-owner-revocation-source-v1");
    check(data.request === "revoke_owner" && data.action === "revoke_owner", "CONTROL_SOURCE_REQUEST");
    const expectedRevision = { store_kind: "git", value: data.expected_revision }; validRevision(expectedRevision);
    const keys = { run_key: digest(stable({ version: 1, repository_id: binding.repository_id, run_id: data.context.run_id })),
      selection_key: digest(stable({ version: 1, action: "revoke_owner", project_id: data.project_id,
        manifest_digest: data.manifest_digest, expected_owner_generation: data.expected_owner_generation })) };
    const aKey = auditPath("revoke_owner", data.project_id, data.operation_id, expectedRevision);
    let s = await read([...FIXED, aKey, sourcePath(data), ...replayPaths(keys)]);
    check(eq(s.revision, expectedRevision), "CONTROL_REVISION_CONFLICT");
    const at = new Date().toISOString(), root = canonicalRoot(s, data, binding, at);
    check(data.project_id === root.identity.value && data.expected_owner_generation === root.owner.generation &&
      data.operation_id === "revoke-owner:" + data.project_id &&
      root.journal.sequence < root.manifest.max_control_transactions, "CONTROL_REVOCATION_BINDING");
    s = await verifyChain(s, root); missing(s, [aKey, sourcePath(data), ...replayPaths(keys)]);
    const owner = validate(schemas.owner, { ...root.owner, status: "revoked",
      generation: root.owner.generation + 1, supersedes: root.ownerAuditRef });
    const ownerText = json(owner), registration = validate(schemas.registration, {
      ...root.registration, owner_digest: digest(ownerText) });
    const audit = { ...auditBase(root, data, "revoke_owner", data.operation_id, s.revision, at, keys),
      owner_generation: owner.generation, owner_after_digest: digest(ownerText) };
    const writes = [{ key: P.owner, content: ownerText }, { key: P.registration, content: json(registration) },
      { key: audit.source_ref, content: json(data) }, ...auditWrites(audit, aKey), ...consumption(audit, aKey)];
    return publish(s, writes, digest(stable({ action: "revoke_owner", audit: aKey })).slice(7),
      [[root.manifest.valid_from, root.manifest.expires_at]]);
  }
  return Object.freeze({ bootstrap, resolveDecision, releaseOwningWaitpoint, revokeOwner });
}
module.exports = Object.freeze({ createCanonicalControl });
