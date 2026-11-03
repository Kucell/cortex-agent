#!/usr/bin/env node
"use strict";

/**
 * post-commit-update.js — Graphify post-commit hook (T-GWG-001 / P-001 §4.6).
 *
 * Thin wrapper that delegates the heavy lifting to the shared Graphify
 * implementation so templates can stay focused on the user-visible
 * contract. The hook:
 *   - exits 0 silently when the Graphify CLI is not installed
 *   - exits 0 silently when the project has no graph (no-op)
 *   - on code changes → runs `graphify update .`
 *   - on semantic-only changes → writes a stale marker
 *   - on update failure → writes an `update_failed` marker
 *   - after a successful update → runs the edge-density guard; when the
 *     incremental graph lost edge density, a detached full rebuild is
 *     started (issue #154)
 *   - on IMPLEMENTATION MISSING → writes a diagnostic marker and warns,
 *     because a silently inert hook looks exactly like a healthy one
 *
 * Never blocks the commit. Always exits 0 unless an internal error
 * throws (which is then swallowed by the wrapper).
 */

const fs = require("fs");
const path = require("path");

// Where the shared implementation may live, in resolution order.
//
// `__dirname` is the script's own directory inside the consumer project:
//   <project>/.agent/plugins/graphify/scripts
//
// 1. The implementation shipped with the plugin itself:
//      <project>/.agent/plugins/graphify/lib/graphify/hook.js
//    This is the path a `cortex-agent init` / `update` install produces, and
//    the one that keeps working when the project is never touched by npm.
// 2. The same tree reached from the script *file* rather than its directory:
//      <project>/.agent/lib/graphify/hook.js
// 3. The framework package installed next to the project (npm global install,
//    npx, or a checkout linked into node_modules):
//      <project>/node_modules/cortex-agent/lib/graphify/hook.js
// 4. The historical locations, kept so an existing project that still has
//    them keeps working:
//      <project>/lib/graphify/hook.js
//      <project>/.agent/plugins/lib/graphify/hook.js
//
// Candidates 1 and 2 are the plugin-local copies; candidates 3 and 4 are
// framework installations. All of them are resolved relative to THIS
// script, never relative to the process CWD, so a commit made from a
// subdirectory still finds the same implementation.
const candidates = [
  path.join(__dirname, "..", "lib", "graphify", "hook.js"),
  path.join(__dirname, "..", "..", "lib", "graphify", "hook.js"),
  path.join(__dirname, "..", "..", "..", "node_modules", "cortex-agent", "lib", "graphify", "hook.js"),
  path.join(__dirname, "..", "..", "..", "..", "lib", "graphify", "hook.js"),
  path.join(__dirname, "..", "..", "lib", "graphify", "hook.js"),
];

// Marker file recording that the post-commit hook could not find its
// shared implementation. It lives next to the plugin (not in the project
// source tree) and is dot-prefixed so the standard Cortex ignore rules
// keep it out of version control.
const UNWIRED_MARKER = path.join(__dirname, "..", ".hook-unwired.json");

/**
 * Record that the hook implementation could not be resolved. Best-effort:
 * a failure to write the marker must never block the commit either, so the
 * error is swallowed and the warning on stderr still fires.
 */
function writeUnwiredMarker(tried) {
  const payload = {
    schemaVersion: "1.0",
    recordedAt: new Date().toISOString(),
    kind: "hook_unwired",
    reason: "shared_implementation_not_found",
    triedCandidates: tried,
    remedy:
      "Run `cortex-agent update` in this project to reinstall the Graphify " +
      "plugin runtime, or reinstall cortex-agent so `lib/graphify/hook.js` is present.",
  };
  try {
    fs.writeFileSync(UNWIRED_MARKER, JSON.stringify(payload, null, 2) + "\n", "utf8");
  } catch (_) {
    // The marker is diagnostics, never a hard dependency.
  }
  console.warn(
    "[graphify] post-commit hook is NOT wired: the shared Graphify implementation " +
      "could not be resolved. The knowledge graph will not update on commit.\n" +
      "[graphify] tried: " + tried.join("\n[graphify]   ") + "\n" +
      "[graphify] remedy: " + payload.remedy,
  );
}

let hookLib = null;
const tried = [];
for (const candidate of candidates) {
  tried.push(candidate);
  try {
    hookLib = require(candidate);
    break;
  } catch (_) {
    // try next
  }
}

if (!hookLib) {
  // The implementation is missing. The hook is best-effort and must never
  // block the commit — but a silent no-op is indistinguishable from a
  // healthy hook, and the knowledge graph then stops updating with no
  // signal at all (issue #152). So we leave a durable diagnostic marker and
  // warn on stderr. `cortex-agent graphify doctor` reads this marker and
  // reports the hook as not wired.
  writeUnwiredMarker(tried);
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
    } else if (result.result === hookLib.HOOK_RESULT.DENSITY_REBUILD_STARTED) {
      const density = result.density || {};
      const ratio = typeof density.ratio === "number" ? density.ratio.toFixed(3) : "n/a";
      const threshold = typeof density.threshold === "number" ? density.threshold.toFixed(3) : "n/a";
      console.warn(
        `[graphify] edge density ${ratio} < baseline*${density.dropFactor || 0.85} (${threshold}); ` +
        `a full rebuild was started in the background`
      );
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
