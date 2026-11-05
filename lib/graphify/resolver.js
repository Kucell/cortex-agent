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
const crypto = require("node:crypto");

const manifestLib = require("./manifest");
const policyLib = require("./policy");
const worktreeLib = require("./worktree");
const markersLib = require("./markers");
const densityFiles = require("./density-files");

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
  STALE_MARKER: "stale_marker_pending",
  STALE_MARKER_UNREADABLE: "stale_marker_unreadable",
});

// The COMMIT MARKER of a publication: one file that names the digests of
// the published graph and manifest. The framework publishes several files
// into the public directory, and several renames are not one atomic step:
// the marker is the single point at which the set of files becomes the
// new state. A reader that finds digests that do not match the files next
// to them is looking at a directory that is between two publications, and
// it fails closed.
const COMMIT_FILENAME = ".density-commit.json";

// The schema of the commit marker. A marker of another schema is not read
// as if it were this one.
const COMMIT_SCHEMA_VERSION = "1.0";

// The files a publication consists of. A published marker describes ALL of
// them: a marker that names one of them only does not speak for the
// directory, and it is not read as if it did.
const COMMIT_FILES = Object.freeze(["graph.json", "manifest.json"]);

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
    const verdict = evaluateCandidate({
      candidate: cand,
      policy: effectivePolicy,
      git,
      now,
      projectRoot,
    });
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
function evaluateCandidate({ candidate, policy, git, now, projectRoot }) {
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
  // The commit marker of the publication: it is checked when it speaks
  // for the files that are there. A marker that is OLDER than a file was
  // written by somebody else -- the Graphify CLI rebuilds the public
  // directory on its own -- and it says nothing about that rebuild, so it
  // is not used to judge it.
  const commit = readCommitMarker(candidate.path, projectRoot);
  if (commit.present) {
    if (!commit.ok) {
      result.staleReasons.push("commit_invalid");
    } else if (commit.state !== "published") {
      // The publication did not finish: the marker says so, and the reader
      // fails closed instead of reading a directory that is in doubt.
      result.staleReasons.push("commit_incomplete");
    } else {
      const verdict = checkCommitMarker(candidate.path, commit);
      if (verdict.mismatch) result.staleReasons.push("commit_mismatch");
    }
  }
  const marker = markersLib.inspectMarker(candidate.path);
  if (!marker.ok) {
    result.staleReasons.push(REASON.STALE_MARKER_UNREADABLE);
  } else if (marker.pending) {
    result.staleReasons.push(REASON.STALE_MARKER);
  }
  result.accepted = true;
  result.reason = candidate.reasonCode;
  return result;
}

/**
 * The commit marker of a publication, if there is one.
 *
 * Returns { present: false } when there is no marker, { present: true,
 * ok: false } when the marker cannot be read, and { present: true, ok:
 * true, files, mtimeMs } otherwise.
 */
function readCommitMarker(graphRoot, projectRoot) {
  const candidates = commitMarkerCandidates(graphRoot, projectRoot);
  if (candidates.length === 0) return { present: false };
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  // No marker anywhere: the directory was published by an older version
  // and is read with the manifest invariants alone.
  if (!file) return { present: false };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    // A directory that never had a marker is a directory of an older
    // version: it is read with the manifest invariants alone. A marker
    // that EXISTS but cannot be read is a different fact: the protocol is
    // in use here, and the reader cannot know what it says -- so it fails
    // closed instead of pretending that there is no marker.
    if (err && err.code === "ENOENT") return { present: false };
    return { present: true, ok: false, reason: "unreadable" };
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  if (!parsed || typeof parsed !== "object") return { present: true, ok: false, reason: "corrupt" };
  if (parsed.schemaVersion !== COMMIT_SCHEMA_VERSION) return { present: true, ok: false, reason: "schema" };
  // The state is EXPLICIT: a marker without a state is not a marker of
  // this protocol, and it is not read as if it were one.
  if (parsed.state !== "publishing" && parsed.state !== "published") {
    return { present: true, ok: false, reason: "state" };
  }
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { mtimeMs = 0; }
  if (parsed.state === "publishing") {
    return { present: true, ok: true, files: {}, mtimeMs, state: "publishing" };
  }
  // The published state DESCRIBES the files that were published. A
  // description that is empty, or that carries an entry without a digest
  // and a modification time, says nothing -- and it is not read as if it
  // said everything.
  if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
    return { present: true, ok: false, reason: "files" };
  }
  const names = Object.keys(parsed.files);
  if (names.length === 0) return { present: true, ok: false, reason: "files" };
  // A published marker has to describe the WHOLE publication: every file
  // of the publication that is there has to be named, and nothing else may
  // be named. A marker that leaves one of them out does not speak for the
  // directory -- and the file it leaves out is exactly the file a
  // mismatch could hide in.
  if (names.length !== COMMIT_FILES.length) {
    return { present: true, ok: false, reason: "files" };
  }
  const described = COMMIT_FILES.filter((name) => fs.existsSync(path.join(graphRoot, name)));
  if (described.length !== COMMIT_FILES.length) {
    return { present: true, ok: false, reason: "files" };
  }
  for (const name of names) {
    if (!COMMIT_FILES.includes(name)) return { present: true, ok: false, reason: "files" };
    if (!described.includes(name)) return { present: true, ok: false, reason: "files" };
  }
  for (const name of described) {
    if (!names.includes(name)) return { present: true, ok: false, reason: "files" };
  }
  if (names.length !== described.length) {
    return { present: true, ok: false, reason: "files" };
  }
  for (const name of names) {
    const entry = parsed.files[name];
    if (!entry || typeof entry !== "object") return { present: true, ok: false, reason: "entry" };
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      return { present: true, ok: false, reason: "entry" };
    }
    if (typeof entry.mtimeMs !== "number" || !Number.isFinite(entry.mtimeMs)) {
      return { present: true, ok: false, reason: "entry" };
    }
  }
  // The marker describes ONE directory. A marker of another directory is
  // not used to judge this one.
  if (parsed.graphRoot && realPathOf(parsed.graphRoot) !== realPathOf(graphRoot)) {
    return { present: false };
  }
  return { present: true, ok: true, files: parsed.files, mtimeMs, state: "published" };
}

/**
 * Whether the files still are the ones the marker describes.
 *
 * A file that was REWRITTEN after the marker was published belongs to a
 * later generation: the marker does not speak for it any more. That is
 * the evidence that the directory was rebuilt outside of this protocol --
 * the Graphify CLI rebuilds the public directory on its own -- and the
 * manifest invariants are then the judge.
 *
 * The evidence has to be COMPLETE: a rebuild replaces every file the
 * marker describes. A directory in which only some of them changed is a
 * directory that is in the middle of something -- a publication that was
 * interrupted, or a writer that replaced one file -- and it fails closed.
 *
 * Returns { mismatch }.
 */
function checkCommitMarker(graphRoot, commit) {
  const names = Object.keys(commit.files);
  let rewritten = 0;
  for (const name of names) {
    const file = path.join(graphRoot, name);
    let digest = null;
    let mtimeMs = 0;
    try {
      digest = hashFile(file);
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (_) {
      digest = null;
    }
    if (!digest) return { mismatch: true };
    if (digest === commit.files[name].sha256) continue;
    // The content is not the one the marker describes. It was rewritten
    // after the marker was published, or it was changed without the marker
    // knowing -- and the second case is a directory that is in doubt.
    if (mtimeMs > commit.mtimeMs + 1) {
      rewritten += 1;
      continue;
    }
    return { mismatch: true };
  }
  if (rewritten > 0 && rewritten < names.length) return { mismatch: true };
  // Every file was rewritten after the marker: the directory was rebuilt
  // outside of this protocol, and the marker does not judge it.
  return { mismatch: false };
}

/**
 * Where the commit marker of a graph directory lives.
 *
 * The marker is RUNTIME STATE of the plugin: it lives under `.agent/`,
 * where the ignore rules of the project cover it, and not in the source
 * tree next to the graph.
 */
function commitMarkerPath(graphRoot) {
  const root = path.dirname(path.resolve(String(graphRoot || "")));
  if (!root) return null;
  return path.join(root, ".agent", "plugins", "graphify", COMMIT_FILENAME);
}

/**
 * Every place the commit marker of a publication may live, most specific
 * first.
 *
 * The publisher writes the marker into the WORKTREE-ISOLATED state
 * directory (`.density-worktrees/<worktree-key>/`), because two
 * worktrees of the same repository must not fight over one marker. A
 * reader that only looked at the plugin configuration directory would
 * therefore never see the marker of the publication it is asked to judge
 * — and a reader that looked nowhere else would miss the marker a
 * project wrote before the isolation existed.
 *
 * So the reader asks BOTH places: the isolated state directory first, the
 * legacy configuration directory second. The legacy entry only matters
 * for a project that published before the isolation; a marker found
 * there is judged by the same invariants (graph root, file digests), so
 * a stale one fails closed instead of passing a half-published graph.
 */
function commitMarkerCandidates(graphRoot, projectRoot) {
  const candidates = [];
  const push = (root) => {
    if (!root) return;
    const configDir = path.join(root, ".agent", "plugins", "graphify");
    candidates.push(path.join(
      configDir,
      ".density-worktrees",
      densityFiles.worktreeKey(root),
      COMMIT_FILENAME,
    ));
    candidates.push(path.join(configDir, COMMIT_FILENAME));
  };
  push(projectRoot);
  push(path.dirname(path.resolve(String(graphRoot || ""))));
  return candidates.filter((item, index) => candidates.indexOf(item) === index);
}

/**
 * The real path of a target, when it can be resolved.
 */
function realPathOf(target) {
  try {
    return fs.realpathSync(target);
  } catch (_) {
    return path.resolve(String(target || ""));
  }
}

/**
 * The digest of a file, or null when it cannot be read.
 */
function hashFile(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (_) {
    return null;
  }
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
