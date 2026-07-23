"use strict";

const fs = require("fs");
const path = require("path");
const {
  DIAGNOSTIC_CODES,
  EXIT_CODES,
  diagnostic,
} = require("./contracts.js");

function canonicalDirectory(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch (_) {
    return null;
  }
}

function failure(code, message, details = {}) {
  const exitCodes = {
    [DIAGNOSTIC_CODES.PROJECT_INVALID]: EXIT_CODES.INVALID_INPUT,
    [DIAGNOSTIC_CODES.AGENT_ROOT_UNAVAILABLE]: EXIT_CODES.UNAVAILABLE,
    [DIAGNOSTIC_CODES.OWNER_MISSING]: EXIT_CODES.CONFLICT,
    [DIAGNOSTIC_CODES.OWNER_AGENT_ROOT_MISMATCH]: EXIT_CODES.CONFLICT,
    [DIAGNOSTIC_CODES.CONFIG_INVALID]: EXIT_CODES.INVALID_INPUT,
  };
  return {
    ok: false,
    exit_code: exitCodes[code],
    diagnostics: [diagnostic(code, "error", message, details)],
  };
}

function resolveDashboardRoots({ project, configuredDashboardRoot = null, operation = "status" } = {}) {
  if (typeof project !== "string" || project.length === 0) {
    return failure(DIAGNOSTIC_CODES.PROJECT_INVALID, "Dashboard project root is required.");
  }
  const requestedProject = path.resolve(project);
  const invocationRoot = canonicalDirectory(requestedProject);
  if (!invocationRoot) {
    return failure(DIAGNOSTIC_CODES.PROJECT_INVALID, "Dashboard project root is unavailable.", { project: requestedProject });
  }
  const agentPath = path.join(invocationRoot, ".agent");
  const agentRoot = canonicalDirectory(agentPath);
  if (!agentRoot) {
    return failure(DIAGNOSTIC_CODES.AGENT_ROOT_UNAVAILABLE, "Dashboard project .agent root is unavailable.", { agent_path: agentPath });
  }
  let dashboardRoot = null;
  if (configuredDashboardRoot !== null && configuredDashboardRoot !== undefined && configuredDashboardRoot !== "") {
    if (typeof configuredDashboardRoot !== "string" || !path.isAbsolute(configuredDashboardRoot)) {
      return failure(DIAGNOSTIC_CODES.CONFIG_INVALID, "Configured dashboard root must be an absolute path.");
    }
    dashboardRoot = canonicalDirectory(configuredDashboardRoot);
    if (!dashboardRoot) {
      return failure(DIAGNOSTIC_CODES.OWNER_MISSING, "Configured dashboard owner root is unavailable.", { dashboard_root: configuredDashboardRoot });
    }
    const ownerAgentRoot = canonicalDirectory(path.join(dashboardRoot, ".agent"));
    if (ownerAgentRoot !== agentRoot) {
      return failure(DIAGNOSTIC_CODES.OWNER_AGENT_ROOT_MISMATCH, "Configured dashboard owner does not use the same canonical .agent root.", {
        agent_root: agentRoot,
        dashboard_root: dashboardRoot,
        owner_agent_root: ownerAgentRoot,
      });
    }
  } else if (operation === "enable") {
    dashboardRoot = invocationRoot;
  } else if (!["status", "disable"].includes(operation)) {
    return failure(DIAGNOSTIC_CODES.CONFIG_INVALID, "Dashboard owner root must be configured before this operation.", { operation });
  }
  let sharedAgentRoot = false;
  try {
    sharedAgentRoot = fs.lstatSync(agentPath).isSymbolicLink();
  } catch (_) {
    sharedAgentRoot = dashboardRoot !== null && dashboardRoot !== invocationRoot;
  }
  return {
    ok: true,
    exit_code: EXIT_CODES.SUCCESS,
    invocation_root: invocationRoot,
    agent_root: agentRoot,
    dashboard_root: dashboardRoot,
    singleton_key: agentRoot,
    shared_agent_root: sharedAgentRoot,
    diagnostics: [],
  };
}

module.exports = {
  resolveDashboardRoots,
};
