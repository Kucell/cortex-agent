"use strict";

// Bounded, same-commit canonical plan/Mission/pair observation. The store has
// only read APIs; no workflow, repair, approval, Host, or dispatch code is loaded.
const { validateAdvisoryPlan, planPath, planResource, iso, sha256 } = require("./advisory-plan.js");
const { validCanonicalRecord } = require("./canonical-pair.js");
const MAX_ENTRIES = 512, MAX_PLANS = 32, MAX_PAIRS = 128;
const MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const PLAN_PATH = /^missions\/(M-[A-Za-z0-9][A-Za-z0-9._-]{0,95})\/advisory-plans\/(AP-[A-Za-z0-9][A-Za-z0-9._-]{0,95})\.json$/;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function same(actual, expected) {
  return !!actual && actual.store_kind === "git" && actual.value === expected.value
    && (actual.domain === undefined || actual.domain === "governance_store");
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function readCanonicalPlanSources(options) {
  const { store, project_ref, governance_binding_ref, observed_at, expected_revision, tasks } = options || {};
  if (!/^project:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project_ref || "")
      || typeof governance_binding_ref !== "string" || !governance_binding_ref
      || iso(observed_at) === null || !expected_revision || expected_revision.domain !== "governance_store"
      || expected_revision.store_kind !== "git" || !/^[0-9a-f]{40}$/.test(expected_revision.value || "")
      || !tasks || tasks.status !== "observed" || !Array.isArray(tasks.records)) fail("ERR_ADVISOR_PLAN_OPTIONS");
  const revision = { ...expected_revision }, now = iso(observed_at), receipts = [];
  let usedBytes = 0;
  const base = { project_ref, revision, observed_at, max_age_seconds: 300,
    origin_ref: "adapter:canonical-git-advisory-plan-v1", execution_authorized: false };
  function source(name, status, records, codes) {
    return { ...base, source_ref: governance_binding_ref + "#" + name, status, records, reason_codes: codes };
  }
  function result(status, codes, rows = tasks.records, missions = [], decisions = [], waitpoints = []) {
    return freeze({
      status, reason_codes: codes, read_receipts: receipts,
      tasks: { ...tasks, records: rows, reason_codes: status === "observed"
        ? [rows.every((row) => row.canonical_plan) ? "canonical_advisory_scope_mapped" : "canonical_advisory_scope_partially_mapped"]
        : tasks.reason_codes },
      missions: source("missions", status, missions, codes),
      decisions: source("decisions", status, decisions, codes),
      waitpoints: source("waitpoints", status, waitpoints, codes),
      execution_authorized: false,
    });
  }
  if (!store || store.kind !== "git" || typeof store.listEntries !== "function"
      || typeof store.readText !== "function" || typeof store.getRevision !== "function") {
    return result("unavailable", ["canonical_plan_snapshot_reader_unavailable"]);
  }
  function check() {
    if (!same(store.getRevision(), revision)) fail("ERR_ADVISOR_SNAPSHOT_CHANGED");
  }
  function enumerate(namespace) {
    check();
    const read = store.listEntries(namespace, { max_entries: MAX_ENTRIES });
    if (!read || !same(read.revision, revision) || !Array.isArray(read.entries)) fail("ERR_ADVISOR_SNAPSHOT_CHANGED");
    if (read.entries.length > MAX_ENTRIES) fail("ERR_ADVISOR_PLAN_NAMESPACE_LIMIT");
    const keys = new Set();
    for (const entry of read.entries) {
      if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)
          || typeof entry.key !== "string" || !entry.key.startsWith(namespace + "/")
          || entry.key.includes("..") || /[\u0000-\u001f\u007f\\]/.test(entry.key)
          || entry.key.length > 1024 || !/^[0-9a-f]{40}$/.test(entry.blob || "") || keys.has(entry.key)) fail("ERR_ADVISOR_PLAN_NAMESPACE_NODE");
      keys.add(entry.key);
    }
    check();
    return read.entries;
  }
  function readJson(entry) {
    check();
    const remaining = MAX_TOTAL_BYTES - usedBytes;
    if (remaining <= 0) fail("ERR_ADVISOR_PLAN_TOTAL_BYTES");
    const read = store.readText(entry.key, { required: true, max_bytes: Math.min(MAX_FILE_BYTES, remaining) });
    if (!read || read.ok !== true || read.exists !== true || !same(read.revision, revision)
        || read.blob !== entry.blob) fail("ERR_ADVISOR_SNAPSHOT_CHANGED");
    if (typeof read.content !== "string") fail("ERR_ADVISOR_PLAN_SOURCE");
    const size = Buffer.byteLength(read.content, "utf8");
    if (size > MAX_FILE_BYTES || size > remaining) fail("ERR_ADVISOR_PLAN_TOTAL_BYTES");
    usedBytes += size;
    const value = JSON.parse(read.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("ERR_ADVISOR_PLAN_SOURCE");
    const digest = sha256(read.content);
    check();
    const source_ref = governance_binding_ref + "@" + revision.value + ":" + entry.key + "#sha256:" + digest;
    receipts.push({ key: entry.key, revision: { ...revision }, blob: entry.blob, sha256: digest, bytes: size });
    return { value, digest, source_ref };
  }
  try {
    check();
    const taskIds = new Set(tasks.records.map((row) => row.task_ref));
    if (tasks.project_ref !== project_ref || tasks.revision?.domain !== "governance_store" || !same(tasks.revision, revision)
        || taskIds.size !== tasks.records.length || tasks.records.some((row) => row.project_ref !== project_ref
        || !same(row.governance_revision, revision))) fail("ERR_ADVISOR_PLAN_TASK_LINK");
    const missionEntries = enumerate("missions"), byKey = new Map(missionEntries.map((entry) => [entry.key, entry]));
    const planEntries = missionEntries.filter((entry) => entry.key.includes("/advisory-plans/"));
    if (planEntries.length > MAX_PLANS) fail("ERR_ADVISOR_PLAN_LIMIT");
    if (!planEntries.length) return result("not_observed", ["canonical_advisory_plan_not_observed"]);
    const plans = [];
    for (const entry of planEntries) {
      const match = PLAN_PATH.exec(entry.key);
      if (!match) fail("ERR_ADVISOR_PLAN_PATH");
      const read = readJson(entry), plan = validateAdvisoryPlan(read.value);
      if (planPath(plan) !== entry.key || plan.mission_id !== match[1] || plan.plan_id !== match[2]
          || "project:" + plan.project_id !== project_ref) fail("ERR_ADVISOR_PLAN_BINDING");
      // A task filter limits projection, not namespace validation. Foreign or
      // malformed committed plans cannot be hidden behind a selected Task.
      if (!taskIds.has(plan.task_id)) continue;
      const task = tasks.records.find((row) => row.task_ref === plan.task_id);
      const taskReceipts = (Array.isArray(tasks.read_receipts) ? tasks.read_receipts : [])
        .filter((receipt) => receipt.key === plan.task_source.path);
      if (taskReceipts.length !== 1 || taskReceipts[0].revision?.domain !== "governance_store"
          || !same(taskReceipts[0].revision, revision)
          || !/^[0-9a-f]{40}$/.test(taskReceipts[0].blob || "")
          || taskReceipts[0].blob !== plan.task_source.git_blob) fail("ERR_ADVISOR_TASK_VERSION_CONFLICT");
      const taskTests = task.validation_plan && task.validation_plan.tests;
      if (!Array.isArray(taskTests) || taskTests.length
          && JSON.stringify(taskTests) !== JSON.stringify(plan.validation_commands)) fail("ERR_ADVISOR_TASK_VALIDATION_CONFLICT");
      const contractEntry = byKey.get(plan.mission_contract.path);
      if (!contractEntry) fail("ERR_ADVISOR_MISSION_CONTRACT_MISSING");
      const contractRead = readJson(contractEntry), contract = contractRead.value;
      if (contractRead.digest !== plan.mission_contract.sha256 || contract.schema_version !== 2
          || contract.mission_id !== plan.mission_id || iso(contract.generated_at) === null
          || iso(contract.generated_at) > now || !contract.states || typeof contract.states !== "object"
          || Array.isArray(contract.states) || !Array.isArray(contract.milestones) || !Array.isArray(contract.gates)) {
        fail("ERR_ADVISOR_MISSION_IDENTITY");
      }
      plans.push({ plan, path: entry.key, digest: read.digest, source_ref: read.source_ref,
        resource_ref: planResource(entry.key, read.digest), mission_source_ref: contractRead.source_ref });
    }
    const selected = new Map();
    for (const id of taskIds) {
      const matching = plans.filter((item) => item.plan.task_id === id);
      const active = matching.filter((item) => iso(item.plan.created_at) <= now && iso(item.plan.expires_at) > now);
      if (active.length > 1 || !active.length && matching.length > 1) fail("ERR_ADVISOR_PLAN_AMBIGUOUS");
      if (active.length === 1) selected.set(id, active[0]);
      else if (matching.length === 1) selected.set(id, matching[0]);
    }
    if (!selected.size) return result("not_observed", ["canonical_advisory_plan_not_observed_for_selected_tasks"]);
    function pairRows(namespace, prefix, kind) {
      const entries = enumerate(namespace), rows = [];
      const pattern = new RegExp("^" + namespace + "/" + prefix + "-[A-Za-z0-9][A-Za-z0-9._-]*\\.json$");
      for (const entry of entries) {
        if (["index.json", "index.schema.json", kind + ".schema.json", "README.md"].some((name) => entry.key === namespace + "/" + name)) continue;
        if (!pattern.test(entry.key)) fail("ERR_ADVISOR_PAIR_NAMESPACE_PATH");
        if (rows.length >= MAX_PAIRS) fail("ERR_ADVISOR_PAIR_LIMIT");
        const read = readJson(entry), record = read.value;
        if (!validCanonicalRecord(kind, record)
            || entry.key !== namespace + "/" + record[kind + "_id"] + ".json") fail("ERR_ADVISOR_PAIR_SCHEMA");
        rows.push({ project_ref, governance_revision: { ...revision }, source_ref: read.source_ref,
          canonical_record: record });
      }
      return rows;
    }
    const decisions = pairRows("decisions", "D", "decision");
    const waitpoints = pairRows("waitpoints", "WP", "waitpoint");
    const missions = new Map();
    const rows = tasks.records.map((row) => {
      const item = selected.get(row.task_ref);
      if (!item) return row;
      const p = item.plan;
      missions.set(p.mission_id, { project_ref, governance_revision: { ...revision }, mission_ref: p.mission_id,
        source_ref: item.mission_source_ref, identity_only: true, verification_status: null });
      return { ...row, mission_ref: p.mission_id,
        scope: { repository: p.scope.repository, branch: p.scope.branch, allowed_paths: p.scope.allowed_paths.slice(),
          allowed_operations: p.scope.allowed_operations.slice(), declared_product_commit: p.scope.product_commit },
        risk_tier: p.risk_tier, validation_plan: { tests: p.validation_commands.slice() },
        estimated_budget: { ...p.estimated_budget, source_ref: item.source_ref, reservation_observed: false },
        required_host_capabilities: p.required_host_capabilities.slice(), stop_conditions: p.stop_conditions.slice(),
        expires_at: p.expires_at, approval_resource_ref: item.resource_ref, plan_digest: item.digest,
        gate_action: p.approval.action,
        canonical_plan: { contract: "canonical-advisory-plan-v1", path: item.path, sha256: item.digest,
          resource_ref: item.resource_ref, created_at: p.created_at, expires_at: p.expires_at,
          task_source: { ...p.task_source }, task_source_ref: row.source_ref + "#git-blob:" + p.task_source.git_blob,
          ...p.approval, pair_namespace_complete: true, source_ref: item.source_ref },
      };
    });
    check();
    return result("observed", ["canonical_identity_scope_and_pair_records_observed"], rows, [...missions.values()], decisions, waitpoints);
  } catch (error) {
    const changed = error && error.code === "ERR_ADVISOR_SNAPSHOT_CHANGED";
    const conflict = changed || error && ["ERR_ADVISOR_PLAN_AMBIGUOUS", "ERR_ADVISOR_TASK_VERSION_CONFLICT",
      "ERR_ADVISOR_TASK_VALIDATION_CONFLICT"].includes(error.code);
    return result(conflict ? "conflict" : "unavailable", [changed ? "governance_snapshot_changed"
      : /^ERR_ADVISOR_/.test(error && error.code || "") ? error.code : "canonical_plan_read_failed"]);
  }
}

module.exports = Object.freeze({ readCanonicalPlanSources });
