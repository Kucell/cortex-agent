"use strict";

// ─── MiniMax CLI Safe Probe (M-011 / ARI P-005) ────────────────────────────
// Zero external dependencies — Node.js built-ins only.
// Node compatibility: >=14.
//
// ARI P-005 frozen proposal:
//   .agent/plans/proposals/projects/agent-runtime-interoperability/proposals/P-005-minimax-cli-governed-tool-adapter-proposal.md
// Frozen SHA-256:
//   f377943b6eb73d44308a86d965229730ba2552613ae611e3e511457c13f4587d
//
// Public API:
//   - probe(root, options)                       -> MiniMaxCliCapabilitySnapshot
//   - runSafeProbe(options)                      -> same, default binary resolver
//   - buildArgs(family, resource)                -> string[] (allow-list enforced)
//   - allowProbeFamily(family)                   -> boolean
//   - summarizeBinaryAvailability(snapshot)      -> "available"|"missing"|"unknown"
//
// Allow-listed mmx command families (VC-011-01-04, ARI P-005 §7 Phase 0):
//   1. "version"       -> mmx --version
//   2. "help"          -> mmx --help
//   3. "resource_help" -> mmx <resource> --help
//
// Everything else is rejected with MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED")
// *before* exec. In particular, `mmx auth status`, `mmx config export-schema`,
// `mmx quota`, `mmx update`, `mmx install`, and any `mmx <resource>` paid /
// network / generation subcommand are explicitly OUT of scope for this Mission.
//
// `auth_state` is forced to "unknown" by `buildSnapshot()` via the contract
// validator; `redactAuthStatus` / `classifyAuthState` are not invoked here.

const childProcess = require("node:child_process");
const path = require("node:path");

const capabilityContract = require("./minimax-cli-capability-contract");

const {
  MINIMAX_RESOURCES,
  MINIMAX_PROBE_FAMILIES,
  AUTH_READINESS_DISABLED_REASON,
  CapabilitySnapshotContractError,
} = capabilityContract;

const PROBE_TIMEOUT_MS = 5_000;
const MAX_VERSION_LINE_LENGTH = 256;

class MiniMaxCliProbeError extends Error {
  constructor(code, details) {
    super(`[minimax-cli-probe:${code}] ${JSON.stringify(details || {})}`);
    this.name = "MiniMaxCliProbeError";
    this.code = code;
    this.details = details || {};
  }
}

function defaultBinaryResolver() {
  return process.env.MINIMAX_CLI_BIN || "mmx";
}

function defaultExec(binary, args, opts) {
  return childProcess.spawnSync(binary, args, Object.assign({
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      // Belt-and-suspenders: scrub any pre-existing API key env vars before exec.
      // This is defensive; the probe never reads these values, but env scrubbing
      // guarantees no accidental propagation.
      MINIMAX_API_KEY: "",
      MINIMAX_TOKEN: "",
    }),
  }, opts || {}));
}

// Allow-list predicate. Probe must call this before invoking buildArgs.
function allowProbeFamily(family) {
  return typeof family === "string" && MINIMAX_PROBE_FAMILIES.indexOf(family) >= 0;
}

// Build args for an allow-listed family. Any non-allow-listed family raises
// ERR_PROBE_FAMILY_NOT_ALLOWED before exec, so buildArgs is fail-closed by
// construction.
function buildArgs(family, resource) {
  if (!allowProbeFamily(family)) {
    throw new MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED", {
      family,
      allowed: MINIMAX_PROBE_FAMILIES.slice(),
    });
  }
  switch (family) {
    case "version":
      return ["--version"];
    case "help":
      return ["--help"];
    case "resource_help":
      if (!resource) {
        throw new MiniMaxCliProbeError("ERR_RESOURCE_REQUIRED", { family });
      }
      if (capabilityContract.MINIMAX_RESOURCE_SET
        ? !capabilityContract.MINIMAX_RESOURCE_SET.has(resource)
        : MINIMAX_RESOURCES.indexOf(resource) < 0) {
        throw new MiniMaxCliProbeError("ERR_RESOURCE_UNKNOWN", {
          family,
          resource,
          allowed: MINIMAX_RESOURCES.slice(),
        });
      }
      return [resource, "--help"];
    default:
      // unreachable due to allow-list check above
      throw new MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED", {
        family,
        allowed: MINIMAX_PROBE_FAMILIES.slice(),
      });
  }
}

// Run one allow-listed probe call.  We deliberately throw away stdout for
// non-version families so no help text ever reaches the evidence layer.
function safeExec(exec, binary, family, resource, now) {
  const args = buildArgs(family, resource);
  const child = exec(binary, args, {});
  if (child.error && child.error.code === "ENOENT") {
    return {
      family,
      args,
      status: "binary_missing",
      exit_status: null,
      signal: null,
      stdout_chars: 0,
      stderr_chars: child.stderr ? String(child.stderr).length : 0,
      started_at: now,
    };
  }
  if (child.error && child.error.code === "ETIMEDOUT") {
    return {
      family,
      args,
      status: "timeout",
      exit_status: null,
      signal: child.signal || null,
      stdout_chars: 0,
      stderr_chars: child.stderr ? String(child.stderr).length : 0,
      started_at: now,
    };
  }
  return {
    family,
    args,
    status: child.status === 0 ? "ok" : "non_zero_exit",
    exit_status: child.status,
    signal: child.signal || null,
    // For non-version families we DO NOT keep stdout; help text must never
    // reach evidence. For version, we record char count for visibility and
    // capture the line separately in `runSafeProbe`.
    stdout_chars: family === "version" ? (child.stdout ? String(child.stdout).length : 0) : 0,
    stderr_chars: child.stderr ? String(child.stderr).length : 0,
    started_at: now,
  };
}

// Probe orchestration. Runs each allow-listed family, builds the snapshot,
// and forces auth_state to "unknown" via the contract validator.
function runSafeProbe(options) {
  const opts = options || {};
  const exec = typeof opts.exec === "function" ? opts.exec : defaultExec;
  const binary = typeof opts.binary === "string" && opts.binary.length > 0
    ? opts.binary
    : defaultBinaryResolver();
  const now = opts.now || new Date().toISOString();

  const probeCommandLog = [];
  let versionLine = null;
  let binaryAvailable = false;
  let binarySource = "unknown";
  const resourceCapabilities = {};

  // Family 1: version (we DO want the version string).
  const versionResult = safeExec(exec, binary, "version", null, now);
  probeCommandLog.push(`${binary} ${versionResult.args.join(" ")}`);
  if (versionResult.status === "ok") {
    binaryAvailable = true;
    binarySource = "probe";
    // Re-run to grab stdout ONLY for the version line; still allow-list enforced.
    const rawVersion = exec(binary, buildArgs("version", null), {}).stdout || "";
    versionLine = rawVersion.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)[0] || null;
    if (versionLine && versionLine.length > MAX_VERSION_LINE_LENGTH) {
      versionLine = versionLine.slice(0, MAX_VERSION_LINE_LENGTH);
    }
  }

  // Family 2: help. Help text is NEVER persisted; we only use exit status to
  // confirm the binary is functional when version was missing.
  const helpResult = safeExec(exec, binary, "help", null, now);
  probeCommandLog.push(`${binary} ${helpResult.args.join(" ")}`);
  if (!binaryAvailable && helpResult.status === "ok") {
    binaryAvailable = true;
    binarySource = "probe";
  }

  // Family 3: per-resource --help. Help text is NEVER persisted; we only use
  // exit status to derive capability presence for each resource.
  if (binaryAvailable && binarySource === "probe") {
    for (const resource of MINIMAX_RESOURCES) {
      const result = safeExec(exec, binary, "resource_help", resource, now);
      probeCommandLog.push(`${binary} ${result.args.join(" ")}`);
      if (result.status === "ok") {
        resourceCapabilities[resource] = {
          level: "explicit",
          source: "manifest-claim",
          reason: `${resource}_--help_exit_0`,
        };
      } else {
        resourceCapabilities[resource] = {
          level: "unsupported",
          source: "not-implemented",
          reason: `${resource}_--help_non_zero_exit`,
        };
      }
    }
  } else {
    for (const resource of MINIMAX_RESOURCES) {
      resourceCapabilities[resource] = {
        level: "unsupported",
        source: "not-implemented",
        reason: "binary_missing",
      };
    }
  }

  return buildSnapshot({
    now,
    binaryAvailable,
    binaryVersion: versionLine,
    binarySource,
    resourceCapabilities,
    probeCommandLog,
  });
}

function buildSnapshot(input) {
  const {
    now,
    binaryAvailable,
    binaryVersion,
    binarySource,
    resourceCapabilities,
    probeCommandLog,
  } = input;

  const snapshotCandidate = {
    schema_version: capabilityContract.MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    snapshot_id: "MCAP-" + require("node:crypto").randomBytes(6).toString("hex"),
    probe_at: now,
    binary: {
      available: Boolean(binaryAvailable),
      version: binaryVersion || null,
      source: binarySource || "unknown",
    },
    // Forced by ARI P-005 §2 / VC-011-02-01: only "unknown" is accepted.
    auth_state: "unknown",
    auth_state_reason: AUTH_READINESS_DISABLED_REASON,
    probe_families: capabilityContract.MINIMAX_PROBE_FAMILIES.slice(),
    capabilities: resourceCapabilities,
    no_credential: true,
    probe_command_log: probeCommandLog,
  };

  // Validator rejects any auth_state !== "unknown" via ERR_AUTH_STATE_DISABLED.
  return capabilityContract.validateCapabilitySnapshot(snapshotCandidate);
}

function probe(_root, options) {
  return runSafeProbe(options || {});
}

function summarizeBinaryAvailability(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.binary) return "unknown";
  if (snapshot.binary.available === true) return "available";
  if (snapshot.binary.available === false) return "missing";
  return "unknown";
}

// Guard: any attempt to invoke a forbidden family outside this module must throw.
function assertNoForbiddenFamilies(families) {
  if (!Array.isArray(families)) return;
  for (const f of families) {
    if (!allowProbeFamily(f)) {
      throw new MiniMaxCliProbeError("ERR_PROBE_FAMILY_NOT_ALLOWED", {
        family: f,
        allowed: MINIMAX_PROBE_FAMILIES.slice(),
      });
    }
  }
}

module.exports = {
  PROBE_TIMEOUT_MS,
  MINIMAX_PROBE_FAMILIES: MINIMAX_PROBE_FAMILIES.slice(),
  AUTH_READINESS_DISABLED_REASON,
  MiniMaxCliProbeError,
  CapabilitySnapshotContractError,
  allowProbeFamily,
  assertNoForbiddenFamilies,
  buildArgs,
  probe,
  runSafeProbe,
  safeExec,
  buildSnapshot,
  summarizeBinaryAvailability,
};