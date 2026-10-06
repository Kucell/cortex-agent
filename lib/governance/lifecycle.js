"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  normalizeProjectDescriptor,
} = require("../../packages/project-sdk/src/descriptor.js");
const {
  normalizeGovernanceBinding,
} = require("../../packages/project-sdk/src/governance.js");
const {
  resolveGovernanceRoot,
} = require("./root.js");

const DESCRIPTOR_NAME = "cortex.project.json";

function lifecycleError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sanitizeId(value) {
  const normalized = String(value || "project").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "project";
}

function detectDefaultBranch(projectRoot) {
  const result = spawnSync("git", ["-C", projectRoot, "symbolic-ref", "--quiet", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const branch = String(result.stdout || "").trim();
  return branch || "main";
}

function detectRepositorySlug(projectRoot) {
  const result = spawnSync("git", ["-C", projectRoot, "remote", "get-url", "origin"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    const raw = String(result.stdout || "").trim();
    const scp = /^(?:[^@]+@)?[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(raw);
    const url = /\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(raw);
    const match = scp || url;
    if (match) return `${sanitizeId(match[1])}/${sanitizeId(match[2])}`;
  }
  return `local/${sanitizeId(path.basename(projectRoot))}`;
}

function descriptorPath(projectRoot) {
  return path.join(projectRoot, DESCRIPTOR_NAME);
}

function readDescriptor(projectRoot, options = {}) {
  const file = descriptorPath(projectRoot);
  if (!fs.existsSync(file)) {
    if (options.required === false) return null;
    throw lifecycleError("ERR_PROJECT_DESCRIPTOR_NOT_FOUND", "cortex.project.json not found.", { file });
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw lifecycleError("ERR_PROJECT_DESCRIPTOR_INVALID_JSON", error.message, { file });
  }
  return normalizeProjectDescriptor(raw);
}

function writeDescriptor(projectRoot, descriptor) {
  const normalized = normalizeProjectDescriptor(descriptor);
  const file = descriptorPath(projectRoot);
  const serialized = {
    schema_version: normalized.schema_version,
    project_id: normalized.project_id,
    repository: normalized.repository,
    integration_mode: normalized.integration_mode,
    capabilities: normalized.capabilities,
    validation: normalized.validation,
    artifacts: normalized.artifacts,
    events: normalized.events,
    boundaries: normalized.boundaries,
    governance: normalized.governance,
  };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(serialized, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  return normalized;
}

function createDefaultDescriptor(projectRoot, options = {}) {
  const projectId = options.project_id || `cortex-project-${crypto.randomUUID()}`;
  const repository = {
    slug: detectRepositorySlug(projectRoot),
    default_branch: detectDefaultBranch(projectRoot),
  };
  const baseName = sanitizeId(path.basename(projectRoot));
  return {
    schema_version: 1,
    project_id: projectId,
    repository,
    integration_mode: "embedded",
    capabilities: { provided: [], required: [] },
    validation: { profiles: [] },
    artifacts: [],
    events: { mode: "none" },
    boundaries: {
      authoritative_domain: baseName,
      authoritative_runtime: baseName,
      cortex_role: "governance-orchestration",
      protected_components: [],
    },
    governance: {
      kind: "filesystem",
      locator: ".agent",
      ref: null,
    },
  };
}

function ensureProjectDescriptor(projectRoot, options = {}) {
  const existing = readDescriptor(projectRoot, { required: false });
  if (existing) return { descriptor: existing, created: false };

  const descriptor = createDefaultDescriptor(projectRoot, options);
  return { descriptor: writeDescriptor(projectRoot, descriptor), created: true };
}

function currentBinding(projectRoot) {
  const descriptor = readDescriptor(projectRoot);
  return descriptor.governance || null;
}

function bindingEquals(left, right) {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.locator === right.locator && (left.ref || null) === (right.ref || null);
}

function validateBindingTarget(projectRoot, binding) {
  const normalized = normalizeGovernanceBinding(binding);
  if (!normalized) {
    throw lifecycleError("ERR_GOVERNANCE_BINDING_REQUIRED", "Governance binding is required.");
  }

  if (normalized.kind === "filesystem") {
    const target = path.resolve(projectRoot, normalized.locator);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw lifecycleError("ERR_GOVERNANCE_BINDING_TARGET_INVALID", "Filesystem governance target must already exist.", {
        target,
      });
    }
  }

  return normalized;
}

function updateBinding(projectRoot, nextBinding, options = {}) {
  const descriptor = readDescriptor(projectRoot);
  const current = descriptor.governance || null;

  if (Object.prototype.hasOwnProperty.call(options, "expected_current")) {
    const expected = options.expected_current == null ? null : normalizeGovernanceBinding(options.expected_current);
    if (!bindingEquals(current, expected)) {
      throw lifecycleError("ERR_GOVERNANCE_BINDING_CONFLICT", "Current governance binding does not match expected binding.", {
        expected,
        actual: current,
      });
    }
  }

  const validated = nextBinding == null ? null : validateBindingTarget(projectRoot, nextBinding);
  const next = {
    schema_version: descriptor.schema_version,
    project_id: descriptor.project_id,
    repository: descriptor.repository,
    integration_mode: descriptor.integration_mode,
    capabilities: descriptor.capabilities,
    validation: descriptor.validation,
    artifacts: descriptor.artifacts,
    events: descriptor.events,
    boundaries: descriptor.boundaries,
    governance: validated,
  };
  return writeDescriptor(projectRoot, next);
}

function status(projectRoot) {
  const descriptor = readDescriptor(projectRoot);
  let resolved = null;
  try {
    resolved = resolveGovernanceRoot(projectRoot);
  } catch (_) {
    resolved = null;
  }
  return {
    project_id: descriptor.project_id,
    repository: descriptor.repository,
    governance: descriptor.governance,
    local_resolution: resolved
      ? {
          mode: resolved.mode,
          agent_root: resolved.agent_root,
          binding_path: resolved.binding_path,
        }
      : null,
  };
}

function attach(projectRoot, binding) {
  const descriptor = readDescriptor(projectRoot);
  const current = descriptor.governance || null;
  const next = validateBindingTarget(projectRoot, binding);

  if (current && current.kind === "filesystem" && current.locator === ".agent") {
    const local = resolveGovernanceRoot(projectRoot);
    if (next.kind === "filesystem") {
      const target = fs.realpathSync(path.resolve(projectRoot, next.locator));
      if (local.agent_root !== target) {
        throw lifecycleError(
          "ERR_GOVERNANCE_MIGRATION_REQUIRED",
          "Embedded governance data must be migrated before attaching a different detached root.",
          { current: local.agent_root, target },
        );
      }
    } else {
      throw lifecycleError(
        "ERR_GOVERNANCE_MIGRATION_REQUIRED",
        "Embedded governance data must be migrated before attaching a remote Git binding.",
        { current },
      );
    }
  }

  return updateBinding(projectRoot, next, { expected_current: current });
}

function detach(projectRoot, options = {}) {
  const current = currentBinding(projectRoot);
  if (!current) return readDescriptor(projectRoot);
  if (current.kind === "filesystem" && current.locator === ".agent") {
    throw lifecycleError("ERR_GOVERNANCE_EMBEDDED_DETACH_UNSUPPORTED", "Embedded governance cannot be detached without MS-008 migration.");
  }
  if (options.expected_current && !bindingEquals(current, normalizeGovernanceBinding(options.expected_current))) {
    throw lifecycleError("ERR_GOVERNANCE_BINDING_CONFLICT", "Current governance binding does not match expected binding.");
  }
  return updateBinding(projectRoot, null, { expected_current: current });
}

function rebind(projectRoot, nextBinding, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(options, "expected_current")) {
    throw lifecycleError("ERR_GOVERNANCE_EXPECTED_BINDING_REQUIRED", "rebind requires expected_current.");
  }
  return updateBinding(projectRoot, nextBinding, { expected_current: options.expected_current });
}

module.exports = {
  DESCRIPTOR_NAME,
  descriptorPath,
  readDescriptor,
  writeDescriptor,
  createDefaultDescriptor,
  ensureProjectDescriptor,
  currentBinding,
  bindingEquals,
  validateBindingTarget,
  updateBinding,
  status,
  attach,
  detach,
  rebind,
};
