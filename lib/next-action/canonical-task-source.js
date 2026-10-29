"use strict";

// Read-only canonical Task source for the advisory selector. No Task service,
// recovery, authority mutation, or capability claim is used here.
// Git is the only current store with a repository-wide snapshot revision.
// Filesystem per-file digests must not be mislabeled as that snapshot.
const TASK_ID = /^T-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TASKS = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const TASK_STATES = new Set(["draft", "active", "blocked", "completed", "canceled"]);

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function nonempty(value) {
  return typeof value === "string" && !!value.trim() && !/[\r\n\0]/.test(value);
}
function sameRevision(actual, expected) {
  // Store RevisionToken has no domain; an explicitly supplied domain must agree.
  return !!actual && actual.store_kind === "git" && actual.value === expected.value
    && (actual.domain === undefined || actual.domain === expected.domain);
}
function fault(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function requireTaskId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value) || value.includes("..")) {
    throw fault("ERR_ADVISOR_TASK_ID");
  }
  return value;
}

/**
 * The caller owns selection of the already-bound store/project. Binding strings
 * are provenance labels, never owner/lease attestations. Unknown authorization
 * fields remain absent until a separately reviewed canonical scope mapper exists.
 */
function readCanonicalTaskSource(options = {}) {
  const { store, project_ref, governance_binding_ref, observed_at, expected_revision } = options;
  const maxAge = options.max_age_seconds == null ? 300 : options.max_age_seconds;
  if (!/^project:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project_ref || "")
      || !nonempty(governance_binding_ref)
      || typeof observed_at !== "string"
      || !Number.isFinite(Date.parse(observed_at))
      || new Date(observed_at).toISOString() !== observed_at
      || !Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 86400) {
    throw fault("ERR_ADVISOR_SOURCE_OPTIONS");
  }
  if (!expected_revision || expected_revision.domain !== "governance_store"
      || expected_revision.store_kind !== "git"
      || !/^[0-9a-f]{40}$/.test(expected_revision.value || "")) {
    throw fault("ERR_ADVISOR_SNAPSHOT_REVISION");
  }
  const revision = {
    domain: "governance_store", store_kind: "git", value: expected_revision.value,
  };
  const base = {
    project_ref, source_ref: governance_binding_ref + "#tasks",
    origin_ref: "adapter:canonical-git-task-reader-v1",
    revision, observed_at, max_age_seconds: maxAge,
    execution_authorized: false,
  };
  const result = (status, records, reason_codes, receipts = []) => freeze({
    ...base, status, records, reason_codes, read_receipts: receipts,
  });
  if (!store || (store.kind !== undefined && store.kind !== "git")
      || typeof store.readText !== "function"
      || typeof store.getRevision !== "function") {
    return result("unavailable", [], ["repository_snapshot_reader_unavailable"]);
  }
  const receipts = [];
  function checkHead() {
    if (!sameRevision(store.getRevision(), revision)) throw fault("ERR_ADVISOR_SNAPSHOT_CHANGED");
  }
  function readJson(key) {
    checkHead();
    const read = store.readText(key, { required: true });
    if (!read || read.ok !== true || read.exists !== true
        || !sameRevision(read.revision, revision)) throw fault("ERR_ADVISOR_SNAPSHOT_CHANGED");
    if (typeof read.content !== "string"
        || Buffer.byteLength(read.content, "utf8") > MAX_FILE_BYTES) {
      throw fault("ERR_ADVISOR_SOURCE_TOO_LARGE");
    }
    const value = JSON.parse(read.content);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw fault("ERR_ADVISOR_SOURCE_SHAPE");
    }
    checkHead();
    receipts.push({ key, revision: { ...revision }, blob: read.blob || null });
    return value;
  }
  try {
    checkHead();
    let ids = options.task_ids;
    if (ids == null) {
      const index = readJson("tasks/index.json");
      if (!Array.isArray(index.tasks) || index.tasks.length > MAX_TASKS) {
        throw fault("ERR_ADVISOR_TASK_INDEX");
      }
      ids = index.tasks.map((entry) => {
        const id = requireTaskId(entry && entry.task_id);
        if (entry.path !== ".agent/tasks/" + id + ".json") throw fault("ERR_ADVISOR_TASK_INDEX_PATH");
        return id;
      });
    }
    if (!Array.isArray(ids) || ids.length > MAX_TASKS) throw fault("ERR_ADVISOR_TASK_LIMIT");
    ids = ids.map(requireTaskId);
    if (new Set(ids).size !== ids.length) throw fault("ERR_ADVISOR_DUPLICATE_TASK");
    const records = ids.map((id) => {
      const key = "tasks/" + id + ".json";
      const task = readJson(key);
      if (task.task_id !== id || !TASK_STATES.has(task.status)) throw fault("ERR_ADVISOR_TASK_SHAPE");
      if (!Array.isArray(task.dependencies)) throw fault("ERR_ADVISOR_TASK_DEPENDENCIES");
      const dependencies = task.dependencies.map(requireTaskId);
      if (new Set(dependencies).size !== dependencies.length || dependencies.includes(id)) {
        throw fault("ERR_ADVISOR_TASK_DEPENDENCIES");
      }
      if (task.validation_commands !== undefined
          && (!Array.isArray(task.validation_commands) || !task.validation_commands.every(nonempty))) {
        throw fault("ERR_ADVISOR_TASK_VALIDATION_COMMANDS");
      }
      const tests = task.validation_commands === undefined ? [] : task.validation_commands.slice();
      return {
        project_ref, governance_revision: { ...revision }, task_ref: id,
        source_ref: governance_binding_ref + "@" + revision.value + ":" + key,
        status: task.status === "canceled" ? "cancelled" : task.status,
        priority: ["P0", "P1", "P2", "P3"].includes(task.priority) ? task.priority : null,
        owner_ref: nonempty(task.owner) ? task.owner : null,
        dependencies, validation_plan: { tests },
        // Canonical Task v1 has no authority scope, digest, budget, Host grant
        // or verified completion receipt. Do not copy similarly named extras.
        mission_ref: null, verification_status: null,
      };
    });
    checkHead();
    return result("observed", records, ["canonical_scope_artifact_not_mapped"], receipts);
  } catch (error) {
    const changed = error && error.code === "ERR_ADVISOR_SNAPSHOT_CHANGED";
    return result(changed ? "conflict" : "unavailable", [],
      [changed ? "governance_snapshot_changed" : "canonical_task_read_failed"], receipts);
  }
}

module.exports = { readCanonicalTaskSource };
