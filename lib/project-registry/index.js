"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const topology = require("../topology");
const {
  normalizeProjectDescriptor,
} = require("../../packages/project-sdk/src/index.js");
const protocol = require("../../packages/protocol/src/index.js");

const CONNECTED_PROJECT_SCHEMA_VERSION = "1";
const DEFAULT_DESCRIPTOR_PATH = "cortex.project.json";

class ConnectedProjectError extends Error {
  constructor(code, details = {}) {
    super(`[connected-project:${code}] ${JSON.stringify(details)}`);
    this.name = "ConnectedProjectError";
    this.code = code;
    this.details = details;
  }
}

function resolveDescriptorPath(projectRoot, descriptorPath = DEFAULT_DESCRIPTOR_PATH) {
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, descriptorPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ConnectedProjectError("ERR_PROJECT_DESCRIPTOR_PATH", {
      project_root: root,
      descriptor_path: descriptorPath,
    });
  }
  return { root, absolute: candidate, relative: relative.replace(/\\/g, "/") || DEFAULT_DESCRIPTOR_PATH };
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableJson(value[key]);
  }
  return out;
}

function descriptorDigest(descriptor) {
  const canonical = JSON.stringify(stableJson(descriptor));
  return `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

function readConnectedDescriptor(projectRoot, descriptorPath = DEFAULT_DESCRIPTOR_PATH) {
  const location = resolveDescriptorPath(projectRoot, descriptorPath);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(location.absolute, "utf8"));
  } catch (error) {
    throw new ConnectedProjectError("ERR_PROJECT_DESCRIPTOR_READ", {
      project_root: location.root,
      descriptor_path: location.relative,
      cause: error && error.code ? error.code : String(error),
    });
  }
  const descriptor = normalizeProjectDescriptor(raw);
  if (descriptor.integration_mode !== "connected") {
    throw new ConnectedProjectError("ERR_PROJECT_NOT_CONNECTED_MODE", {
      project_id: descriptor.project_id,
      integration_mode: descriptor.integration_mode,
    });
  }
  return Object.freeze({
    root: location.root,
    descriptor_path: location.relative,
    descriptor,
    digest: descriptorDigest(raw),
  });
}

function connectedPeerFromDescriptor(record) {
  const descriptor = record.descriptor;
  return {
    project_id: descriptor.project_id,
    host_root: record.root,
    primary_branch: descriptor.repository.default_branch,
    roles: ["connected-project"],
    capabilities: [...descriptor.capabilities.provided],
    topology_ref: `${descriptor.project_id}@${descriptor.repository.default_branch}`,
    connected_project: {
      schema_version: CONNECTED_PROJECT_SCHEMA_VERSION,
      project_ref: descriptor.project_ref,
      descriptor_path: record.descriptor_path,
      descriptor_digest: record.digest,
      repository_slug: descriptor.repository.slug,
      integration_mode: descriptor.integration_mode,
    },
  };
}

function registerConnectedProject(cortexRoot, projectRoot, options = {}) {
  const record = readConnectedDescriptor(projectRoot, options.descriptor_path);
  const current = topology.readTopology(cortexRoot);
  const existing = topology.findPeer(current, record.descriptor.project_id);

  if (existing) {
    if (!existing.connected_project) {
      throw new ConnectedProjectError("ERR_PROJECT_IDENTITY_CONFLICT", {
        project_id: record.descriptor.project_id,
        reason: "existing peer is not a connected-project registration",
      });
    }
    const expectedRoot = path.resolve(existing.host_root);
    if (expectedRoot !== record.root) {
      throw new ConnectedProjectError("ERR_PROJECT_IDENTITY_CONFLICT", {
        project_id: record.descriptor.project_id,
        existing_root: expectedRoot,
        requested_root: record.root,
      });
    }
    const replacement = connectedPeerFromDescriptor(record);
    const peers = current.peers.map((peer) =>
      peer.project_id === replacement.project_id ? replacement : peer);
    const result = topology.writeTopology(cortexRoot, {
      self: current.self,
      peers,
    });
    if (!result.ok) {
      throw new ConnectedProjectError("ERR_PROJECT_TOPOLOGY_WRITE", {
        errors: result.errors,
      });
    }
    return Object.freeze({
      registered: false,
      updated: true,
      idempotent: existing.connected_project.descriptor_digest === record.digest,
      project: inspectConnectedPeer(replacement),
    });
  }

  const peer = connectedPeerFromDescriptor(record);
  const result = topology.registerPeer(cortexRoot, peer);
  if (!result.ok) {
    throw new ConnectedProjectError("ERR_PROJECT_TOPOLOGY_WRITE", {
      errors: result.errors,
    });
  }
  return Object.freeze({
    registered: true,
    updated: false,
    idempotent: false,
    project: inspectConnectedPeer(peer),
  });
}

function inspectConnectedPeer(peer) {
  if (!peer || !peer.connected_project) return null;
  return Object.freeze({
    project_id: peer.project_id,
    project_ref: peer.connected_project.project_ref || protocol.createRef("project", peer.project_id),
    host_root: peer.host_root,
    primary_branch: peer.primary_branch || null,
    topology_ref: peer.topology_ref || null,
    capabilities: Object.freeze([...(peer.capabilities || [])]),
    descriptor_path: peer.connected_project.descriptor_path,
    descriptor_digest: peer.connected_project.descriptor_digest,
    repository_slug: peer.connected_project.repository_slug,
    integration_mode: peer.connected_project.integration_mode,
  });
}

function listConnectedProjects(cortexRoot) {
  const current = topology.readTopology(cortexRoot);
  return Object.freeze(
    current.peers
      .filter((peer) => peer.connected_project)
      .map(inspectConnectedPeer)
      .sort((a, b) => a.project_id.localeCompare(b.project_id)),
  );
}

function getConnectedProject(cortexRoot, projectRefOrId, options = {}) {
  const parsed = protocol.parseRef(projectRefOrId, "project");
  const projectId = parsed ? parsed.value : String(projectRefOrId || "");
  const current = topology.readTopology(cortexRoot);
  const peer = topology.findPeer(current, projectId);
  if (!peer || !peer.connected_project) return null;

  const summary = inspectConnectedPeer(peer);
  if (options.read_descriptor === false) return summary;

  const record = readConnectedDescriptor(peer.host_root, peer.connected_project.descriptor_path);
  const drift = record.digest !== peer.connected_project.descriptor_digest;
  const repositoryMismatch = record.descriptor.repository.slug !== peer.connected_project.repository_slug;

  return Object.freeze({
    ...summary,
    descriptor: record.descriptor,
    drift: Object.freeze({
      detected: drift || repositoryMismatch,
      descriptor_digest_changed: drift,
      repository_identity_changed: repositoryMismatch,
      current_digest: record.digest,
      registered_digest: peer.connected_project.descriptor_digest,
    }),
  });
}

function unregisterConnectedProject(cortexRoot, projectRefOrId) {
  const parsed = protocol.parseRef(projectRefOrId, "project");
  const projectId = parsed ? parsed.value : String(projectRefOrId || "");
  const current = topology.readTopology(cortexRoot);
  const peer = topology.findPeer(current, projectId);
  if (!peer || !peer.connected_project) {
    return Object.freeze({ removed: false, idempotent: true, project_id: projectId });
  }
  const result = topology.deregisterPeer(cortexRoot, projectId);
  if (!result.ok) {
    throw new ConnectedProjectError("ERR_PROJECT_TOPOLOGY_WRITE", {
      errors: result.errors,
    });
  }
  return Object.freeze({
    removed: true,
    idempotent: false,
    project: inspectConnectedPeer(result.removed),
  });
}

function createConnectedProjectHealthProducer(cortexRoot) {
  return protocol.createHealthProducer({
    id: "cortex.connected-projects",
    kind: "connected-project",
    version: "1",
    async produce(context = {}) {
      const now = context.now || new Date().toISOString();
      return listConnectedProjects(cortexRoot).map((summary) => {
        let detail;
        try {
          detail = getConnectedProject(cortexRoot, summary.project_id);
        } catch (error) {
          return {
            id: summary.project_ref,
            kind: "project",
            status: "unhealthy",
            observed_at: now,
            checks: [{
              id: "descriptor.read",
              status: "unhealthy",
              message: "connected project descriptor is unavailable or invalid",
              details: { code: error.code || "ERR_PROJECT_DESCRIPTOR" },
            }],
            evidence_refs: [],
            redacted: true,
          };
        }

        const drift = detail.drift.detected;
        return {
          id: summary.project_ref,
          kind: "project",
          status: drift ? "degraded" : "healthy",
          observed_at: now,
          checks: [
            {
              id: "descriptor.read",
              status: "healthy",
              message: "connected project descriptor is readable",
              details: { repository: detail.repository_slug },
            },
            {
              id: "descriptor.drift",
              status: drift ? "degraded" : "healthy",
              message: drift ? "registered descriptor snapshot differs from current descriptor" : "descriptor matches registered snapshot",
              details: { detected: drift },
            },
          ],
          evidence_refs: [],
          redacted: true,
        };
      });
    },
  });
}

module.exports = {
  CONNECTED_PROJECT_SCHEMA_VERSION,
  DEFAULT_DESCRIPTOR_PATH,
  ConnectedProjectError,
  descriptorDigest,
  readConnectedDescriptor,
  registerConnectedProject,
  listConnectedProjects,
  getConnectedProject,
  unregisterConnectedProject,
  createConnectedProjectHealthProducer,
};
