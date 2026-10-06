"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const { readDescriptor } = require("../governance/lifecycle");
const { createFilesystemGovernanceStore } = require("../governance/store");
const { createGitGovernanceStore } = require("../governance/git-store");
const { projectReconciliationSummary } = require("../reconciliation");

function projectHealthError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeGitRef(ref) {
  if (!ref) return "refs/heads/main";
  if (ref.startsWith("refs/")) return ref;
  return "refs/heads/" + ref;
}

function resolveLocalGitLocator(projectRoot, locator) {
  if (typeof locator !== "string" || !locator.trim()) return null;
  const value = locator.trim();
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value);
    } catch (_) {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  const candidate = path.resolve(projectRoot, value);
  return fs.existsSync(candidate) ? candidate : null;
}

function projectHealth(projectRoot, options = {}) {
  const root = fs.realpathSync(projectRoot);
  const descriptor = readDescriptor(root);
  const governance = descriptor.governance;

  const projection = {
    schema_version: 1,
    project: {
      project_id: descriptor.project_id,
      project_ref: descriptor.project_ref,
      root,
      repository: descriptor.repository,
      integration_mode: descriptor.integration_mode,
    },
    governance: {
      binding: governance,
      accessibility: {
        status: "unknown",
        reason: null,
      },
      store: {
        kind: governance ? governance.kind : null,
        capabilities: null,
        revision: null,
      },
    },
    reconciliation: options.reconciliation_result
      ? projectReconciliationSummary(options.reconciliation_result)
      : null,
    health: {
      status: "degraded",
      reasons: [],
    },
  };

  if (!governance) {
    projection.governance.accessibility = {
      status: "unavailable",
      reason: "governance_binding_missing",
    };
    projection.health.reasons.push("governance_binding_missing");
    return projection;
  }

  if (governance.kind === "filesystem") {
    const target = path.resolve(root, governance.locator);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      projection.governance.accessibility = {
        status: "unavailable",
        reason: "filesystem_binding_unavailable",
      };
      projection.health.reasons.push("filesystem_binding_unavailable");
      return projection;
    }
    const store = createFilesystemGovernanceStore(target);
    projection.governance.accessibility = {
      status: "observed",
      reason: null,
    };
    projection.governance.store.capabilities = store.capabilities();
    projection.health.status = projection.reconciliation && !projection.reconciliation.can_resume
      ? "blocked"
      : "healthy";
    if (projection.reconciliation && projection.reconciliation.disposition === "DEGRADED") {
      projection.health.status = "degraded";
      projection.health.reasons.push("reconciliation_degraded");
    }
    if (projection.reconciliation && !projection.reconciliation.can_resume) {
      projection.health.reasons.push("reconciliation_" + projection.reconciliation.disposition.toLowerCase());
    }
    return projection;
  }

  if (governance.kind === "git") {
    const repo = resolveLocalGitLocator(root, governance.locator);
    if (!repo) {
      projection.governance.accessibility = {
        status: "unavailable",
        reason: "remote_transport_unbound",
      };
      projection.health.reasons.push("remote_transport_unbound");
      return projection;
    }
    try {
      const store = createGitGovernanceStore(repo, {
        ref: normalizeGitRef(governance.ref),
      });
      projection.governance.accessibility = {
        status: "observed",
        reason: null,
      };
      projection.governance.store.capabilities = store.capabilities();
      projection.governance.store.revision = store.getRevision();
      projection.health.status = projection.reconciliation && !projection.reconciliation.can_resume
        ? "blocked"
        : "healthy";
      if (projection.reconciliation && projection.reconciliation.disposition === "DEGRADED") {
        projection.health.status = "degraded";
        projection.health.reasons.push("reconciliation_degraded");
      }
      if (projection.reconciliation && !projection.reconciliation.can_resume) {
        projection.health.reasons.push("reconciliation_" + projection.reconciliation.disposition.toLowerCase());
      }
      return projection;
    } catch (error) {
      projection.governance.accessibility = {
        status: "unavailable",
        reason: error.code || "git_store_unavailable",
      };
      projection.health.reasons.push(error.code || "git_store_unavailable");
      return projection;
    }
  }

  throw projectHealthError("ERR_PROJECT_HEALTH_STORE_KIND", "Unsupported governance store kind.", {
    kind: governance.kind,
  });
}

module.exports = {
  normalizeGitRef,
  resolveLocalGitLocator,
  projectHealth,
};
