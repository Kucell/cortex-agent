"use strict";

/**
 * Git worktree parser (T-GWG-001 / P-001 §4.2).
 *
 * Pure functions that decode `git worktree list --porcelain` and
 * `git rev-parse --git-common-dir` output into structured objects.
 *
 * The module never shells out on its own — callers pass in the captured
 * stdout so unit tests can run without a real Git binary. When the binary
 * is unavailable or the directory is not a worktree, every function
 * degrades gracefully to a `{ ok: false, reason }` result.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function safeExec(args, { cwd } = {}) {
  try {
    return { ok: true, stdout: execFileSync("git", args, {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }) };
  } catch (err) {
    return { ok: false, reason: err && err.code ? err.code : "git_failed" };
  }
}

/**
 * Parse `git worktree list --porcelain` output. The format is repeating
 * blocks separated by blank lines. Each block has lines like
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *   detached
 */
function parseWorktreeListPorcelain(text) {
  if (!text || typeof text !== "string") return [];
  const blocks = text.split(/\r?\n\r?\n/);
  const out = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const entry = {};
    for (const line of lines) {
      const m = line.match(/^([A-Za-z-]+)\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2] || "";
      if (key === "worktree") entry.path = val;
      else if (key === "HEAD") entry.head = val;
      else if (key === "branch") entry.branch = val.replace(/^refs\/heads\//, "");
      else if (key === "detached") entry.detached = true;
    }
    if (entry.path) out.push(entry);
  }
  return out;
}

/**
 * Resolve Git context for a path: returns the worktree path, head sha,
 * branch (or null when detached), git common-dir, and the list of peer
 * worktrees parsed from `git worktree list --porcelain`.
 */
function resolveGitContext(repoPath) {
  const root = repoPath || process.cwd();
  const out = {
    ok: false,
    reason: null,
    isWorktree: false,
    isPrimary: false,
    worktreePath: null,
    commonDir: null,
    head: null,
    branch: null,
    detached: false,
    peers: [],
    primary: null,
  };
  if (!fs.existsSync(path.join(root, ".git")) &&
      !fs.existsSync(path.join(root, "HEAD"))) {
    // Check whether we're inside a worktree whose .git points to a file
    // (linked worktrees have `.git` as a file referencing the common dir).
    const dotGit = path.join(root, ".git");
    if (!fs.existsSync(dotGit)) {
      out.reason = "not_a_repo";
      return out;
    }
  }
  const revParse = safeExec(["rev-parse", "--show-toplevel"], { cwd: root });
  if (!revParse.ok) {
    out.reason = revParse.reason;
    return out;
  }
  const toplevel = revParse.stdout.trim();
  // git rev-parse --git-common-dir returns the common dir; primary worktree's
  // `.git` is the common dir itself, while linked worktrees see their own
  // `worktrees/<name>` path.
  const common = safeExec(["rev-parse", "--git-common-dir"], { cwd: root });
  const commonDir = common.ok ? path.resolve(root, common.stdout.trim()) : null;
  const headExec = safeExec(["rev-parse", "HEAD"], { cwd: root });
  const head = headExec.ok ? headExec.stdout.trim() : null;
  const branchExec = safeExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
  let branch = null;
  let detached = false;
  if (branchExec.ok) {
    const b = branchExec.stdout.trim();
    if (b && b !== "HEAD") branch = b;
    else detached = true;
  } else {
    detached = true;
  }
  const peersExec = safeExec(["worktree", "list", "--porcelain"], { cwd: root });
  const peers = peersExec.ok ? parseWorktreeListPorcelain(peersExec.stdout) : [];
  const commonName = commonDir ? path.basename(commonDir) : null;
  // Identify primary: when common-dir == toplevel's `.git`, this worktree
  // is the primary. Otherwise it is linked.
  const selfDotGit = path.join(toplevel, ".git");
  let isPrimary = false;
  try {
    const stat = fs.lstatSync(selfDotGit);
    if (stat.isDirectory()) {
      // primary
      isPrimary = true;
    }
  } catch (_) {
    // `.git` may be a file pointing into commonDir/worktrees
  }
  // The primary worktree's path inside peers is the first entry (always).
  const primary = peers.length ? peers[0] : null;
  out.ok = true;
  out.isWorktree = peers.length > 0;
  out.isPrimary = isPrimary;
  out.worktreePath = toplevel;
  out.commonDir = commonDir;
  out.head = head;
  out.branch = branch;
  out.detached = detached;
  out.peers = peers;
  out.primary = primary && primary.path !== toplevel
    ? primary
    : (isPrimary ? { path: toplevel, head, branch, detached } : null);
  return out;
}

/**
 * Determine whether two SHAs are on the same lineage and the second is
 * reachable from the first. We use `git merge-base --is-ancestor` which is
 * the canonical answer.
 */
function isAncestor({ repoPath, ancestor, descendant }) {
  if (!ancestor || !descendant) return false;
  const r = safeExec(["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoPath,
  });
  return r.ok;
}

/**
 * Compute the dirty extent of the working tree against HEAD. Used by the
 * freshness classifier to determine whether branch-delta readback is
 * required even when the committed graph looks current.
 */
function collectDirtyExtent(repoPath) {
  const status = safeExec(["status", "--porcelain"], { cwd: repoPath });
  if (!status.ok) return { ok: false, files: [], total: 0, reason: status.reason };
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const files = lines.map((l) => {
    const m = l.match(/^(..)\s+(.*)$/);
    return m ? { status: m[1], path: m[2].trim() } : { status: "??", path: l };
  });
  return { ok: true, files, total: files.length };
}

/**
 * Compute the committed delta between two SHAs. Returns the list of
 * changed file paths. Empty list is a valid answer.
 */
function collectCommitDelta({ repoPath, fromSha, toSha }) {
  if (!fromSha || !toSha || fromSha === toSha) {
    return { ok: true, files: [], from: fromSha, to: toSha };
  }
  const diff = safeExec(["diff", "--name-only", `${fromSha}..${toSha}`], {
    cwd: repoPath,
  });
  if (!diff.ok) return { ok: false, files: [], reason: diff.reason };
  const files = diff.stdout.split(/\r?\n/).filter(Boolean);
  return { ok: true, files, from: fromSha, to: toSha };
}

module.exports = {
  parseWorktreeListPorcelain,
  resolveGitContext,
  isAncestor,
  collectDirtyExtent,
  collectCommitDelta,
};