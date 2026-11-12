"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { validateRole, validateProjects } = require("./registry");
const { reject, object, text, strings, deriveAgentId, validateOwnedFiles } = require("./registry-identity");

const POLICY_PATH = ".agent/config/agent-registry.json";

function noSymlink(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    reject("ERR_REGISTRY_UNSAFE_PATH", "Registry paths must be regular files/directories, not symlinks");
  }
}

function validateGrant(grant) {
  object(grant, ["identity", "role", "model", "capabilities", "projects", "owned_files"]);
  deriveAgentId(grant.identity);
  validateRole(grant.role);
  text(grant.model, "model");
  strings(grant.capabilities, "capabilities");
  strings(grant.projects, "projects");
  validateProjects(grant.projects);
  validateOwnedFiles(grant.owned_files);
  const required = { implementer: ["code_generation", "test_writing"], reviewer: ["code_review"] };
  if ((required[grant.role] || []).some((cap) => !grant.capabilities.includes(cap))
      || (grant.role === "reviewer" && grant.capabilities.some((cap) =>
        ["code_generation", "test_writing"].includes(cap)))
      || (grant.role === "coordinator" && grant.capabilities.some((cap) =>
        ["code_generation", "test_writing", "code_review"].includes(cap)))) {
    reject("ERR_REGISTRY_CAPABILITY", "Role does not have a valid capability grant");
  }
  return grant;
}

function validatePolicy(policy) {
  object(policy, ["schema_version", "owner_id", "local_user", "project_id", "maintainers", "grants"]);
  if (policy.schema_version !== 1) reject("ERR_REGISTRY_INVALID", "Unsupported registry policy version");
  text(policy.owner_id, "owner_id");
  text(policy.local_user, "local_user");
  validateProjects([policy.project_id]);
  if (!Array.isArray(policy.maintainers) || policy.maintainers.length === 0
      || !Array.isArray(policy.grants)) reject("ERR_REGISTRY_INVALID", "Policy requires maintainers and grants");
  const maintainers = new Set();
  for (const maintainer of policy.maintainers) {
    object(maintainer, ["actor_id", "session_id", "projects"]);
    text(maintainer.actor_id, "actor_id");
    text(maintainer.session_id, "session_id");
    strings(maintainer.projects, "maintainer projects");
    validateProjects(maintainer.projects);
    const key = JSON.stringify([maintainer.actor_id, maintainer.session_id]);
    if (maintainers.has(key)) reject("ERR_REGISTRY_INVALID", "Duplicate maintainer session");
    maintainers.add(key);
  }
  const ids = new Set();
  for (const grant of policy.grants) {
    validateGrant(grant);
    const id = deriveAgentId(grant.identity);
    if (ids.has(id) || !grant.projects.includes(policy.project_id)) {
      reject("ERR_REGISTRY_INVALID", "Duplicate host identity or grant outside the policy project");
    }
    ids.add(id);
  }
  return policy;
}

function loadPolicy(projectRoot) {
  const root = path.resolve(projectRoot);
  const file = path.join(root, POLICY_PATH);
  try {
    noSymlink(path.join(root, ".agent"), true);
    noSymlink(path.dirname(file), true);
    noSymlink(file);
    const stat = fs.statSync(file);
    if (typeof process.getuid === "function"
        && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0)) {
      reject("ERR_REGISTRY_UNAUTHORIZED", "Owner policy must belong to the local user and not be group/world writable");
    }
    const raw = fs.readFileSync(file, "utf8");
    const policy = validatePolicy(JSON.parse(raw));
    if (policy.local_user !== os.userInfo().username) {
      reject("ERR_REGISTRY_UNAUTHORIZED", "OS user does not match the owner-provisioned local authority");
    }
    return { policy, sha256: createHash("sha256").update(raw).digest("hex") };
  } catch (error) {
    if (error.code && error.code.startsWith("ERR_REGISTRY")) throw error;
    reject("ERR_REGISTRY_POLICY", "Owner-provisioned .agent/config/agent-registry.json is missing or invalid");
  }
}

function authorize(projectRoot, auth, identity, { revokingProjects = null } = {}) {
  object(auth, ["actor_id", "session_id"]);
  text(auth.actor_id, "actor_id");
  text(auth.session_id, "session_id");
  const loaded = loadPolicy(projectRoot);
  const { policy } = loaded;
  const maintainer = policy.maintainers.find((item) =>
    item.actor_id === auth.actor_id && item.session_id === auth.session_id);
  if (!maintainer) reject("ERR_REGISTRY_UNAUTHORIZED", "Actor/session is not an owner-authorized Registry maintainer");
  const id = deriveAgentId(identity);
  const grant = policy.grants.find((item) => deriveAgentId(item.identity) === id);
  const projects = revokingProjects || grant?.projects;
  if (!projects || projects.some((project) => !maintainer.projects.includes(project))
      || !projects.includes(policy.project_id)) {
    reject("ERR_REGISTRY_UNAUTHORIZED", "Host identity or project scope is not granted to this maintainer");
  }
  // The policy is the local same-user authority. CLI JSON is only a selector;
  // it cannot add a role, model, capability or project to an owner's grant.
  return { ...loaded, grant };
}

module.exports = { POLICY_PATH, noSymlink, validateGrant, validatePolicy, loadPolicy, authorize };
