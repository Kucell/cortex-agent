"use strict";

const fs = require("node:fs");
const path = require("node:path");

function canonicalDirectory(candidate) {
  try {
    const resolved = fs.realpathSync(candidate);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch (_) {
    return null;
  }
}

function resolveGovernanceRoot(projectRoot, options = {}) {
  const root = canonicalDirectory(projectRoot);
  if (!root) {
    const error = new Error("Unable to resolve project root.");
    error.code = "ERR_GOVERNANCE_PROJECT_ROOT_NOT_FOUND";
    error.project_root = projectRoot;
    throw error;
  }

  const bindingPath = path.join(root, ".agent");
  let stat;
  try {
    stat = fs.lstatSync(bindingPath);
  } catch (_) {
    if (options.allow_missing_embedded === true) {
      return Object.freeze({
        project_root: root,
        binding_path: bindingPath,
        agent_root: bindingPath,
        mode: "embedded-local",
        materialized: false,
      });
    }
    const error = new Error("Project does not contain a readable .agent governance binding.");
    error.code = "ERR_GOVERNANCE_BINDING_NOT_FOUND";
    error.project_root = root;
    error.binding_path = bindingPath;
    throw error;
  }

  const agentRoot = canonicalDirectory(bindingPath);
  if (!agentRoot) {
    const error = new Error("Project .agent governance binding does not resolve to a directory.");
    error.code = "ERR_GOVERNANCE_BINDING_UNREADABLE";
    error.project_root = root;
    error.binding_path = bindingPath;
    throw error;
  }

  return Object.freeze({
    project_root: root,
    binding_path: bindingPath,
    agent_root: agentRoot,
    mode: stat.isSymbolicLink() ? "detached-local" : "embedded-local",
    materialized: true,
  });
}

module.exports = {
  canonicalDirectory,
  resolveGovernanceRoot,
};
