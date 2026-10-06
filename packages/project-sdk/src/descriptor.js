"use strict";

let protocol;
try {
  protocol = require("@cortex-agent/protocol");
} catch (_) {
  protocol = require("../../protocol/src/index.js");
}

const { normalizeGovernanceBinding } = require("./governance");\n\nconst PROJECT_DESCRIPTOR_SCHEMA_VERSION = "1";
const PROJECT_INTEGRATION_MODES = Object.freeze([
  "embedded",
  "connected",
  "capability-bridge",
]);
const CORTEX_PROJECT_ROLES = Object.freeze([
  "governance-orchestration",
  "governance-observer",
]);

const TOP_KEYS = new Set([
  "schema_version",
  "project_id",
  "repository",
  "integration_mode",
  "capabilities",
  "validation",
  "artifacts",
  "events",
  "boundaries",
]);
const REPO_KEYS = new Set(["slug", "default_branch"]);
const CAP_KEYS = new Set(["provided", "required"]);
const VALIDATION_KEYS = new Set(["profiles"]);
const PROFILE_KEYS = new Set(["id", "command", "purpose", "blocking"]);
const ARTIFACT_KEYS = new Set(["id", "path", "kind"]);
const EVENTS_KEYS = new Set(["mode", "source"]);
const BOUNDARY_KEYS = new Set([
  "authoritative_domain",
  "authoritative_runtime",
  "cortex_role",
  "protected_components",
]);

class ProjectDescriptorError extends Error {
  constructor(code, details = {}) {
    super(`[project-descriptor:${code}] ${JSON.stringify(details)}`);
    this.name = "ProjectDescriptorError";
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
      throw new ProjectDescriptorError("ERR_PROJECT_FIELD_UNKNOWN", { where, key });
    }
  }
}

function string(value, where) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new ProjectDescriptorError("ERR_PROJECT_FIELD_INVALID", { where });
  }
  return value.trim();
}

function id(value, where) {
  const result = string(value, where);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(result)) {
    throw new ProjectDescriptorError("ERR_PROJECT_ID_INVALID", { where, value });
  }
  return result;
}

function relativePath(value, where) {
  const result = string(value, where).replace(/\\/g, "/");
  if (result.startsWith("/") || /^[A-Za-z]:\//.test(result) || result.split("/").includes("..")) {
    throw new ProjectDescriptorError("ERR_PROJECT_PATH_INVALID", { where, value });
  }
  return result;
}

function normalizeRepository(input) {
  if (!plain(input)) throw new ProjectDescriptorError("ERR_PROJECT_REPOSITORY", {});
  rejectUnknown(input, REPO_KEYS, "repository");
  const slug = string(input.slug, "repository.slug");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new ProjectDescriptorError("ERR_PROJECT_REPOSITORY_SLUG", { slug });
  }
  return Object.freeze({
    slug,
    default_branch: string(input.default_branch || "main", "repository.default_branch"),
  });
}

function normalizeCapabilities(input) {
  if (input == null) input = {};
  if (!plain(input)) throw new ProjectDescriptorError("ERR_PROJECT_CAPABILITIES", {});
  rejectUnknown(input, CAP_KEYS, "capabilities");
  const provided = protocol.validateCapabilityList(input.provided || []);
  const required = protocol.validateCapabilityList(input.required || []);
  for (const capability of [...provided, ...required]) {
    const parsed = protocol.parseCapabilityId(capability);
    if (!parsed || !["project", "management", "extension"].includes(parsed.namespace)) {
      throw new ProjectDescriptorError("ERR_PROJECT_CAPABILITY_NAMESPACE", { capability });
    }
  }
  return Object.freeze({ provided, required });
}

function normalizeValidation(input) {
  if (input == null) input = {};
  if (!plain(input)) throw new ProjectDescriptorError("ERR_PROJECT_VALIDATION", {});
  rejectUnknown(input, VALIDATION_KEYS, "validation");
  if (!Array.isArray(input.profiles || [])) {
    throw new ProjectDescriptorError("ERR_PROJECT_VALIDATION_PROFILES", {});
  }
  const seen = new Set();
  const profiles = (input.profiles || []).map((profile, index) => {
    if (!plain(profile)) {
      throw new ProjectDescriptorError("ERR_PROJECT_VALIDATION_PROFILE", { index });
    }
    rejectUnknown(profile, PROFILE_KEYS, `validation.profiles[${index}]`);
    const profileId = id(profile.id, `validation.profiles[${index}].id`);
    if (seen.has(profileId)) {
      throw new ProjectDescriptorError("ERR_PROJECT_VALIDATION_PROFILE_DUPLICATE", { id: profileId });
    }
    seen.add(profileId);
    return Object.freeze({
      id: profileId,
      command: string(profile.command, `validation.profiles[${index}].command`),
      purpose: string(profile.purpose, `validation.profiles[${index}].purpose`),
      blocking: profile.blocking !== false,
    });
  });
  return Object.freeze({ profiles: Object.freeze(profiles) });
}

function normalizeArtifacts(input) {
  if (input == null) return Object.freeze([]);
  if (!Array.isArray(input)) throw new ProjectDescriptorError("ERR_PROJECT_ARTIFACTS", {});
  const seen = new Set();
  return Object.freeze(input.map((artifact, index) => {
    if (!plain(artifact)) throw new ProjectDescriptorError("ERR_PROJECT_ARTIFACT", { index });
    rejectUnknown(artifact, ARTIFACT_KEYS, `artifacts[${index}]`);
    const artifactId = id(artifact.id, `artifacts[${index}].id`);
    if (seen.has(artifactId)) {
      throw new ProjectDescriptorError("ERR_PROJECT_ARTIFACT_DUPLICATE", { id: artifactId });
    }
    seen.add(artifactId);
    return Object.freeze({
      id: artifactId,
      path: relativePath(artifact.path, `artifacts[${index}].path`),
      kind: id(artifact.kind, `artifacts[${index}].kind`),
    });
  }));
}

function normalizeEvents(input) {
  if (input == null) return Object.freeze({ mode: "none", source: null });
  if (!plain(input)) throw new ProjectDescriptorError("ERR_PROJECT_EVENTS", {});
  rejectUnknown(input, EVENTS_KEYS, "events");
  const mode = input.mode || "none";
  if (!["none", "observational"].includes(mode)) {
    throw new ProjectDescriptorError("ERR_PROJECT_EVENT_MODE", { mode });
  }
  return Object.freeze({
    mode,
    source: input.source == null ? null : string(input.source, "events.source"),
  });
}

function normalizeBoundaries(input) {
  if (!plain(input)) throw new ProjectDescriptorError("ERR_PROJECT_BOUNDARIES", {});
  rejectUnknown(input, BOUNDARY_KEYS, "boundaries");
  const role = string(input.cortex_role, "boundaries.cortex_role");
  if (!CORTEX_PROJECT_ROLES.includes(role)) {
    throw new ProjectDescriptorError("ERR_PROJECT_CORTEX_ROLE", { role });
  }
  if (!Array.isArray(input.protected_components || [])) {
    throw new ProjectDescriptorError("ERR_PROJECT_PROTECTED_COMPONENTS", {});
  }
  return Object.freeze({
    authoritative_domain: string(input.authoritative_domain, "boundaries.authoritative_domain"),
    authoritative_runtime: string(input.authoritative_runtime, "boundaries.authoritative_runtime"),
    cortex_role: role,
    protected_components: Object.freeze(
      [...new Set((input.protected_components || []).map((value, index) =>
        id(value, `boundaries.protected_components[${index}]`)))],
    ),
  });
}

function normalizeProjectDescriptor(input) {
  if (!plain(input)) throw new ProjectDescriptorError("ERR_PROJECT_DESCRIPTOR_INVALID", {});
  rejectUnknown(input, TOP_KEYS, "descriptor");
  const schemaVersion = input.schema_version == null
    ? PROJECT_DESCRIPTOR_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== PROJECT_DESCRIPTOR_SCHEMA_VERSION) {
    throw new ProjectDescriptorError("ERR_PROJECT_SCHEMA_VERSION", { received: schemaVersion });
  }
  const projectId = id(input.project_id, "project_id");
  const mode = string(input.integration_mode, "integration_mode");
  if (!PROJECT_INTEGRATION_MODES.includes(mode)) {
    throw new ProjectDescriptorError("ERR_PROJECT_INTEGRATION_MODE", { mode });
  }
  return Object.freeze({
    schema_version: PROJECT_DESCRIPTOR_SCHEMA_VERSION,
    project_id: projectId,
    project_ref: protocol.createRef("project", projectId),
    repository: normalizeRepository(input.repository),
    integration_mode: mode,
    capabilities: normalizeCapabilities(input.capabilities),
    validation: normalizeValidation(input.validation),
    artifacts: normalizeArtifacts(input.artifacts),
    events: normalizeEvents(input.events),
    boundaries: normalizeBoundaries(input.boundaries),
  });
}

module.exports = {
  PROJECT_DESCRIPTOR_SCHEMA_VERSION,
  PROJECT_INTEGRATION_MODES,
  CORTEX_PROJECT_ROLES,
  ProjectDescriptorError,
  normalizeProjectDescriptor,
};
