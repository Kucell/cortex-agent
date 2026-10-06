"use strict";

const GOVERNANCE_STORE_KINDS = Object.freeze(["filesystem", "git"]);
const STATE_CLASSES = Object.freeze(["durable", "derived", "ephemeral"]);
const EXECUTION_WORKSPACE_KINDS = Object.freeze([
  "local-worktree",
  "git-remote",
  "cloud-sandbox",
  "composite",
]);
const REBIND_TRANSACTION_STATES = Object.freeze([
  "prepare",
  "copy",
  "verify",
  "freeze-old-authority",
  "flip-canonical-binding",
  "verify-new-authority",
  "archive-old-source",
  "completed",
  "rolled-back",
]);

class GovernanceContractError extends Error {
  constructor(code, details = {}) {
    super(`[governance-contract:${code}] ${JSON.stringify(details)}`);
    this.name = "GovernanceContractError";
    this.code = code;
    this.details = details;
  }
}

class RevisionConflict extends Error {
  constructor({ expected, actual, resource = null } = {}) {
    super(`[governance-revision-conflict] expected=${expected || "unknown"} actual=${actual || "unknown"}`);
    this.name = "RevisionConflict";
    this.code = "ERR_GOVERNANCE_REVISION_CONFLICT";
    this.expected = expected || null;
    this.actual = actual || null;
    this.resource = resource;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, where) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new GovernanceContractError("ERR_GOVERNANCE_FIELD_INVALID", { where });
  }
  return value.trim();
}

function optionalString(value, where) {
  if (value == null) return null;
  return requiredString(value, where);
}

function normalizeGovernanceBinding(input) {
  if (input == null) return null;
  if (!plain(input)) {
    throw new GovernanceContractError("ERR_GOVERNANCE_BINDING_INVALID");
  }
  const known = new Set(["kind", "locator", "ref"]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new GovernanceContractError("ERR_GOVERNANCE_FIELD_UNKNOWN", {
        where: "governance",
        key,
      });
    }
  }
  const kind = requiredString(input.kind, "governance.kind");
  if (!GOVERNANCE_STORE_KINDS.includes(kind)) {
    throw new GovernanceContractError("ERR_GOVERNANCE_STORE_KIND", { kind });
  }
  const locator = requiredString(input.locator, "governance.locator");
  if (kind === "filesystem") {
    const normalized = locator.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
      throw new GovernanceContractError("ERR_GOVERNANCE_FILESYSTEM_LOCATOR", { locator });
    }
  }
  return Object.freeze({
    kind,
    locator,
    ref: optionalString(input.ref, "governance.ref"),
  });
}

function normalizeGovernanceStoreCapabilities(input = {}) {
  if (!plain(input)) {
    throw new GovernanceContractError("ERR_GOVERNANCE_CAPABILITIES_INVALID");
  }
  const flags = [
    "read",
    "write",
    "compare_and_write",
    "append",
    "history",
    "watch",
  ];
  const result = {};
  for (const flag of flags) result[flag] = input[flag] === true;
  return Object.freeze(result);
}

function normalizeExecutionWorkspaceIdentity(input) {
  if (!plain(input)) {
    throw new GovernanceContractError("ERR_EXECUTION_WORKSPACE_INVALID");
  }
  const kind = requiredString(input.kind, "workspace.kind");
  if (!EXECUTION_WORKSPACE_KINDS.includes(kind)) {
    throw new GovernanceContractError("ERR_EXECUTION_WORKSPACE_KIND", { kind });
  }
  const value = {
    kind,
    workspace_id: requiredString(input.workspace_id, "workspace.workspace_id"),
    repository_id: optionalString(input.repository_id, "workspace.repository_id"),
    branch: optionalString(input.branch, "workspace.branch"),
    base_revision: optionalString(input.base_revision, "workspace.base_revision"),
    head_revision: optionalString(input.head_revision, "workspace.head_revision"),
    change_request: optionalString(input.change_request, "workspace.change_request"),
    worktree_path: optionalString(input.worktree_path, "workspace.worktree_path"),
    task_id: optionalString(input.task_id, "workspace.task_id"),
    mission_id: optionalString(input.mission_id, "workspace.mission_id"),
    session_id: optionalString(input.session_id, "workspace.session_id"),
  };
  if (kind === "local-worktree" && !value.worktree_path) {
    throw new GovernanceContractError("ERR_EXECUTION_WORKSPACE_LOCAL_PATH_REQUIRED");
  }
  if (kind === "git-remote" && (!value.repository_id || !value.branch)) {
    throw new GovernanceContractError("ERR_EXECUTION_WORKSPACE_REMOTE_IDENTITY_REQUIRED");
  }
  return Object.freeze(value);
}

function normalizeStateClass(value) {
  const result = requiredString(value, "state_class");
  if (!STATE_CLASSES.includes(result)) {
    throw new GovernanceContractError("ERR_STATE_CLASS_INVALID", { value: result });
  }
  return result;
}

function createRevisionToken({ store_kind, value } = {}) {
  const kind = requiredString(store_kind, "revision.store_kind");
  const revision = requiredString(value, "revision.value");
  return Object.freeze({ store_kind: kind, value: revision });
}

function normalizeGovernanceLockClaim(input) {
  if (!plain(input)) throw new GovernanceContractError("ERR_GOVERNANCE_LOCK_INVALID");
  return Object.freeze({
    lock_id: requiredString(input.lock_id, "lock.lock_id"),
    owner_id: requiredString(input.owner_id, "lock.owner_id"),
    resource_ref: requiredString(input.resource_ref, "lock.resource_ref"),
    revision: optionalString(input.revision, "lock.revision"),
  });
}

function normalizeRuntimeResourceLease(input) {
  if (!plain(input)) throw new GovernanceContractError("ERR_RUNTIME_LEASE_INVALID");
  return Object.freeze({
    lease_id: requiredString(input.lease_id, "lease.lease_id"),
    owner_id: requiredString(input.owner_id, "lease.owner_id"),
    resource: requiredString(input.resource, "lease.resource"),
    host_id: requiredString(input.host_id, "lease.host_id"),
    expires_at: optionalString(input.expires_at, "lease.expires_at"),
  });
}

module.exports = {
  GOVERNANCE_STORE_KINDS,
  STATE_CLASSES,
  EXECUTION_WORKSPACE_KINDS,
  REBIND_TRANSACTION_STATES,
  GovernanceContractError,
  RevisionConflict,
  normalizeGovernanceBinding,
  normalizeGovernanceStoreCapabilities,
  normalizeExecutionWorkspaceIdentity,
  normalizeStateClass,
  createRevisionToken,
  normalizeGovernanceLockClaim,
  normalizeRuntimeResourceLease,
};
