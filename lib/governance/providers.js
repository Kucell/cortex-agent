"use strict";

const PROVIDER_KINDS = Object.freeze([
  "generic-git",
  "github",
  "gitlab",
  "gitee",
]);

const PROVIDER_CAPABILITIES = Object.freeze([
  "repository.resolve",
  "branch.resolve",
  "revision.read",
  "branch.create",
  "object.read",
  "conditional-write",
  "change-request.read",
  "checks.read",
  "identity.read",
]);

const BASE_GIT_CAPABILITIES = Object.freeze([
  "repository.resolve",
  "branch.resolve",
  "revision.read",
  "branch.create",
  "object.read",
  "conditional-write",
]);

const PROVIDER_CAPABILITY_MATRIX = Object.freeze({
  "generic-git": Object.freeze([...BASE_GIT_CAPABILITIES]),
  github: Object.freeze([
    ...BASE_GIT_CAPABILITIES,
    "change-request.read",
    "checks.read",
    "identity.read",
  ]),
  gitlab: Object.freeze([
    ...BASE_GIT_CAPABILITIES,
    "change-request.read",
    "checks.read",
    "identity.read",
  ]),
  gitee: Object.freeze([
    ...BASE_GIT_CAPABILITIES,
    "change-request.read",
    "checks.read",
    "identity.read",
  ]),
});

class ProviderContractError extends Error {
  constructor(code, details = {}) {
    super(`[remote-git-provider:${code}] ${JSON.stringify(details)}`);
    this.name = "ProviderContractError";
    this.code = code;
    this.details = details;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, where) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new ProviderContractError("ERR_PROVIDER_FIELD_INVALID", { where });
  }
  return value.trim();
}

function optionalString(value, where) {
  if (value == null) return null;
  return requiredString(value, where);
}

function normalizeProviderKind(value) {
  const kind = requiredString(value, "provider.kind");
  if (!PROVIDER_KINDS.includes(kind)) {
    throw new ProviderContractError("ERR_PROVIDER_KIND_UNSUPPORTED", {
      kind,
      supported: PROVIDER_KINDS,
    });
  }
  return kind;
}

function normalizeProviderLocator(input) {
  if (!plain(input)) {
    throw new ProviderContractError("ERR_PROVIDER_LOCATOR_INVALID");
  }
  const kind = normalizeProviderKind(input.kind);
  const repository = requiredString(input.repository, "provider.repository");
  const ref = optionalString(input.ref, "provider.ref");
  return Object.freeze({ kind, repository, ref });
}

function providerCapabilities(kind) {
  const normalized = normalizeProviderKind(kind);
  return PROVIDER_CAPABILITY_MATRIX[normalized];
}

function hasProviderCapability(kind, capability) {
  if (!PROVIDER_CAPABILITIES.includes(capability)) return false;
  return providerCapabilities(kind).includes(capability);
}

function requireProviderCapability(kind, capability) {
  if (!PROVIDER_CAPABILITIES.includes(capability)) {
    throw new ProviderContractError("ERR_PROVIDER_CAPABILITY_UNKNOWN", { capability });
  }
  if (!hasProviderCapability(kind, capability)) {
    throw new ProviderContractError("ERR_PROVIDER_CAPABILITY_UNSUPPORTED", {
      kind: normalizeProviderKind(kind),
      capability,
    });
  }
  return true;
}

function normalizeChangeRequest(input) {
  if (!plain(input)) throw new ProviderContractError("ERR_CHANGE_REQUEST_INVALID");
  return Object.freeze({
    id: requiredString(input.id, "change_request.id"),
    provider: normalizeProviderKind(input.provider),
    repository: requiredString(input.repository, "change_request.repository"),
    source_branch: requiredString(input.source_branch, "change_request.source_branch"),
    target_branch: requiredString(input.target_branch, "change_request.target_branch"),
    state: requiredString(input.state, "change_request.state"),
    revision: optionalString(input.revision, "change_request.revision"),
    url: optionalString(input.url, "change_request.url"),
  });
}

function normalizeCheckSummary(input) {
  if (!plain(input)) throw new ProviderContractError("ERR_CHECK_SUMMARY_INVALID");
  return Object.freeze({
    id: requiredString(input.id, "check.id"),
    provider: normalizeProviderKind(input.provider),
    name: requiredString(input.name, "check.name"),
    status: requiredString(input.status, "check.status"),
    conclusion: optionalString(input.conclusion, "check.conclusion"),
    revision: optionalString(input.revision, "check.revision"),
    url: optionalString(input.url, "check.url"),
  });
}

function normalizeProviderIdentity(input) {
  if (!plain(input)) throw new ProviderContractError("ERR_PROVIDER_IDENTITY_INVALID");
  return Object.freeze({
    provider: normalizeProviderKind(input.provider),
    id: requiredString(input.id, "identity.id"),
    login: optionalString(input.login, "identity.login"),
    display_name: optionalString(input.display_name, "identity.display_name"),
  });
}

class RemoteGitProvider {
  constructor(kind, operations = {}) {
    this.kind = normalizeProviderKind(kind);
    this._capabilities = providerCapabilities(this.kind);
    this._operations = Object.freeze({ ...operations });
  }

  capabilities() {
    return this._capabilities;
  }

  supports(capability) {
    return hasProviderCapability(this.kind, capability);
  }

  invoke(capability, ...args) {
    requireProviderCapability(this.kind, capability);
    const fn = this._operations[capability];
    if (typeof fn !== "function") {
      throw new ProviderContractError("ERR_PROVIDER_OPERATION_UNAVAILABLE", {
        kind: this.kind,
        capability,
      });
    }
    return fn(...args);
  }
}

function createProviderAdapter(kind, operations = {}) {
  return new RemoteGitProvider(kind, operations);
}

function createGenericGitAdapter(operations = {}) {
  return createProviderAdapter("generic-git", operations);
}

function createGitHubAdapter(operations = {}) {
  return createProviderAdapter("github", operations);
}

function createGitLabAdapter(operations = {}) {
  return createProviderAdapter("gitlab", operations);
}

function createGiteeAdapter(operations = {}) {
  return createProviderAdapter("gitee", operations);
}

const PROVIDER_NATIVE_TERMS = Object.freeze({
  github: Object.freeze({
    change_request: "pull-request",
    checks: "checks/actions",
  }),
  gitlab: Object.freeze({
    change_request: "merge-request",
    checks: "pipelines",
  }),
  gitee: Object.freeze({
    change_request: "pull-request",
    checks: "gitee-or-third-party-ci",
  }),
  "generic-git": Object.freeze({
    change_request: null,
    checks: null,
  }),
});

module.exports = {
  PROVIDER_KINDS,
  PROVIDER_CAPABILITIES,
  BASE_GIT_CAPABILITIES,
  PROVIDER_CAPABILITY_MATRIX,
  PROVIDER_NATIVE_TERMS,
  ProviderContractError,
  RemoteGitProvider,
  normalizeProviderKind,
  normalizeProviderLocator,
  providerCapabilities,
  hasProviderCapability,
  requireProviderCapability,
  normalizeChangeRequest,
  normalizeCheckSummary,
  normalizeProviderIdentity,
  createProviderAdapter,
  createGenericGitAdapter,
  createGitHubAdapter,
  createGitLabAdapter,
  createGiteeAdapter,
};
