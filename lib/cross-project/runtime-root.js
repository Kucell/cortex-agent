"use strict";

// ─── Cross-Project Runtime-Root Initializer (T-RUNTIME-IGNORE-001) ──────────
//
// `.agent-runtime/` is the runtime data area used by Bridge, Coordination,
// Notification and other components. By project policy it must NEVER enter
// version control: the runtime root therefore owns a `.gitignore` whose
// payload is exactly
//
//     *
//     !.gitignore
//
// so every other file under it is ignored while the `.gitignore` itself
// remains tracked.
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

const RUNTIME_SEGMENT = ".agent-runtime";
const RUNTIME_GITIGNORE_BODY = "*\n!.gitignore\n";
const RUNTIME_GITIGNORE_MODE = 0o600;

function ensureRuntimeRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("ensureRuntimeRoot: root must be a non-empty string");
  }
  const runtimeRoot = path.join(path.resolve(root), RUNTIME_SEGMENT);
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
  RUNTIME_SEGMENT,
  RUNTIME_GITIGNORE_BODY,
  RUNTIME_GITIGNORE_MODE,
};