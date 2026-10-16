"use strict";

// Package-owned, read-only diagnostic assembly. No project script is loaded.
// A descriptor binds a local observation; it is not a scope/owner attestation.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");
const { spawnSync } = require("node:child_process");
const { canonicalDirectory, resolveGovernanceRoot } = require("../governance/root.js");
const { normalizeProjectDescriptor } = require("../../packages/project-sdk/src/descriptor.js");
const { readCanonicalTaskSource } = require("./canonical-task-source.js");
const { readCanonicalPlanSources } = require("./canonical-plan-source.js");
const { buildNextActionProjection } = require("./index.js");

const CAPABILITY = Object.freeze({
  name: "next-action", kind: "aggregate", exact_lookup: false,
  data_field: null, filters: Object.freeze(["task"]), read_only: true,
});
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const TASK_ID = /^T-[A-Za-z0-9][A-Za-z0-9._-]*$/;

function failure(code, message, exitCode = 3) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}
function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function validateFilters(filters = {}) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(filters))
      || Object.keys(filters).some((key) => key !== "task")) {
    throw failure("INVALID_QUERY_OPTION", "next-action accepts only the task filter.", 2);
  }
  if (!Object.prototype.hasOwnProperty.call(filters, "task")) return null;
  const ids = Array.isArray(filters.task) ? filters.task.slice() : [filters.task];
  if (!ids.length || ids.length > 100 || new Set(ids).size !== ids.length
      || ids.some((id) => typeof id !== "string" || !TASK_ID.test(id) || id.includes(".."))) {
    throw failure("INVALID_QUERY_OPTION", "task must contain 1–100 unique canonical Task IDs.", 2);
  }
  return ids;
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function descriptorBytes(root) {
  const file = path.join(root, "cortex.project.json");
  let fd;
  try {
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_DESCRIPTOR_BYTES)) {
      throw new Error("unsafe descriptor node");
    }
    if (!Number.isInteger(fs.constants.O_NOFOLLOW) || fs.constants.O_NOFOLLOW <= 0
        || !Number.isInteger(fs.constants.O_NONBLOCK) || fs.constants.O_NONBLOCK <= 0) {
      throw new Error("safe descriptor flags unavailable");
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened)) throw new Error("descriptor changed");
    const buffer = Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (used > MAX_DESCRIPTOR_BYTES || BigInt(used) !== after.size
        || !after.isFile() || after.nlink !== 1n || !named.isFile() || named.nlink !== 1n
        || !sameFile(opened, after) || !sameFile(after, named)) throw new Error("descriptor changed");
    return buffer.subarray(0, used);
  } catch (_) {
    throw failure("ADVISOR_DESCRIPTOR_UNAVAILABLE", "A stable regular cortex.project.json is required.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function readBinding(project) {
  const bytes = descriptorBytes(project.root);
  let descriptor;
  try {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid UTF-8");
    descriptor = normalizeProjectDescriptor(JSON.parse(text));
  } catch (_) {
    throw failure("ADVISOR_DESCRIPTOR_INVALID", "cortex.project.json does not satisfy the project descriptor contract.");
  }
  return { descriptor, digest: "sha256:" + hash(bytes) };
}
function localRepository(root, locator) {
  if (typeof locator !== "string" || !locator.trim()) return null;
  try {
    if (locator.startsWith("file:")) return canonicalDirectory(fileURLToPath(locator));
    // A remote/scp locator is never contacted or interpreted as a local path.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(locator) || /^[^/\\]+@[^/\\]+:/.test(locator)) return null;
    return canonicalDirectory(path.resolve(root, locator));
  } catch (_) { return null; }
}
function localRef(value) {
  const ref = value === undefined || value === null ? "refs/heads/main"
    : typeof value === "string" && value.startsWith("refs/") ? value : "refs/heads/" + value;
  if (typeof ref !== "string" || !/^refs\/[A-Za-z0-9._/-]+$/.test(ref)
      || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")
      || ref.split("/").some((part) => part.endsWith(".lock") || part.startsWith("."))) return null;
  return ref;
}
function gitRead(repo, args, allowFailure = false) {
  // Only this diagnostic's Git reads use this environment. No inherited GIT_*
  // variables, Host configuration, Node preload, prompt, fetch, or replace refs.
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_PROTOCOL_FROM_USER: "0",
  };
  const result = spawnSync("git", ["--no-lazy-fetch", "--no-replace-objects", "-c", "protocol.allow=never", "-c", "core.fsmonitor=false", "-C", repo, ...args], {
    env, encoding: null, timeout: 5000, maxBuffer: MAX_DESCRIPTOR_BYTES + 1,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw failure("ADVISOR_GIT_READ_FAILED", "The bounded local Git read failed.");
  }
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw failure("ADVISOR_GIT_READ_FAILED", "Git output is not valid UTF-8.");
  return { ...result, stdout: text };
}
function resolveBoundProject(ctx) {
  if (!ctx || !Array.isArray(ctx.args) || typeof ctx.cwd !== "string") {
    throw failure("ERR_LOCAL_TRANSPORT_CONTEXT_REQUIRED", "A local command context is required.", 2);
  }
  const options = ctx.options || {};
  const explicitFlag = ctx.args.some((arg) => arg === "--project" || typeof arg === "string" && arg.startsWith("--project="));
  if (explicitFlag && !options.project) throw failure("INVALID_PROJECT_OPTION", "--project requires a non-empty path.", 2);
  let root;
  if (options.project) {
    if (typeof options.project !== "string") throw failure("INVALID_PROJECT_OPTION", "--project requires a path.", 2);
    root = canonicalDirectory(path.resolve(ctx.cwd, options.project));
  } else {
    const discovered = gitRead(ctx.cwd, ["rev-parse", "--show-toplevel"], true);
    if (discovered.status === 0) root = canonicalDirectory(String(discovered.stdout).trim());
    else if (discovered.status === 128 && /^fatal: not a git repository(?: |\n)/.test(String(discovered.stderr || ""))) root = canonicalDirectory(ctx.cwd);
    else throw failure("ADVISOR_PROJECT_DISCOVERY_FAILED", "Local Git project discovery failed.");
  }
  if (!root) throw failure("PROJECT_NOT_FOUND", "Unable to resolve the target project directory.");
  try {
    return { root, agent_root: resolveGovernanceRoot(root).agent_root };
  } catch (_) {
    throw failure("PROJECT_AGENT_NOT_FOUND", "Target project does not contain a readable .agent directory.");
  }
}
function createReadOnlyGitStore(repo, ref) {
  // Repository-wide immutable commit tokens; no writer/service/recovery API.
  function repositoryIdentity() {
    const bare = String(gitRead(repo, ["rev-parse", "--is-bare-repository"]).stdout).trim();
    const gitDir = canonicalDirectory(String(gitRead(repo, ["rev-parse", "--absolute-git-dir"]).stdout).trim());
    const worktree = bare === "false"
      ? canonicalDirectory(String(gitRead(repo, ["rev-parse", "--show-toplevel"]).stdout).trim()) : null;
    if (!gitDir || !["true", "false"].includes(bare)
        || (bare === "true" ? gitDir !== repo : worktree !== repo)) {
      throw failure("ADVISOR_GIT_BINDING_MISMATCH", "The governance locator must identify the actual repository root.");
    }
    return JSON.stringify({ bare, gitDir, worktree });
  }
  const identity = repositoryIdentity();
  const getRevision = () => {
    try {
      if (repositoryIdentity() !== identity) throw new Error("repository identity changed");
    } catch (_) {
      throw failure("ERR_ADVISOR_SNAPSHOT_CHANGED", "The bound Git repository identity changed.");
    }
    const read = gitRead(repo, ["rev-parse", "--verify", "--quiet", ref + "^{commit}"], true);
    const value = String(read.stdout || "").trim();
    return read.status === 0 && /^[0-9a-f]{40}$/.test(value) ? { store_kind: "git", value } : null;
  };
  return Object.freeze({
    kind: "git", getRevision,
    listEntries(namespace, options = {}) {
      if (!["missions", "decisions", "waitpoints"].includes(namespace)
          || !Number.isInteger(options.max_entries) || options.max_entries < 1 || options.max_entries > 512) {
        throw failure("ADVISOR_GIT_KEY_UNSUPPORTED", "Unsupported canonical namespace enumeration.");
      }
      const revision = getRevision();
      if (!revision) throw failure("ADVISOR_GIT_READ_FAILED", "The governance ref is unavailable.");
      const raw = gitRead(repo, ["ls-tree", "-r", "-z", revision.value, "--", namespace]).stdout;
      const lines = raw ? raw.split("\0") : [];
      if (lines.length && lines.pop() !== "") throw failure("ADVISOR_GIT_READ_FAILED", "Malformed canonical tree listing.");
      if (lines.length > options.max_entries) throw failure("ADVISOR_GIT_READ_FAILED", "Canonical namespace exceeds the entry limit.");
      const entries = lines.map((line) => {
        const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/.exec(line);
        if (!match || !match[3].startsWith(namespace + "/") || match[3].includes("..")
            || /[\u0000-\u001f\u007f\\]/.test(match[3])) throw failure("ADVISOR_GIT_READ_FAILED", "Unsafe canonical namespace node.");
        return { key: match[3], mode: match[1], type: "blob", blob: match[2] };
      });
      return { entries, revision };
    },
    readText(key, options = {}) {
      const allowed = typeof key === "string" && (/^tasks\/(?:index|T-[A-Za-z0-9][A-Za-z0-9._-]*)\.json$/.test(key)
        || /^missions\/M-[A-Za-z0-9][A-Za-z0-9._-]*\/(?:validation-contract\.json|advisory-plans\/AP-[A-Za-z0-9][A-Za-z0-9._-]*\.json)$/.test(key)
        || /^decisions\/D-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(key)
        || /^waitpoints\/WP-[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(key));
      const maxBytes = options.max_bytes === undefined ? MAX_DESCRIPTOR_BYTES : options.max_bytes;
      if (!allowed || key.includes("..") || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DESCRIPTOR_BYTES) {
        throw failure("ADVISOR_GIT_KEY_UNSUPPORTED", "Only bounded canonical advisor files are supported.");
      }
      const revision = getRevision();
      if (!revision) throw failure("ADVISOR_GIT_READ_FAILED", "The governance ref is unavailable.");
      const tree = gitRead(repo, ["ls-tree", "-z", revision.value, "--", key]).stdout;
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(tree);
      if (!match || match[3] !== key) throw failure("ADVISOR_GIT_READ_FAILED", "A regular canonical Task blob is required.");
      const blob = match[2];
      const size = String(gitRead(repo, ["cat-file", "-s", blob]).stdout).trim();
      if (!/^\d+$/.test(size) || Number(size) > maxBytes) throw failure("ADVISOR_GIT_READ_FAILED", "Canonical blob exceeds the read limit.");
      const content = gitRead(repo, ["cat-file", "-p", blob]).stdout;
      if (Buffer.byteLength(content, "utf8") !== Number(size)) throw failure("ADVISOR_GIT_READ_FAILED", "Canonical Task blob is not valid UTF-8.");
      return { ok: true, exists: true, content, revision, key, blob };
    },
  });
}
function queryBoundNextAction(ctx, filters = {}) {
  const ids = validateFilters(filters);
  const project = resolveBoundProject(ctx);
  const first = readBinding(project);
  const descriptor = first.descriptor;
  const projectRef = descriptor.project_ref;
  const observedAt = new Date().toISOString();
  const governance = descriptor.governance;
  const bindingRef = "binding:local-descriptor:" + hash(project.root + "\0" + first.digest);
  let revision = null;
  let tasks = { status: "unavailable", records: [], reason_codes: ["governance_binding_not_observed"], read_receipts: [] };
  let store = null;
  let planSources = null;
  let repo = null;
  let ref = null;
  if (governance && governance.kind === "filesystem") {
    tasks.reason_codes = ["filesystem_repository_snapshot_unsupported"];
  } else if (governance && governance.kind === "git") {
    repo = localRepository(project.root, governance.locator);
    ref = localRef(governance.ref);
    if (!repo) tasks.reason_codes = ["local_git_repository_unavailable"];
    else if (!ref) tasks.reason_codes = ["git_ref_unsupported"];
    else {
      try {
        store = createReadOnlyGitStore(repo, ref);
        const current = store.getRevision();
        if (!current || current.store_kind !== "git" || !/^[0-9a-f]{40}$/.test(current.value || "")) {
          tasks.reason_codes = ["governance_revision_not_observed"];
        } else {
          revision = { domain: "governance_store", store_kind: "git", value: current.value };
          tasks = readCanonicalTaskSource({
            store, project_ref: projectRef, governance_binding_ref: bindingRef,
            observed_at: observedAt, expected_revision: revision, task_ids: ids,
          });
          if (tasks.status === "observed") {
            planSources = readCanonicalPlanSources({ store, project_ref: projectRef,
              governance_binding_ref: bindingRef, observed_at: observedAt, expected_revision: revision, tasks });
            tasks = planSources.tasks;
            if (planSources.reason_codes.includes("governance_snapshot_changed")) {
              tasks = { ...tasks, status: "conflict", records: [], reason_codes: ["governance_snapshot_changed"] };
            }
          }
        }
      } catch (error) {
        tasks = { status: "unavailable", records: [], reason_codes: [error.code === "ADVISOR_GIT_BINDING_MISMATCH"
          ? "governance_locator_not_repository_root" : "local_git_task_read_failed"], read_receipts: [] };
      }
    }
  }
  // Recheck the binding and ref after the complete read. A conflict discards
  // every candidate, rather than retaining a mixed-project/mixed-ref result.
  try {
    const finalProject = resolveBoundProject(ctx);
    const finalBinding = readBinding(project);
    const current = store && store.getRevision();
    if (finalProject.root !== project.root
        || finalProject.agent_root !== project.agent_root || finalBinding.digest !== first.digest
        || (repo && localRepository(project.root, governance.locator) !== repo)
        || (revision && (!current || current.store_kind !== "git" || current.value !== revision.value))) {
      throw new Error("binding changed");
    }
  } catch (_) {
    tasks = { status: "conflict", records: [], reason_codes: ["project_binding_or_revision_changed"], read_receipts: [] };
    planSources = null;
  }
  const advisor = buildNextActionProjection({
    project_ref: projectRef, observed_at: observedAt, governance_revision: revision,
    governance_binding_ref: bindingRef,
    // A repository slug is a descriptor claim, not an observed product commit.
    repository_ref: null, sources: { tasks, ...(planSources ? {
      missions: planSources.missions, decisions: planSources.decisions, waitpoints: planSources.waitpoints,
    } : {}) },
  });
  return {
    project: { project_ref: projectRef, project_id: descriptor.project_id, root: project.root, agent_root: project.agent_root },
    payload: {
      ...advisor, query: "next-action", filters: ids ? { task: ids } : {},
      diagnostic_kind: "bound-task-gap-report",
      binding_observation: {
        project_ref: projectRef, descriptor_digest: first.digest, binding_ref: bindingRef,
        governance_kind: governance ? governance.kind : null,
        governance_revision: revision, authority_attested: false,
      },
      task_source: {
        status: tasks.status, reason_codes: tasks.reason_codes,
        read_receipts: tasks.read_receipts || [],
      },
      plan_source: planSources ? { status: planSources.status, reason_codes: planSources.reason_codes,
        read_receipts: planSources.read_receipts } : { status: "not_observed", reason_codes: ["canonical_plan_not_read"], read_receipts: [] },
      summary: { diagnostic_only: true, mapped_sources: ["tasks", ...(planSources && planSources.status === "observed"
        ? ["missions", "decisions", "waitpoints"] : [])], execution_authorized: false },
    },
  };
}

module.exports = { CAPABILITY, queryBoundNextAction, validateFilters };
