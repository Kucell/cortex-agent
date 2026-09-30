"use strict";

const protocol = require("../../packages/protocol/src/index.js");

const PROJECT_PLATFORM_READ_MODEL_VERSION = "1";

function requireMethod(value, name) {
  if (typeof value !== "function") {
    const error = new Error(`Project platform read model requires ${name}`);
    error.code = "ERR_PROJECT_READ_MODEL_DEPENDENCY";
    throw error;
  }
  return value;
}

function projectSummary(value) {
  return Object.freeze({
    project_id: value.project_id,
    project_ref: value.project_ref,
    repository_slug: value.repository_slug,
    host_root: value.host_root,
    primary_branch: value.primary_branch,
    topology_ref: value.topology_ref,
    capabilities: Object.freeze([...(value.capabilities || [])]),
    integration_mode: value.integration_mode,
    descriptor_path: value.descriptor_path,
  });
}

function inspectSummary(value) {
  if (!value) return null;
  const descriptor = value.descriptor || null;
  const boundaries = descriptor && descriptor.boundaries ? descriptor.boundaries : null;
  const validation = descriptor && descriptor.validation ? descriptor.validation : { profiles: [] };
  return Object.freeze({
    ...projectSummary(value),
    drift: value.drift || null,
    authority: boundaries
      ? Object.freeze({
          authoritative_domain: boundaries.authoritative_domain,
          authoritative_runtime: boundaries.authoritative_runtime,
          cortex_role: boundaries.cortex_role,
          protected_components: Object.freeze([...(boundaries.protected_components || [])]),
        })
      : null,
    validation_profiles: Object.freeze(
      (validation.profiles || []).map((profile) => Object.freeze({
        id: profile.id,
        purpose: profile.purpose,
        blocking: profile.blocking,
      })),
    ),
    events: descriptor ? descriptor.events : null,
  });
}

function createProjectPlatformReadModel(options = {}) {
  const client = options.client;
  if (!client || !client.project || !client.project.connected) {
    const error = new Error("Project platform read model requires a Cortex SDK client with project.connected");
    error.code = "ERR_PROJECT_READ_MODEL_CLIENT";
    throw error;
  }

  const listProjects = requireMethod(client.project.connected.list, "project.connected.list");
  const getProject = requireMethod(client.project.connected.get, "project.connected.get");
  const healthProvider = options.healthProvider;
  if (!healthProvider || typeof healthProvider.produce !== "function") {
    const error = new Error("Project platform read model requires a PlatformHealth producer");
    error.code = "ERR_PROJECT_READ_MODEL_HEALTH";
    throw error;
  }

  function generatedAt(context = {}) {
    return context.now || new Date().toISOString();
  }

  async function list(context = {}) {
    const projects = await Promise.resolve(listProjects());
    return Object.freeze({
      schema_version: PROJECT_PLATFORM_READ_MODEL_VERSION,
      generated_at: generatedAt(context),
      projects: Object.freeze((projects || []).map(projectSummary)),
    });
  }

  async function inspect(projectRefOrId, context = {}) {
    if (!projectRefOrId) {
      const error = new Error("project ref or id is required");
      error.code = "ERR_PROJECT_READ_MODEL_PROJECT_REQUIRED";
      throw error;
    }
    const project = await Promise.resolve(getProject(projectRefOrId, { read_descriptor: true }));
    if (!project) return null;
    return Object.freeze({
      schema_version: PROJECT_PLATFORM_READ_MODEL_VERSION,
      generated_at: generatedAt(context),
      project: inspectSummary(project),
    });
  }

  async function health(context = {}) {
    const components = await healthProvider.produce({ now: generatedAt(context) });
    return protocol.normalizePlatformHealth({
      generated_at: generatedAt(context),
      components,
    });
  }

  return Object.freeze({ list, inspect, health });
}

module.exports = {
  PROJECT_PLATFORM_READ_MODEL_VERSION,
  createProjectPlatformReadModel,
  projectSummary,
  inspectSummary,
};
