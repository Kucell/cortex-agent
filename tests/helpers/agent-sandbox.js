"use strict";

/**
 * Sandboxed `.agent` workspace for tests that drive the real governance scripts.
 *
 * Every governance script resolves its state paths from `process.cwd()` (ROOT),
 * not from `__dirname`:
 *
 *   const ROOT = process.cwd();
 *   const INDEX_FILE = path.join(ROOT, ".agent", "context-index.json");
 *
 * Running them with the repository as cwd therefore rewrites tracked runtime
 * artifacts (context-index.json, registry/uri-map.json, memory/MEMORY.md,
 * plans/context-manifest.json, metrics/*.json) in the developer's working copy
 * and leaves untracked debris behind (resources/external/**, trajectory/**,
 * tasks/evolution/**).
 *
 * The sandbox keeps the *scripts* in the real repository — several of them
 * require siblings through `__dirname` (`../../../../lib/commands/…`), which a
 * copied tree would break — and only redirects `cwd` to a throwaway copy of
 * `.agent/`. Everything the scripts read or write then resolves inside the
 * sandbox, and the real working copy stays untouched.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const AGENT_DIR = path.join(REPO_ROOT, ".agent");

// Left out of the sandbox copy: VCS metadata, heavy runtime payloads and
// symlinks that escape the repository. None of them are read by the scripts
// under test, and keeping them out is what prevents writes from leaking back
// into the real tree (or into the developer's home directory).
const EXCLUDED_TOP_LEVEL = new Set([
  ".git",
  "artifacts",
  "global",
  "global-shared-skills",
  "token-attempts",
  "shadow-observations",
]);

function shouldSkip(src) {
  const rel = path.relative(AGENT_DIR, src);
  if (!rel) return false;
  if (EXCLUDED_TOP_LEVEL.has(rel.split(path.sep)[0])) return true;
  // Symlinks under .agent point at absolute paths outside the repository
  // (e.g. ~/.agent/skills). Copying them would let a test write straight
  // through to the user's real home directory.
  try {
    if (fs.lstatSync(src).isSymbolicLink()) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * Create a throwaway project root holding a copy of `.agent/`.
 *
 * @param {object} [options]
 * @param {boolean} [options.git=true] – run `git init` so git-facing checks
 *   (worktree list, branch list, status) see a real repository.
 * @returns {{root: string, agentRoot: string, cleanup: () => void}}
 */
function createAgentSandbox(options = {}) {
  const { git = true } = options;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-agent-sandbox-"));
  const agentRoot = path.join(root, ".agent");

  // fs.cpSync keeps an entry when the filter returns true, so invert the
  // "should skip" predicate.
  fs.cpSync(AGENT_DIR, agentRoot, { recursive: true, filter: (src) => !shouldSkip(src) });

  if (git) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    } catch {
      // git is optional: without it the git-facing checks degrade to their
      // "no repository" branch instead of failing the suite.
    }
  }

  return {
    root,
    agentRoot,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

module.exports = { createAgentSandbox, AGENT_DIR, REPO_ROOT };
