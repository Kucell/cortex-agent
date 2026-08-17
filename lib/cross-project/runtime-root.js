"use strict";

// ─── Cross-Project Runtime-Root Initializer (T-RUNTIME-IGNORE-001) ──────────
//
// `.agent-runtime/` is the runtime data area used by Bridge, Coordination,
// Notification and other components. By default it stays OUT of version
// control (same lifecycle as `.agent`: init/upgrade write it to
// .git/info/exclude, `cortex-agent track` opts in), so the runtime root
// additionally owns a `.gitignore` whose payload is exactly
//
//     *
//     !.gitignore
//
// so every other file under it is ignored while the `.gitignore` itself
// remains addable. This is a cold-start safety net only: `cortex-agent
// track` replaces the payload with RUNTIME_TRACKED_GITIGNORE_BODY (the file
// keeps existing so writers below never reseed the hard-ignore) and
// `cortex-agent untrack` restores it.
//
// Cross-Project Bridge writers (subscriptions / inbox / outbox / cursors)
// all touch `.agent-runtime/cross-project/…` on the cold-start path. Before
// this helper existed each writer only `mkdirSync`-ed its own subdir and
// never seeded the runtime-root `.gitignore`, so Bridge data could leak
// into a fresh repo via `git add .`.
//
// Contract (verified by tests/cross-project/runtime-root.test.js):
//   • ensureRuntimeRoot(root)        → returns the absolute runtime-root
//                                       path, creating the directory and the
//                                       `.gitignore` if either is missing.
//   • The `.gitignore` is created with mode 0o600.
//   • A pre-existing `.gitignore` is NEVER overwritten — coordination and
//     other components (notification-host, commands/management/coordination,
//     commands/surface/{hook,agent}) already seed it on their own codepaths;
//     this helper just guarantees the cold-start case.
//
// Source: T-RUNTIME-IGNORE-001 / P-003 §3.1 桥接存储 / P-006 §3.1 Capability A.

const fs = require("node:fs");
const path = require("node:path");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths, isNewLayoutActivated } = require("../runtime-layout");

// MS-003: RUNTIME_SEGMENT is the legacy segment; new layout uses AGENT_DIR_SEGMENT + RUNTIME_DIR
const RUNTIME_GITIGNORE_BODY = "*\n!.gitignore\n";
const RUNTIME_GITIGNORE_MODE = 0o600;
// Written by `cortex-agent track` in place of the hard-ignore payload so
// that `git add .agent-runtime` works. Pure comment body: ignores nothing,
// and its mere presence stops the cold-start seeders from re-ignoring.
const RUNTIME_TRACKED_GITIGNORE_BODY =
  "# cortex-agent track: .agent-runtime is tracked by Git.\n" +
  "# Run `cortex-agent untrack` to restore the local-only hard-ignore.\n";

// MS-003: Get the runtime root using shared runtime-layout API (VC-011)
// Uses new-first/legacy-fallback per VC-012 compatibility window
// The returned runtime root is where portable namespaces live
function ensureRuntimeRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("ensureRuntimeRoot: root must be a non-empty string");
  }
  const resolvedRoot = path.resolve(root);
  const paths = resolveRuntimePaths(resolvedRoot);

  // During compat window: prefer legacy if exists, else new
  // After activation: always use new
  let runtimeRoot;
  if (paths.legacyExists && !paths.activated) {
    runtimeRoot = paths.legacyRuntimeDir;
  } else {
    runtimeRoot = paths.newRuntimeDir;
  }

  fs.mkdirSync(runtimeRoot, { recursive: true });
  const ignorePath = path.join(runtimeRoot, ".gitignore");
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, RUNTIME_GITIGNORE_BODY, {
      encoding: "utf8",
      mode: RUNTIME_GITIGNORE_MODE,
    });
  }
  return runtimeRoot;
}

module.exports = {
  ensureRuntimeRoot,
  RUNTIME_GITIGNORE_BODY,
  RUNTIME_GITIGNORE_MODE,
  RUNTIME_TRACKED_GITIGNORE_BODY,
  // MS-003: re-export layout helpers for consumers
  isNewLayoutActivated,
  resolveRuntimePaths,
};