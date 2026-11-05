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

// The framework runtime is installed beside this wrapper. Do not silently
// fall back to another package copy when the local runtime exists but is
// incomplete: that can combine different marker and density protocols.
const hookPath = path.join(__dirname, "..", "lib", "graphify", "hook.js");

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
function writeUnwiredMarker(tried, detail = null) {
  const payload = {
    schemaVersion: "1.0",
    recordedAt: new Date().toISOString(),
    kind: "hook_unwired",
    reason: "shared_implementation_not_found",
    triedCandidates: tried,
    remedy:
      "Run `cortex-agent update` in this project to reinstall the Graphify " +
      "plugin runtime, or reinstall cortex-agent so `lib/graphify/hook.js` is present.",
    ...(detail ? { detail: String(detail) } : {}),
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
const tried = [hookPath];
try {
  hookLib = require(hookPath);
} catch (err) {
  writeUnwiredMarker(tried, err && err.message ? err.message : String(err));
}

if (!hookLib) {
  // The implementation is missing. The hook is best-effort and must never
  // block the commit — but a silent no-op is indistinguishable from a
  // healthy hook, and the knowledge graph then stops updating with no
  // signal at all (issue #152). So we leave a durable diagnostic marker and
  // warn on stderr. `cortex-agent graphify doctor` reads this marker and
  // reports the hook as not wired.
  process.exit(0);
}

// Collect the just-finished commit's diff so we can classify code vs
// semantic. We rely on `git show --name-only --pretty=format:` HEAD.
let changedPaths = [];
const projectRoot = process.env.CORTEX_GRAPHIFY_PROJECT_ROOT || process.cwd();
const requestedHead = process.env.CORTEX_GRAPHIFY_SOURCE_HEAD || "";
let sourceHead = /^[0-9a-f]{7,64}$/i.test(requestedHead) ? requestedHead : null;
let branch = null;
try {
  const { execFileSync } = require("child_process");
  const git = (args) => execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const head = sourceHead || git(["rev-parse", "HEAD"]);
  sourceHead = head;
  const branchOut = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  branch = branchOut && branchOut !== "HEAD" ? branchOut : null;
  const nameOnly = git(["show", "--name-only", "--pretty=format:", head]);
  changedPaths = nameOnly.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
} catch (_) {
  // Could not enumerate commit; run the hook in degraded mode (no diff).
}

try {
  const result = hookLib.runPostCommit({
    cwd: projectRoot,
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
