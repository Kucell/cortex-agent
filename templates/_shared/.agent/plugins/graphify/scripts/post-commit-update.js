#!/usr/bin/env node
"use strict";

/**
 * post-commit-update.js — Graphify post-commit hook (T-GWG-001 / P-001 §4.6).
 *
 * Thin wrapper that delegates the heavy lifting to lib/graphify/hook.js
 * so templates can stay focused on the user-visible contract. The hook:
 *   - exits 0 silently when the Graphify CLI is not installed
 *   - exits 0 silently when the project has no graph (no-op)
 *   - on code changes → runs `graphify update .`
 *   - on semantic-only changes → writes a stale marker
 *   - on update failure → writes an `update_failed` marker
 *
 * Never blocks the commit. Always exits 0 unless an internal error
 * throws (which is then swallowed by the wrapper).
 */

const path = require("path");

// Resolve lib/graphify/hook.js relative to this script's install path:
//   <project>/.agent/plugins/graphify/scripts/post-commit-update.js
// →  <project>/lib/graphify/hook.js
const candidates = [
  path.join(__dirname, "..", "..", "..", "..", "lib", "graphify", "hook.js"),
  path.join(__dirname, "..", "..", "lib", "graphify", "hook.js"),
];

let hookLib = null;
for (const candidate of candidates) {
  try {
    hookLib = require(candidate);
    break;
  } catch (_) {
    // try next
  }
}

if (!hookLib) {
  // Fallback: silently no-op. The hook is best-effort and must never
  // block the commit.
  process.exit(0);
}

// Collect the just-finished commit's diff so we can classify code vs
// semantic. We rely on `git show --name-only --pretty=format:` HEAD.
let changedPaths = [];
let sourceHead = null;
let branch = null;
try {
  const { execFileSync } = require("child_process");
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  sourceHead = head;
  const branchOut = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  branch = branchOut && branchOut !== "HEAD" ? branchOut : null;
  const nameOnly = execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  changedPaths = nameOnly.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
} catch (_) {
  // Could not enumerate commit; run the hook in degraded mode (no diff).
}

try {
  const result = hookLib.runPostCommit({
    cwd: process.cwd(),
    changedPaths,
    sourceHead,
    branch,
  });
  if (result && result.result) {
    if (result.result === hookLib.HOOK_RESULT.INCREMENTAL_OK) {
      console.log("[graphify] incremental update ok");
    } else if (result.result === hookLib.HOOK_RESULT.SEMANTIC_MARKED) {
      console.log("[graphify] semantic changes detected; stale marker written (queries will fail closed until next graph update)");
    } else if (result.result === hookLib.HOOK_RESULT.INCREMENTAL_FAILED) {
      console.warn("[graphify] incremental update failed; update_failed marker written. Run `graphify update .` manually.");
    }
  }
} catch (err) {
  // Never block the commit.
  console.warn("[graphify] hook error: " + (err && err.message ? err.message : String(err)));
}

process.exit(0);