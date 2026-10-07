"use strict";

const {
  requireProviderCapability,
  ProviderContractError,
} = require("../governance/providers");

function acceptanceError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

async function invoke(provider, capability, ...args) {
  requireProviderCapability(provider.kind, capability);
  const result = provider.invoke(capability, ...args);
  return result && typeof result.then === "function" ? await result : result;
}

async function runProviderLiveAcceptance(provider, input = {}) {
  if (!provider || typeof provider.invoke !== "function" || typeof provider.kind !== "string") {
    throw acceptanceError("ERR_PROVIDER_ACCEPTANCE_PROVIDER_REQUIRED", "RemoteGitProvider instance required.");
  }
  if (!input.repository) {
    throw acceptanceError("ERR_PROVIDER_ACCEPTANCE_REPOSITORY_REQUIRED", "repository is required.");
  }

  const requiredCore = [
    "repository.resolve",
    "branch.resolve",
    "revision.read",
    "object.read",
    "conditional-write",
  ];
  for (const capability of requiredCore) requireProviderCapability(provider.kind, capability);

  const repository = await invoke(provider, "repository.resolve", input.repository);
  const branchName = input.branch || (repository && repository.default_branch) || "main";
  const branch = await invoke(provider, "branch.resolve", input.repository, branchName);
  const revision1 = await invoke(provider, "revision.read", input.repository, branchName);

  const probePath = input.probe_path || "acceptance/ms012.json";
  const before = await invoke(provider, "object.read", input.repository, branchName, probePath);

  const payloadA = {
    schema_version: 1,
    acceptance: "rdg-ms012",
    provider: provider.kind,
    writer: "session-a",
    nonce: input.nonce || "acceptance",
  };

  const writeA = await invoke(provider, "conditional-write", {
    repository: input.repository,
    branch: branchName,
    path: probePath,
    expected_revision: revision1,
    content: JSON.stringify(payloadA, null, 2) + "\n",
    message: "test(acceptance): RDG MS-012 provider live CAS",
  });

  let staleConflict = false;
  let staleError = null;
  try {
    await invoke(provider, "conditional-write", {
      repository: input.repository,
      branch: branchName,
      path: probePath,
      expected_revision: revision1,
      content: JSON.stringify({ ...payloadA, writer: "session-b" }, null, 2) + "\n",
      message: "test(acceptance): stale writer must fail",
    });
  } catch (error) {
    staleError = error;
    staleConflict = Boolean(
      error &&
      (
        error.code === "ERR_GOVERNANCE_REVISION_CONFLICT" ||
        error.code === "ERR_PROVIDER_REVISION_CONFLICT" ||
        error.code === "ERR_PROVIDER_CONDITIONAL_WRITE_CONFLICT"
      )
    );
  }

  if (!staleConflict) {
    throw acceptanceError(
      "ERR_PROVIDER_ACCEPTANCE_STALE_WRITE_NOT_REJECTED",
      "Provider acceptance requires stale conditional write to fail closed.",
      { stale_error_code: staleError && staleError.code ? staleError.code : null },
    );
  }

  const revision2 = await invoke(provider, "revision.read", input.repository, branchName);
  const after = await invoke(provider, "object.read", input.repository, branchName, probePath);

  const optional = {
    change_request: { status: "unavailable", value: null, reason: "capability_missing" },
    checks: { status: "unavailable", value: null, reason: "capability_missing" },
    identity: { status: "unavailable", value: null, reason: "capability_missing" },
  };

  if (provider.supports("change-request.read")) {
    try {
      optional.change_request = {
        status: "observed",
        value: await invoke(provider, "change-request.read", input.repository, branchName),
        reason: null,
      };
    } catch (error) {
      optional.change_request = {
        status: "unknown",
        value: null,
        reason: error.code || "change_request_read_failed",
      };
    }
  }

  if (provider.supports("checks.read")) {
    try {
      optional.checks = {
        status: "observed",
        value: await invoke(provider, "checks.read", input.repository, revision2),
        reason: null,
      };
    } catch (error) {
      optional.checks = {
        status: "unknown",
        value: null,
        reason: error.code || "checks_read_failed",
      };
    }
  }

  if (provider.supports("identity.read")) {
    try {
      optional.identity = {
        status: "observed",
        value: await invoke(provider, "identity.read"),
        reason: null,
      };
    } catch (error) {
      optional.identity = {
        status: "unknown",
        value: null,
        reason: error.code || "identity_read_failed",
      };
    }
  }

  return Object.freeze({
    schema_version: 1,
    provider: provider.kind,
    evidence_class: "LIVE",
    repository,
    branch,
    revision_before: revision1,
    revision_after: revision2,
    probe_path: probePath,
    object_before: before,
    object_after: after,
    write: writeA,
    stale_write_rejected: true,
    optional,
  });
}

module.exports = {
  runProviderLiveAcceptance,
};
