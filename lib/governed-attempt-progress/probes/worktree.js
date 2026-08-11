"use strict";

// ─── Worktree Probe (M-013 SP-002 / VC-005b) ─────────────────────────────────
//
// Read-only git probe that captures:
//   - baselineHead   (sha of current HEAD)
//   - statusDigest   (sha256 of `git status --porcelain`)
//   - diffDigest     (sha256 of `git diff HEAD` summary — file + insertion/deletion counts)
//   - changedFileCount
//   - insertions
//   - deletions
//
// INVARIANTS (P-005 §6.1):
//   - The probe NEVER modifies index, files, or branches.
//   - It only reads status + diff + rev-parse output.
//   - No writes, no staging, no commits, no checkouts.
//
// CACHE (VC-005b): digest cache hit enables sub-millisecond repeat calls.
// Each result is memoized by cwd; subsequent calls return the cached object
// without shelling out.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");

// In-process cache: cwd → {result, computedAt}
const cache = new Map();
const CACHE_TTL_MS = 5000; // 5s freshness window

function clearCache() {
  cache.clear();
}

/**
 * Probe the worktree at the given path (read-only).
 *
 * @param {string} cwd - path to a git working tree
 * @returns {object} {head, baselineHead, statusDigest, diffDigest, changedFileCount, insertions, deletions}
 */
function probeWorktree(cwd) {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("probeWorktree: cwd must be a non-empty path");
  }

  // Cache check
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  // Read-only git invocations
  const head = safeExecFile("git", ["rev-parse", "HEAD"], cwd).trim();
  const statusPorcelain = safeExecFile("git", ["status", "--porcelain"], cwd);
  const diffNumstat = safeExecFile("git", ["diff", "--numstat", "HEAD"], cwd);

  const statusDigest = sha256(statusPorcelain);
  const diffDigest = sha256(diffNumstat);

  // Parse numstat: "<insertions>\t<deletions>\t<filename>"
  let changedFileCount = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of diffNumstat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
    insertions += ins;
    deletions += del;
    changedFileCount += 1;
  }

  const result = Object.freeze({
    head,
    baselineHead: head,
    statusDigest,
    diffDigest,
    changedFileCount,
    insertions,
    deletions,
  });
  cache.set(cwd, { result, computedAt: Date.now() });
  return result;
}

function sha256(input) {
  return "sha256:" + crypto.createHash("sha256").update(input).digest("hex");
}

function safeExecFile(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    // Empty worktree (no commits yet) returns rev-parse failure → empty head
    if (err && err.status === 128 && cmd === "git" && args[0] === "rev-parse") {
      return "unknown";
    }
    throw err;
  }
}

module.exports = {
  probeWorktree,
  clearCache,
};