"use strict";

const PERMISSION_OUTCOMES = Object.freeze([
  "allow",
  "deny",
  "approval_required",
]);

const PERMISSION_IDS = Object.freeze([
  "filesystem.read",
  "filesystem.write",
  "git.read",
  "git.commit",
  "git.push",
  "process.spawn",
  "network.connect",
  "secrets.read",
]);

const ROOT_KEYS = new Set(["filesystem", "git", "process", "network", "secrets"]);
const FS_KEYS = new Set(["read", "write"]);
const GIT_KEYS = new Set(["read", "commit", "push"]);
const PROCESS_KEYS = new Set(["spawn"]);
const NETWORK_KEYS = new Set(["allow"]);
const SECRET_KEYS = new Set(["read"]);

class ExtensionPermissionError extends Error {
  constructor(code, details = {}) {
    super(`[extension-permission:${code}] ${JSON.stringify(details)}`);
    this.name = "ExtensionPermissionError";
    this.code = code;
    this.details = details;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value, known, where) {
  for (const key of Object.keys(value || {})) {
    if (!known.has(key)) {
      throw new ExtensionPermissionError("ERR_PERMISSION_FIELD_UNKNOWN", { where, key });
    }
  }
}

function normalizeStringList(value, where) {
  if (value == null) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new ExtensionPermissionError("ERR_PERMISSION_SCOPE_LIST", { where });
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string" || !raw.trim() || /[\r\n]/.test(raw)) {
      throw new ExtensionPermissionError("ERR_PERMISSION_SCOPE", { where, value: raw });
    }
    const item = raw.trim();
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return Object.freeze(out);
}

function bool(value, where) {
  if (value == null) return false;
  if (typeof value !== "boolean") {
    throw new ExtensionPermissionError("ERR_PERMISSION_BOOLEAN", { where });
  }
  return value;
}

function objectSection(value, keys, where) {
  if (value == null) return {};
  if (!plain(value)) {
    throw new ExtensionPermissionError("ERR_PERMISSION_SECTION", { where });
  }
  rejectUnknown(value, keys, where);
  return value;
}

function normalizePermissions(input) {
  if (input == null) input = {};
  if (!plain(input)) {
    throw new ExtensionPermissionError("ERR_PERMISSIONS_INVALID", {});
  }
  rejectUnknown(input, ROOT_KEYS, "permissions");

  const fs = objectSection(input.filesystem, FS_KEYS, "permissions.filesystem");
  const git = objectSection(input.git, GIT_KEYS, "permissions.git");
  const process = objectSection(input.process, PROCESS_KEYS, "permissions.process");
  const network = objectSection(input.network, NETWORK_KEYS, "permissions.network");
  const secrets = objectSection(input.secrets, SECRET_KEYS, "permissions.secrets");

  return Object.freeze({
    filesystem: Object.freeze({
      read: normalizeStringList(fs.read, "permissions.filesystem.read"),
      write: normalizeStringList(fs.write, "permissions.filesystem.write"),
    }),
    git: Object.freeze({
      read: bool(git.read, "permissions.git.read"),
      commit: bool(git.commit, "permissions.git.commit"),
      push: bool(git.push, "permissions.git.push"),
    }),
    process: Object.freeze({
      spawn: bool(process.spawn, "permissions.process.spawn"),
    }),
    network: Object.freeze({
      allow: normalizeStringList(network.allow, "permissions.network.allow"),
    }),
    secrets: Object.freeze({
      read: normalizeStringList(secrets.read, "permissions.secrets.read"),
    }),
  });
}

function flattenPermissionRequests(permissionsInput) {
  const permissions = normalizePermissions(permissionsInput);
  const out = [];
  for (const scope of permissions.filesystem.read) {
    out.push({ permission: "filesystem.read", scope });
  }
  for (const scope of permissions.filesystem.write) {
    out.push({ permission: "filesystem.write", scope });
  }
  for (const id of ["read", "commit", "push"]) {
    if (permissions.git[id]) out.push({ permission: `git.${id}`, scope: null });
  }
  if (permissions.process.spawn) {
    out.push({ permission: "process.spawn", scope: null });
  }
  for (const scope of permissions.network.allow) {
    out.push({ permission: "network.connect", scope });
  }
  for (const scope of permissions.secrets.read) {
    out.push({ permission: "secrets.read", scope });
  }
  return Object.freeze(out.map((item) => Object.freeze(item)));
}

function normalizePolicy(input) {
  if (!plain(input)) {
    throw new ExtensionPermissionError("ERR_PERMISSION_POLICY_INVALID", {});
  }
  const allowed = new Set(["default", "rules"]);
  rejectUnknown(input, allowed, "policy");
  const defaultEffect = input.default || "deny";
  if (!PERMISSION_OUTCOMES.includes(defaultEffect)) {
    throw new ExtensionPermissionError("ERR_PERMISSION_OUTCOME", { effect: defaultEffect });
  }
  if (!Array.isArray(input.rules || [])) {
    throw new ExtensionPermissionError("ERR_PERMISSION_RULES", {});
  }
  const rules = (input.rules || []).map((rule, index) => {
    if (!plain(rule)) {
      throw new ExtensionPermissionError("ERR_PERMISSION_RULE", { index });
    }
    rejectUnknown(rule, new Set(["permission", "effect", "scopes"]), `policy.rules[${index}]`);
    if (!PERMISSION_IDS.includes(rule.permission)) {
      throw new ExtensionPermissionError("ERR_PERMISSION_ID", {
        index,
        permission: rule.permission,
      });
    }
    if (!PERMISSION_OUTCOMES.includes(rule.effect)) {
      throw new ExtensionPermissionError("ERR_PERMISSION_OUTCOME", {
        index,
        effect: rule.effect,
      });
    }
    return Object.freeze({
      permission: rule.permission,
      effect: rule.effect,
      scopes: normalizeStringList(rule.scopes, `policy.rules[${index}].scopes`),
    });
  });
  return Object.freeze({
    default: defaultEffect,
    rules: Object.freeze(rules),
  });
}

function ruleEffect(request, policy) {
  const matching = policy.rules.filter((rule) => rule.permission === request.permission);
  if (matching.length === 0) return policy.default;

  if (request.scope !== null) {
    const exact = matching.find((rule) => rule.scopes.includes(request.scope));
    if (exact) return exact.effect;
    const wildcard = matching.find((rule) => rule.scopes.includes("*"));
    if (wildcard) return wildcard.effect;
    const unscoped = matching.find((rule) => rule.scopes.length === 0);
    return unscoped ? unscoped.effect : policy.default;
  }

  const unscoped = matching.find((rule) => rule.scopes.length === 0);
  return unscoped ? unscoped.effect : matching[0].effect;
}

function evaluatePermissions(permissionsInput, policyInput) {
  const requests = flattenPermissionRequests(permissionsInput);
  const policy = normalizePolicy(policyInput);
  const decisions = requests.map((request) => Object.freeze({
    ...request,
    outcome: ruleEffect(request, policy),
  }));

  let outcome = "allow";
  if (decisions.some((item) => item.outcome === "deny")) outcome = "deny";
  else if (decisions.some((item) => item.outcome === "approval_required")) {
    outcome = "approval_required";
  }

  return Object.freeze({
    outcome,
    requests,
    decisions: Object.freeze(decisions),
    enforcement: Object.freeze({
      claimed: false,
      note: "policy evaluation is not a sandbox; enforcement belongs to the controlled boundary",
    }),
  });
}

module.exports = {
  PERMISSION_OUTCOMES,
  PERMISSION_IDS,
  ExtensionPermissionError,
  normalizePermissions,
  flattenPermissionRequests,
  normalizePolicy,
  evaluatePermissions,
};
