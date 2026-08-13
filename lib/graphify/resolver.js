"use strict";

/**
 * Graphify Context Resolver (T-GWG-001 / P-001 §4.2–§4.5).
 *
 * A pure, dependency-light function that takes a request path + options,
 * inspects Git worktrees, candidate graph directories, the policy, and
 * the manifest, and returns the structured resolver result the spec
 * requires.
 *
 * The resolver NEVER mutates state, NEVER runs the Graphify binary, and
 * NEVER installs anything. It only classifies graph availability.
 *
 * Output shape (mirrors the spec example):
 *   {
 *     available: boolean,
 *     not_applicable?: boolean,
 *     policy: "off" | "advisory" | "required-for-topology",
 *     mode: string,                    // resolution mode label
 *     requestedRoot: string,           // absolute path that was asked
 *     graphRoot: string | null,        // absolute path of selected graph
 *     generatedAt: string | null,
 *     graphAgeDays: number | null,
 *     sourceHead: string | null,
 *     currentHead: string | null,
 *     staleReasons: string[],
 *     branchDeltaRequired: boolean,
 *     fallbackReason: string | null,
 *     manifestDigest: string | null,
 *     schemaVersion: string | null,
 *     graphifyVersion: string | null,
 *     generationMode: string | null,
 *     candidate: {
 *       kind: "self" | "primary-worktree" | "override" | "missing" | "not_applicable",
 *       reason: string,
 *     },
 *     rejected: Array<{ path, reason }>,
 *   }
 *
 * `not_applicable` is set when Graphify is not part of this project
 * (no plugin, no `.agent/plugins/graphify` directory). It is the explicit
 * "no-op" signal callers must surface; nothing further is attempted.
 */

const fs = require("node:fs");
const path = require("node:path");

const manifestLib = require("./manifest");
const policyLib = require("./policy");
const worktreeLib = require("./worktree");

const REASON = Object.freeze({
  NOT_APPLICABLE: "not_applicable",
  NOT_INSTALLED: "graphify_not_installed",
  POLICY_OFF: "policy_off",
  POLICY_OFF_NOT_APPLICABLE: "policy_off",
  MISSING: "graph_missing",
  CORRUPT: "graph_corrupt",
  INCOMPATIBLE: "schema_incompatible",
  STALE_AGE: "graph_too_old",
  STALE_HEAD: "source_head_not_ancestor",
  STALE_DIRTY: "working_tree_dirty",
  BRANCH_ADVANCED: "branch_advanced",
  PRIMARY_FALLBACK: "primary_worktree_fallback",
  SELF: "self_worktree",
  OVERRIDE: "explicit_override",
  UPDATE_FAILED: "update_failed",
});

/**
 * Resolve the Graphify context for a project path. All inputs are
 * injectable so tests can run with deterministic fixtures.
 *
 * options:
 *   projectRoot           absolute path the request originates from
 *   policy                optional pre-loaded policy object (overrides loadPolicy)
 *   gitContext            optional pre-resolved git context (overrides resolveGitContext)
 *   includeDirtyCheck     include the working-tree dirty extent (default true)
 *   now                   ISO string override for deterministic tests
 *   pluginDir             optional override for the project plugin directory
 */
function resolveContext(options = {}) {
  const {
    projectRoot = process.cwd(),
    policy = null,
    gitContext = null,
    includeDirtyCheck = true,
    now = null,
    pluginDir = null,
  } = options;

  const out = freshOutput(projectRoot);

  // 1. Plugin presence → opt-in gate. The plugin directory is the contract
  // surface that proves the project opted into the integration. Without
  // it we MUST return `not_applicable` and never touch the filesystem
  // beyond a single stat() call.
  const resolvedPluginDir = pluginDir || path.join(projectRoot, ".agent", "plugins", "graphify");
  if (!fs.existsSync(resolvedPluginDir)) {
    out.not_applicable = true;
    out.available = false;
    out.policy = "off";
    out.candidate = { kind: "not_applicable", reason: REASON.NOT_APPLICABLE };
    return out;
  }

  // 2. Load policy (config.yml governance block + optional local override).
  const pluginConfigPath = path.join(resolvedPluginDir, "config.yml");
  const effectivePolicy = policy || policyLib.loadPolicy({
    projectRoot,
    pluginConfigPath,
  });
  out.policy = effectivePolicy.mode;

  if (effectivePolicy.mode === "off") {
    out.available = false;
    out.candidate = { kind: "not_applicable", reason: REASON.POLICY_OFF };
    return out;
  }

  // 3. Resolve Git context.
  const git = gitContext || worktreeLib.resolveGitContext(projectRoot);
  if (!git.ok) {
    out.available = false;
    out.fallbackReason = `git_unavailable:${git.reason}`;
    out.candidate = { kind: "missing", reason: REASON.NOT_INSTALLED };
    return out;
  }
  out.currentHead = git.head;
  out.branch = git.branch;

  // 4. Candidate selection. Order: explicit override → self → primary.
  const candidates = buildCandidateList({ projectRoot, git, policy: effectivePolicy });
  out.rejected = [];

  let selected = null;
  for (const cand of candidates) {
    const verdict = evaluateCandidate({ candidate: cand, policy: effectivePolicy, git, now });
    if (verdict.accepted) {
      selected = { ...cand, ...verdict };
      break;
    }
    out.rejected.push({ path: cand.path, reason: verdict.reason });
  }

  if (!selected) {
    out.available = false;
    out.fallbackReason = out.rejected.length
      ? out.rejected[out.rejected.length - 1].reason
      : REASON.MISSING;
    out.candidate = { kind: "missing", reason: REASON.MISSING };
    return out;
  }

  // 5. Hydrate structured output from the selected candidate.
  out.graphRoot = selected.path;
  out.generatedAt = selected.generatedAt;
  out.sourceHead = selected.sourceHead;
  out.manifestDigest = selected.manifestDigest;
  out.schemaVersion = selected.schemaVersion;
  out.graphifyVersion = selected.graphifyVersion;
  out.generationMode = selected.generationMode;
  out.candidate = {
    kind: selected.kind,
    reason: selected.reasonCode,
  };
  out.available = !selected.staleReasons.length;
  out.staleReasons = selected.staleReasons.slice();
  out.mode = selected.kind === "primary-worktree"
    ? "primary-worktree-fallback"
    : (selected.kind === "override" ? "explicit-override" : "self-worktree");

  // 6. Graph age (days) — recompute available after aging evidence lands.
  if (out.generatedAt) {
    const age = ageInDays(out.generatedAt, now);
    out.graphAgeDays = age;
    if (age !== null && age > effectivePolicy.max_age_days) {
      pushUnique(out.staleReasons, REASON.STALE_AGE);
    }
  }

  // 7. Branch-delta readback requirement.
  let branchDeltaRequired = false;
  if (effectivePolicy.require_branch_delta_readback) {
    if (git.head && out.sourceHead && git.head !== out.sourceHead) {
      branchDeltaRequired = true;
      pushUnique(out.staleReasons, REASON.BRANCH_ADVANCED);
    }
    if (includeDirtyCheck) {
      const dirty = worktreeLib.collectDirtyExtent(git.worktreePath);
      if (dirty.ok && dirty.total > 0) {
        branchDeltaRequired = true;
        pushUnique(out.staleReasons, REASON.STALE_DIRTY);
      }
    }
  }
  out.branchDeltaRequired = branchDeltaRequired;
  // Final availability verdict: stale reasons present (any kind) ⇒ not
  // available. Branch-delta readback keeps the graph usable but flags it
  // for source readback, so we keep `available` true while still emitting
  // the reason code (matches P-001 §4.5 semantics).
  // `legacy_unverified` is a soft warning under advisory mode: the graph
  // is usable but cannot be cross-checked. Required mode treats it as a
  // hard stale.
  const softReasons = new Set([
    REASON.BRANCH_ADVANCED,
    REASON.STALE_DIRTY,
  ]);
  const advisorySoft = new Set([
    "legacy_unverified",
  ]);
  const hardStale = out.staleReasons.filter((r) => {
    if (softReasons.has(r)) return false;
    if (advisorySoft.has(r) && effectivePolicy.mode !== "required-for-topology") return false;
    return true;
  });
  out.available = hardStale.length === 0;

  // 8. Surface digest + generation mode for evidence.
  return out;
}

/**
 * Build the ordered candidate list per P-001 §4.2.
 */
function buildCandidateList({ projectRoot, git, policy }) {
  const candidates = [];

  // Explicit per-worktree override first.
  const overrideDir = path.join(projectRoot, ".agent", "plugins", "graphify", "override");
  if (fs.existsSync(overrideDir)) {
    candidates.push({
      kind: "override",
      path: overrideDir,
      reasonCode: REASON.OVERRIDE,
    });
  }

  // Self-worktree graph.
  const selfDir = path.join(projectRoot, "graphify-out");
  if (fs.existsSync(selfDir)) {
    candidates.push({
      kind: "self",
      path: selfDir,
      reasonCode: REASON.SELF,
    });
  }

  // Primary worktree fallback (only when policy permits).
  if (policy.allow_primary_worktree_fallback && git.primary && git.primary.path !== projectRoot) {
    const primaryDir = path.join(git.primary.path, "graphify-out");
    if (fs.existsSync(primaryDir)) {
      candidates.push({
        kind: "primary-worktree",
        path: primaryDir,
        reasonCode: REASON.PRIMARY_FALLBACK,
        primaryPath: git.primary.path,
      });
    }
  }

  return candidates;
}

/**
 * Evaluate a single candidate against manifest invariants and freshness
 * rules. Returns { accepted, staleReasons, sourceHead, generatedAt, ... }.
 */
function evaluateCandidate({ candidate, policy, git, now }) {
  const result = {
    accepted: false,
    reason: REASON.MISSING,
    reasonCode: candidate.reasonCode,
    staleReasons: [],
    generatedAt: null,
    sourceHead: null,
    schemaVersion: null,
    graphifyVersion: null,
    generationMode: null,
    manifestDigest: null,
  };
  const graphFile = path.join(candidate.path, "graph.json");
  const manifestResult = manifestLib.readManifest(candidate.path);
  if (!fs.existsSync(graphFile)) {
    result.reason = REASON.MISSING;
    return result;
  }
  // Read graph payload once to validate integrity.
  let graph = null;
  try {
    graph = JSON.parse(fs.readFileSync(graphFile, "utf8"));
  } catch (err) {
    result.reason = REASON.CORRUPT;
    return result;
  }
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.links)) {
    result.reason = REASON.CORRUPT;
    return result;
  }
  // Manifest-driven classifications.
  if (!manifestResult.ok) {
    if (policy.mode === "required-for-topology") {
      result.reason = REASON.INCOMPATIBLE;
      return result;
    }
    // advisory → continue but mark `legacy-unverified`.
    result.staleReasons.push("legacy_unverified");
  } else {
    const m = manifestResult.manifest;
    result.schemaVersion = m.schemaVersion;
    result.graphifyVersion = m.graphifyVersion;
    result.generationMode = m.generationMode;
    result.generatedAt = m.generatedAt;
    result.sourceHead = m.sourceHead;
    if (!manifestLib.SUPPORTED_MAJOR_VERSIONS.has(parseInt(String(m.schemaVersion).split(".")[0], 10))) {
      result.reason = REASON.INCOMPATIBLE;
      return result;
    }
    if (manifestResult.errors.length) {
      result.staleReasons.push("manifest_invalid");
    }
    // Digest ties the receipt to the persisted manifest.
    result.manifestDigest = manifestLib.computeManifestDigest(m);
    if (m.nodeCount !== graph.nodes.length || m.edgeCount !== graph.links.length) {
      result.staleReasons.push("manifest_count_mismatch");
    }
  }
  // Schema-major mismatch from the on-disk graph, when present.
  if (graph.schema_version) {
    const major = parseInt(String(graph.schema_version).split(".")[0], 10);
    if (!manifestLib.SUPPORTED_MAJOR_VERSIONS.has(major)) {
      result.reason = REASON.INCOMPATIBLE;
      return result;
    }
  }
  result.accepted = true;
  result.reason = candidate.reasonCode;
  return result;
}

function freshOutput(projectRoot) {
  return {
    available: false,
    not_applicable: false,
    policy: "advisory",
    mode: null,
    requestedRoot: projectRoot,
    graphRoot: null,
    generatedAt: null,
    graphAgeDays: null,
    sourceHead: null,
    currentHead: null,
    staleReasons: [],
    branchDeltaRequired: false,
    fallbackReason: null,
    manifestDigest: null,
    schemaVersion: null,
    graphifyVersion: null,
    generationMode: null,
    candidate: { kind: "missing", reason: REASON.MISSING },
    rejected: [],
    branch: null,
  };
}

function ageInDays(isoNow, nowIso) {
  const then = Date.parse(isoNow);
  const ref = nowIso ? Date.parse(nowIso) : Date.now();
  if (Number.isNaN(then) || Number.isNaN(ref)) return null;
  const ms = ref - then;
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

function pushUnique(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

module.exports = {
  resolveContext,
  REASON,
  // Exported for unit tests:
  buildCandidateList,
  evaluateCandidate,
  ageInDays,
};