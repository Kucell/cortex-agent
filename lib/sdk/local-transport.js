"use strict";

const path = require("node:path");
const {
  resolveManagementProject,
  queryManagementProject,
} = require("../management/client.js");
const topology = require("../topology");

function filtersToArgs(filters = {}) {
  const args = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    const flag = `--${key}`;
    if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
    } else if (typeof value === "boolean") {
      if (value) args.push(flag);
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
}

function createLocalTransport(ctx) {
  if (!ctx || typeof ctx !== "object") {
    const error = new Error("Local Cortex transport requires a command context.");
    error.code = "ERR_LOCAL_TRANSPORT_CONTEXT_REQUIRED";
    throw error;
  }

  function resolve() {
    const result = resolveManagementProject(ctx);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      error.details = result.error.details;
      error.exitCode = result.exitCode;
      throw error;
    }
    return result.project;
  }

  function readProjectIdentity(project) {
    const current = topology.readTopology(project.root);
    const projectId = current && current.self && typeof current.self.project_id === "string"
      ? current.self.project_id.trim()
      : "";
    return {
      project_id: projectId || path.basename(project.root),
      topology: current,
    };
  }

  return Object.freeze({
    resolveProject() {
      const project = resolve();
      const identity = readProjectIdentity(project);
      return {
        project_ref: `project:${identity.project_id}`,
        project_id: identity.project_id,
        root: project.root,
        agent_root: project.agent_root,
      };
    },

    query(projection, filters = {}) {
      const result = queryManagementProject(ctx, projection, filtersToArgs(filters));
      if (!result.ok) {
        const error = new Error(result.error.message);
        error.code = result.error.code;
        error.details = result.error.details;
        error.exitCode = result.exitCode;
        throw error;
      }
      return result.payload;
    },

    getTopology() {
      const project = resolve();
      return topology.readTopology(project.root);
    },

    discoverCapabilities() {
      return {
        schema_version: "1.0",
        protocol: "cortex",
        protocol_version: "1.0",
        transport: "local",
        capabilities: [
          "management.query",
          "tasks.read",
          "runs.read",
          "decisions.read",
          "waitpoints.read",
          "coordination.tasks.read",
          "topology.read",
        ],
      };
    },
  });
}

module.exports = {
  createLocalTransport,
  filtersToArgs,
};
