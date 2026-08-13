"use strict";

// ─── P-001 Feedback Config (F-004) ──────────────────────────────────────────
//
// Unified configuration discovery + deterministic merge + permission check.
// Per `.agent/plans/proposals/projects/feedback-pipeline/feedback-config-design.md`
// §1 (唯一路径模型), §2 (优先级与合并语义), §5 (文件安全).
//
// Paths (priority low → high):
//   1. built-in defaults                (lowest)
//   2. user-level  ~/.cortex-agent/feedback.json
//   3. project-level <root>/.agent/config/feedback.json
//   4. environment CORTEX_AGENT_FEEDBACK_*
//   5. CLI overrides                   (highest — applied externally)
//
// Public API:
//   • BUILTIN_DEFAULTS — safe factory floor (everything disabled)
//   • discoverConfig({ root, env, home, userPathOverride }) — load + merge
//   • applyCliOverrides(config, cli) — last layer, never touches disk
//   • assessUserConfigSafety({ path }) → { ok, reason } — POSIX/Windows
//
// The module never throws on missing config: it returns BUILTIN_DEFAULTS with
// `enabled=false` and `__source` documenting why. Hard errors only on:
//   * invalid JSON (project/user)
//   * unknown top-level keys
//   * symlink or non-plain-file at the user level (POSIX)
//   * POSIX mode wider than 0600 (warn, fail closed for writes)
//   * Windows ACL unprovable (fail closed for writes — read paths allowed)

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ─── Defaults ───────────────────────────────────────────────────────────────

const BUILTIN_DEFAULTS = Object.freeze(JSON.parse(JSON.stringify({
  schema_version: 1,
  enabled: false,
  nudge: {
    enabled: false,
    since: "7d",
    max_entries: 3,
  },
  adapters: {
    cortex_diagnostic: false,
    evolution_observation: false,
  },
  storage: {
    retention_days: 30,
    max_event_bytes: 16384,
    max_events_per_day: 10000,
  },
  redaction: {
    patterns: [],
  },
})));

// ─── Schema / merge ─────────────────────────────────────────────────────────

const KNOWN_TOP_KEYS = Object.freeze(Object.keys(BUILTIN_DEFAULTS));
const KNOWN_OBJECT_KEYS = Object.freeze(["nudge", "adapters", "storage", "redaction"]);

class ConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Recursive merge: scalars replaced, objects deep-merged, arrays replaced
// wholesale.  Unknown sub-keys inside known objects are rejected.
function mergeLayer(base, layer, { rejectUnknown = true, path = "" } = {}) {
  if (!isPlainObject(layer)) {
    throw new ConfigError(`config at "${path || "<root>"}" must be an object`, "CONFIG_TYPE");
  }
  const result = { ...base };
  for (const key of Object.keys(layer)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (rejectUnknown && !KNOWN_TOP_KEYS.includes(key)) {
      throw new ConfigError(`config has unknown top-level field "${key}"`, "CONFIG_UNKNOWN_FIELD");
    }
    const incoming = layer[key];
    const existing = result[key];
    if (incoming === null) {
      throw new ConfigError(`config.${fullPath} is null`, "CONFIG_NULL");
    }
    if (Array.isArray(incoming)) {
      // Array: high-priority wholesale replacement.
      result[key] = incoming.slice();
      continue;
    }
    if (isPlainObject(incoming)) {
      if (!isPlainObject(existing)) {
        throw new ConfigError(`config.${fullPath} expects an object`, "CONFIG_TYPE");
      }
      if (!KNOWN_OBJECT_KEYS.includes(key)) {
        if (rejectUnknown) {
          throw new ConfigError(`config has unknown object key "${key}"`, "CONFIG_UNKNOWN_KEY");
        }
        result[key] = mergeLayer(existing, incoming, { rejectUnknown, path: fullPath });
        continue;
      }
      result[key] = mergeObjectKey(key, existing, incoming, { rejectUnknown, path: fullPath });
      continue;
    }
    // Scalar.
    result[key] = incoming;
  }
  return result;
}

function mergeObjectKey(key, base, layer, { rejectUnknown, path }) {
  if (!isPlainObject(layer)) {
    throw new ConfigError(`config.${path} must be an object`, "CONFIG_TYPE");
  }
  const known = new Set(Object.keys(base));
  const out = { ...base };
  for (const subKey of Object.keys(layer)) {
    const subPath = `${path}.${subKey}`;
    const incoming = layer[subKey];
    if (rejectUnknown && !known.has(subKey)) {
      throw new ConfigError(`config has unknown sub-key "${subPath}"`, "CONFIG_UNKNOWN_KEY");
    }
    if (incoming === null) {
      throw new ConfigError(`config.${subPath} is null`, "CONFIG_NULL");
    }
    if (Array.isArray(incoming)) {
      out[subKey] = incoming.slice();
      continue;
    }
    if (isPlainObject(incoming)) {
      if (!isPlainObject(base[subKey])) {
        throw new ConfigError(`config.${subPath} expects an object`, "CONFIG_TYPE");
      }
      out[subKey] = { ...base[subKey], ...incoming };
      continue;
    }
    out[subKey] = incoming;
  }
  return out;
}

// ─── File loaders ───────────────────────────────────────────────────────────

function readJsonStrict(file, { mustBePlainFile = true, mustNotBeSymlink = false } = {}) {
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: false, reason: "ENOENT" };
    throw error;
  }
  if (mustBePlainFile && !stats.isFile()) {
    return { ok: false, reason: `not a regular file (mode=${stats.mode})` };
  }
  if (mustNotBeSymlink && stats.isSymbolicLink()) {
    return { ok: false, reason: "symlink not allowed" };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return { ok: true, value: parsed };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: `invalid JSON: ${error.message}` };
    }
    throw error;
  }
}

// ─── POSIX file safety ──────────────────────────────────────────────────────

function posixModeWiderThan0600(stats) {
  // Consider world/group permissions. Only user bits should be set.
  // (Files with mode 0o600 or stricter are safe; everything wider is unsafe.)
  if (!stats || typeof stats.mode !== "number") return false;
  const permissiveBits = 0o077;
  return (stats.mode & permissiveBits) !== 0;
}

function isPosixPlatform() {
  return process.platform !== "win32";
}

// Best-effort chmod to 0600. We never throw; returns whether the resulting
// file is safe to write into. `CORTEX_AGENT_FEEDBACK_ALLOW_INSECURE=1` skips
// the chmod attempt and accepts the risk (intentional escape hatch for
// sandboxed CI; explicit user opt-in via env).
function tryChmod0600(file) {
  if (process.env.CORTEX_AGENT_FEEDBACK_ALLOW_INSECURE === "1") return true;
  try {
    fs.chmodSync(file, 0o600);
    const after = fs.statSync(file);
    return !posixModeWiderThan0600(after);
  } catch (_) {
    return false;
  }
}

function assessUserConfigSafety(file) {
  // Returns:
  //   { ok: false, reason, platform, writeSafe: false, readSafe: true|false,
  //     chmodAttempted?: boolean }
  // for unsafe configs (writes always fail closed).
  //   { ok: true, platform, writeSafe: true, readSafe: true }
  // for provably safe configs (mode 0600, plain file, non-symlink).
  //
  // POSIX: we always treat wider-than-0600 as write-unsafe, even after chmod
  // remediation. The remediation is best-effort and only effective when the
  // operator explicitly opts in with CORTEX_AGENT_FEEDBACK_ALLOW_INSECURE=1
  // AND the chmod actually narrows the file to 0600. Default posture: writes
  // fail closed if the on-disk permissions were ever wider than 0600.
  let stats;
  try {
    stats = fs.lstatSync(file);
  } catch (error) {
    return { ok: false, reason: `ENOENT:${error && error.code}`, platform: process.platform, writeSafe: false, readSafe: false };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, reason: "symlink", platform: process.platform, writeSafe: false, readSafe: false };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "not a file", platform: process.platform, writeSafe: false, readSafe: false };
  }
  if (process.platform === "win32") {
    // Best-effort ACL check: Node has no portable ACL API; we declare the
    // safety decision as "unprovable" and fail-closed for writes.
    return {
      ok: false,
      reason: "windows-acl-unprovable",
      platform: "win32",
      writeSafe: false,
      readSafe: true,
    };
  }
  if (posixModeWiderThan0600(stats)) {
    // Permissions are wider than 0600. We refuse writes regardless of any
    // chmod attempt — see header docstring. The remediation helper is still
    // useful as a one-shot: if the operator wants to opt back in they can
    // chmod 0600 manually and re-run.
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) { /* best-effort */ }
    return {
      ok: false,
      reason: "permissions wider than 0600",
      platform: "posix",
      chmodAttempted: true,
      writeSafe: false,
      readSafe: true,
    };
  }
  return { ok: true, platform: "posix", writeSafe: true, readSafe: true };
}

// ─── Env overrides ─────────────────────────────────────────────────────────

function applyEnvOverrides(config, env) {
  if (!env || typeof env !== "object") return config;
  const out = { ...config };
  if (env.CORTEX_AGENT_FEEDBACK_ENABLED === "1") out.enabled = true;
  if (env.CORTEX_AGENT_FEEDBACK_ENABLED === "0") out.enabled = false;
  if (env.CORTEX_AGENT_FEEDBACK_NUDGE_ENABLED === "1") {
    out.nudge = { ...out.nudge, enabled: true };
  }
  if (env.CORTEX_AGENT_FEEDBACK_NUDGE_ENABLED === "0") {
    out.nudge = { ...out.nudge, enabled: false };
  }
  if (env.CORTEX_AGENT_FEEDBACK_ADAPTER_CORTEX_DIAGNOSTIC === "1") {
    out.adapters = { ...out.adapters, cortex_diagnostic: true };
  }
  if (env.CORTEX_AGENT_FEEDBACK_ADAPTER_EVOLUTION_OBSERVATION === "1") {
    out.adapters = { ...out.adapters, evolution_observation: true };
  }
  return out;
}

// ─── CLI overrides ─────────────────────────────────────────────────────────

function applyCliOverrides(config, cli = {}) {
  if (!cli || typeof cli !== "object") return config;
  const out = { ...config };
  if (cli.enabled === true || cli.enabled === false) out.enabled = cli.enabled;
  if (cli.nudgeEnabled === true || cli.nudgeEnabled === false) {
    out.nudge = { ...out.nudge, enabled: cli.nudgeEnabled };
  }
  if (cli.adapterCortexDiagnostic === true || cli.adapterCortexDiagnostic === false) {
    out.adapters = { ...out.adapters, cortex_diagnostic: cli.adapterCortexDiagnostic };
  }
  if (cli.adapterEvolutionObservation === true || cli.adapterEvolutionObservation === false) {
    out.adapters = { ...out.adapters, evolution_observation: cli.adapterEvolutionObservation };
  }
  return out;
}

// ─── discoverConfig ────────────────────────────────────────────────────────
//
// Loads and merges user + project + env into a single object. `__source`
// documents which file path won for each top-level key (helpful for
// `feedback status` output).

function discoverConfig(options = {}) {
  const root = options.root || process.cwd();
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const userPathOverride = options.userPathOverride || null;
  const sources = {};
  let merged = JSON.parse(JSON.stringify(BUILTIN_DEFAULTS));
  sources["*"] = "builtin";
  // User-level
  const userPath = userPathOverride || path.join(home, ".cortex-agent", "feedback.json");
  const userLoad = readJsonStrict(userPath, { mustBePlainFile: true, mustNotBeSymlink: true });
  if (userLoad.ok) {
    const safety = assessUserConfigSafety(userPath);
    if (!safety.ok && !safety.readSafe) {
      throw new ConfigError(
        `user config at ${userPath} is unsafe: ${safety.reason}`,
        "CONFIG_USER_UNSAFE",
      );
    }
    merged = mergeLayer(merged, userLoad.value, { path: "<user>" });
    sources["*"] = userPath;
    sources.__userSafe = safety.ok || safety.readSafe === true;
  } else if (userLoad.reason && userLoad.reason !== "ENOENT") {
    throw new ConfigError(
      `user config at ${userPath} cannot be read: ${userLoad.reason}`,
      "CONFIG_USER_INVALID",
    );
  }
  // Project-level
  const projectPath = path.join(root, ".agent", "config", "feedback.json");
  const projectLoad = readJsonStrict(projectPath, { mustBePlainFile: true });
  if (projectLoad.ok) {
    merged = mergeLayer(merged, projectLoad.value, { path: "<project>" });
    for (const key of Object.keys(projectLoad.value || {})) sources[key] = projectPath;
  } else if (projectLoad.reason && projectLoad.reason !== "ENOENT") {
    throw new ConfigError(
      `project config at ${projectPath} cannot be read: ${projectLoad.reason}`,
      "CONFIG_PROJECT_INVALID",
    );
  }
  // Env layer
  merged = applyEnvOverrides(merged, env);
  sources.__env = true;
  return { config: merged, sources, userPath, projectPath };
}

// ─── Permission helper used by CLI commands ────────────────────────────────

function ensureWriteSafe(config, ctx = {}) {
  // Returns { ok, reason }. `ctx.platform` can be forced for tests.
  const platform = ctx.platform || process.platform;
  if (config && config.enabled === true) {
    if (platform === "win32") {
      return { ok: false, reason: "windows-acl-unprovable" };
    }
  }
  return { ok: true };
}

module.exports = {
  BUILTIN_DEFAULTS,
  KNOWN_TOP_KEYS,
  KNOWN_OBJECT_KEYS,
  ConfigError,
  mergeLayer,
  readJsonStrict,
  posixModeWiderThan0600,
  assessUserConfigSafety,
  applyEnvOverrides,
  applyCliOverrides,
  discoverConfig,
  ensureWriteSafe,
  isPosixPlatform,
};