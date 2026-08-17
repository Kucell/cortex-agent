"use strict";

// ─── Adapter Framework Base (M-003 MS-001 / F-001) ──────────────────────────────
//
// Abstract base class for all cortex-agent external adapters. The 5-method
// contract is the ONLY surface every adapter must implement; concrete adapters
// (claude-code, codex, codey, pi, minimax — MS-002 / MS-003) inherit from
// BaseAdapter and override the 5 methods.
//
// Contract (per docs/architecture/adapter-authoring.md §2):
//
//   1. discover()                       — describe this adapter (type, version,
//                                          capabilities, schema). Read-only;
//                                          no side effects. Synchronous.
//   2. async health()                   — check if the underlying runtime is
//                                          available. Returns
//                                          { status, ready, latency_ms, error, details }.
//   3. async invoke(payload, options)   — execute a real dispatch. Writes
//                                          request → result/error → rollback
//                                          to .agent-runtime/dispatch/<runId>/.
//                                          Returns { runId, status, result, error, latency_ms }.
//   4. async cancel(runId, options?)    — stop a running dispatch. Returns
//                                          { runId, cancelled, error }.
//   5. async report(runId, options?)    — read the final result of a dispatch
//                                          from the journal. Returns the full
//                                          result/error/rollback record.
//
// Conventions:
//   - Adapters MUST be synchronous constructors (no async ctor).
//   - All async work happens in health() / invoke() / cancel() / report().
//   - Adapters SHOULD write journal artifacts via the helpers below so the
//     directory layout stays uniform across vendors.
//   - Adapters MUST NOT throw on cancellation; return a structured result.
//
// Hard constraints (per validation contract):
//   - Zero npm deps. node:fs / node:path / node:child_process / node:crypto only.
//   - Pure add. No file in lib/agents/ (M-002 5/5 ship) is modified.

const fs = require("node:fs");
const path = require("node:path");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths } = require("../../runtime-layout");

// ─── abstract enforcement ─────────────────────────────────────────────────────

function abstractMethod(name) {
  const err = new Error(
    `Adapter method "${name}" is abstract; subclass must override (see docs/architecture/adapter-authoring.md §2)`,
  );
  err.code = "ERR_ADAPTER_ABSTRACT";
  err.method = name;
  return err;
}

// ─── run journal helpers (shared by every adapter) ───────────────────────────

// The dispatch journal lives at <runtime>/dispatch/<run_id>/ — resolved via
// shared runtime-layout API. Distinct from M-002's .agent/runs/<run_id>/.
// Per D-002-3 the path boundary is strict:
// M-002 registry = .agent/agents/ + .agent/runs/ ; M-003 adapters =
// <runtime>/dispatch/ . Coordination runtime (M-008) writes
// <runtime>/coordination/ — also distinct.
//
// MS-003: Uses new-first/legacy-fallback per VC-012 compatibility window
function dispatchDir(projectRoot, runId) {
  if (!projectRoot) throw new Error("dispatchDir: projectRoot required");
  if (!runId) throw new Error("dispatchDir: runId required");
  const paths = resolveRuntimePaths(projectRoot);
  // During compat window: prefer legacy if exists, else new
  // After activation: always use new
  let dispatchPath;
  if (paths.legacyExists && !paths.activated) {
    dispatchPath = path.join(paths.dispatch.legacy, runId);
  } else {
    dispatchPath = path.join(paths.dispatch.new, runId);
  }
  return dispatchPath;
}

function ensureDispatchDir(projectRoot, runId) {
  const dir = dispatchDir(projectRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeDispatchArtifact(projectRoot, runId, name, payload) {
  const dir = ensureDispatchDir(projectRoot, runId);
  const file = path.join(dir, name);
  // Atomic write: .tmp → rename. Survives partial writes on crash.
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function readDispatchArtifact(projectRoot, runId, name) {
  const file = path.join(dispatchDir(projectRoot, runId), name);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const wrapped = new Error(
      `readDispatchArtifact: failed to parse ${file}: ${err.message}`,
    );
    wrapped.code = "ERR_DISPATCH_ARTIFACT_PARSE";
    wrapped.path = file;
    wrapped.cause = err;
    throw wrapped;
  }
}

function generateRunId(prefix = "R-adapter-invoke") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

// ─── abstract base class ──────────────────────────────────────────────────────

class BaseAdapter {
  constructor(options = {}) {
    // Prevent direct instantiation; subclasses MUST use super(options).
    if (new.target === BaseAdapter) {
      throw new Error(
        "BaseAdapter is abstract; instantiate a subclass (e.g. ClaudeCodeAdapter)",
      );
    }
    // Subclass-provided options (binary path, config refs, env vars, etc.).
    // Subclass constructors should validate and forward only the keys they
    // understand; everything else is ignored.
    this.options = options || {};
  }

  // 1. discover — describe the adapter. Pure metadata; never touches the
  //    external runtime. Synchronous (callers expect this to be cheap).
  discover() {
    throw abstractMethod("discover");
  }

  // 2. health — check whether the underlying CLI / service is reachable.
  //    Default behavior: return "unknown" so subclasses that don't implement
  //    health can still be loaded (with degraded observability). The claude-
  //    code adapter (F-002) overrides this with a `which` check.
  async health() {
    return {
      status: "unknown",
      ready: false,
      latency_ms: 0,
      error: "health() not implemented by this adapter",
      details: {},
    };
  }

  // 3. invoke — execute a real dispatch. Writes request.json → (result.json |
  //    error.json) → rollback.json (or rollback-failed.json) to the journal.
  //    Default behavior: reject. Subclasses override to actually dispatch.
  async invoke(payload, options = {}) {
    throw abstractMethod("invoke");
  }

  // 4. cancel — stop a running dispatch. Default behavior: no-op with a
  //    structured "not_supported" return so the CLI surface still works.
  async cancel(runId, options = {}) {
    return {
      runId,
      cancelled: false,
      error: {
        code: "ERR_CANCEL_NOT_SUPPORTED",
        message: "cancel() not implemented by this adapter",
      },
    };
  }

  // 5. report — read the journal for a finished (or in-flight) dispatch.
  //    Default behavior: read whatever artifacts exist. Subclasses may
  //    override to add vendor-specific telemetry.
  async report(runId, options = {}) {
    const projectRoot = options.projectRoot || process.cwd();
    if (!runId) {
      const err = new Error("report: runId required");
      err.code = "ERR_RUN_ID_REQUIRED";
      throw err;
    }
    const result = readDispatchArtifact(projectRoot, runId, "result.json");
    const error = readDispatchArtifact(projectRoot, runId, "error.json");
    const rollback = readDispatchArtifact(projectRoot, runId, "rollback.json");
    const rollbackFailed = readDispatchArtifact(
      projectRoot,
      runId,
      "rollback-failed.json",
    );
    const request = readDispatchArtifact(projectRoot, runId, "request.json");
    if (!result && !error) {
      return {
        runId,
        status: "not_found",
        result: null,
        error: null,
        rollback: null,
        rollback_failed: null,
        request: null,
        written_at: null,
      };
    }
    const winner = result || error;
    return {
      runId,
      status: result ? "ok" : winner.status || "unknown",
      result,
      error,
      rollback,
      rollback_failed: rollbackFailed,
      request,
      written_at: winner.written_at || null,
    };
  }
}

module.exports = {
  BaseAdapter,
  abstractMethod,
  dispatchDir,
  ensureDispatchDir,
  writeDispatchArtifact,
  readDispatchArtifact,
  generateRunId,
};
