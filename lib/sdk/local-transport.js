"use strict";

const path = require("node:path");
const {
  resolveManagementProject,
  queryManagementProject,
} = require("../management/client.js");
const topology = require("../topology");
const { readDescriptor } = require("../governance/lifecycle");
const { projectHealth } = require("../project/health");

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
    let descriptor = null;
    try {
      descriptor = readDescriptor(project.root);
    } catch (_) {}
    const current = topology.readTopology(project.root);
    const topologyProjectId = current && current.self && typeof current.self.project_id === "string"
      ? current.self.project_id.trim()
      : "";
    return {
      project_id: descriptor && descriptor.project_id
        ? descriptor.project_id
        : topologyProjectId || path.basename(project.root),
      topology: current,
      descriptor,
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
      if (projection === "project-health") {
        const project = resolve();
        return projectHealth(project.root);
      }
      const result = queryManagementProject(ctx, projection, filtersToArgs(filters));
      if (!result.ok) {
        const error = new Error(result.error.message);
        error.code = result.error.code;
        error.details = result.error.details;
        error.exitCode = result.exitCode;
        throw error;
      }
      if (projection === "capabilities" && result.payload && Array.isArray(result.payload.projections)) {
        const exists = result.payload.projections.some((item) => item && item.name === "project-health");
        if (!exists) {
          return {
            ...result.payload,
            projections: [
              ...result.payload.projections,
              {
                name: "project-health",
                kind: "aggregate",
                exact_lookup: false,
                data_field: null,
                filters: [],
                read_only: true,
              },
            ],
          };
        }
      }
      return result.payload;
    },

    getTopology() {
      const project = resolve();
      return topology.readTopology(project.root);
    },

    discoverCapabilities() {
      return {
        schema_version: "1",
        protocol: "cortex",
        protocol_version: "1.0",
        implementation: "cortex-local-transport",
        implementation_version: null,
        capabilities: [
          "management.query",
          "tasks.read",
          "runs.read",
          "decisions.read",
          "waitpoints.read",
          "coordination.tasks.read",
          "topology.read",
          "project.health.read",
        ],
      };
    },
  });
}

module.exports = {
  createLocalTransport,
  filtersToArgs,
};
