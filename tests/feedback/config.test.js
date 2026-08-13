"use strict";

// ─── VC-007, VC-008 — Config precedence, merge semantics and safety ─────────

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BUILTIN_DEFAULTS,
  discoverConfig,
  applyCliOverrides,
  applyEnvOverrides,
  mergeLayer,
  assessUserConfigSafety,
  ConfigError,
  posixModeWiderThan0600,
} = require("../../lib/feedback/config");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-feedback-cfg-"));
}

test("VC-007 discoverConfig returns built-in defaults when no files exist", () => {
  const root = mkRoot();
  try {
    const r = discoverConfig({ root, env: {}, home: mkRoot() });
    assert.equal(r.config.enabled, false);
    assert.equal(r.config.nudge.enabled, false);
    assert.equal(r.config.adapters.cortex_diagnostic, false);
    assert.deepEqual(r.config.storage.max_event_bytes, 16384);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-007 unknown top-level keys are rejected", () => {
  assert.throws(() => mergeLayer(BUILTIN_DEFAULTS, { random_key: true }), /unknown top-level field/);
});

test("VC-007 unknown sub-keys are rejected", () => {
  assert.throws(
    () => mergeLayer(BUILTIN_DEFAULTS, { storage: { foo: 1 } }),
    /unknown sub-key "storage.foo"/,
  );
});

test("VC-007 arrays are replaced wholesale (not concatenated)", () => {
  const out = mergeLayer(BUILTIN_DEFAULTS, { redaction: { patterns: ["user-a", "user-b"] } });
  assert.deepEqual(out.redaction.patterns, ["user-a", "user-b"]);
  const merged = mergeLayer(out, { redaction: { patterns: ["only-this"] } });
  assert.deepEqual(merged.redaction.patterns, ["only-this"]);
});

test("VC-007 object values are deep-merged", () => {
  const out = mergeLayer(BUILTIN_DEFAULTS, { nudge: { since: "3d" } });
  assert.equal(out.nudge.since, "3d");
  assert.equal(out.nudge.enabled, false, "untouched fields keep their defaults");
  assert.equal(out.nudge.max_entries, 3);
});

test("VC-007 null values are rejected as configuration errors", () => {
  assert.throws(() => mergeLayer(BUILTIN_DEFAULTS, { enabled: null }), /is null/);
});

test("VC-007 env overrides layer applies scalar toggles", () => {
  const out = applyEnvOverrides(BUILTIN_DEFAULTS, {
    CORTEX_AGENT_FEEDBACK_ENABLED: "1",
    CORTEX_AGENT_FEEDBACK_NUDGE_ENABLED: "1",
    CORTEX_AGENT_FEEDBACK_ADAPTER_CORTEX_DIAGNOSTIC: "1",
  });
  assert.equal(out.enabled, true);
  assert.equal(out.nudge.enabled, true);
  assert.equal(out.adapters.cortex_diagnostic, true);
  assert.equal(out.adapters.evolution_observation, false, "untouched adapter stays off");
});

test("VC-007 CLI overrides win over env, project, user and defaults", () => {
  const layered = applyEnvOverrides(BUILTIN_DEFAULTS, { CORTEX_AGENT_FEEDBACK_ENABLED: "1" });
  const cli = applyCliOverrides(layered, { enabled: false });
  assert.equal(cli.enabled, false);
});

test("VC-007 discoverConfig composes all layers (user < project < env)", () => {
  const root = mkRoot();
  const home = mkRoot();
  try {
    const userPath = path.join(home, ".cortex-agent", "feedback.json");
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, JSON.stringify({ nudge: { since: "1d" } }), { mode: 0o600 });
    fs.chmodSync(userPath, 0o600);
    const projectPath = path.join(root, ".agent", "config", "feedback.json");
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, JSON.stringify({ enabled: true, adapters: { cortex_diagnostic: true } }), "utf8");
    const r = discoverConfig({ root, env: {}, home, userPathOverride: userPath });
    assert.equal(r.config.enabled, true, "project enabled=true wins");
    assert.equal(r.config.adapters.cortex_diagnostic, true, "project adapter wins");
    assert.equal(r.config.nudge.since, "1d", "user nudge.since wins");
    assert.equal(r.config.nudge.enabled, false, "untouched nudge.enabled stays off");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("VC-008 assessUserConfigSafety rejects symlinks at user path", () => {
  const root = mkRoot();
  try {
    const file = path.join(root, "feedback.json");
    fs.writeFileSync(file, JSON.stringify(BUILTIN_DEFAULTS), "utf8");
    const link = path.join(root, "feedback-link.json");
    try {
      fs.symlinkSync(file, link);
    } catch (_) {
      // Windows without symlink privilege: skip via t.skip.
      return;
    }
    const r = assessUserConfigSafety(link);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "symlink");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-008 assessUserConfigSafety treats POSIX file with mode 0o644 as unsafe (writes fail closed)", () => {
  if (process.platform === "win32") return;
  const root = mkRoot();
  try {
    const file = path.join(root, "feedback.json");
    fs.writeFileSync(file, JSON.stringify(BUILTIN_DEFAULTS), "utf8");
    fs.chmodSync(file, 0o644);
    const r = assessUserConfigSafety(file);
    assert.equal(r.ok, false);
    assert.match(r.reason, /permissions wider than 0600|chmod/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-008 POSIX 0600 is safe", () => {
  if (process.platform === "win32") return;
  const root = mkRoot();
  try {
    const file = path.join(root, "feedback.json");
    fs.writeFileSync(file, JSON.stringify(BUILTIN_DEFAULTS), "utf8");
    fs.chmodSync(file, 0o600);
    const r = assessUserConfigSafety(file);
    assert.equal(r.ok, true);
    assert.equal(posixModeWiderThan0600(fs.statSync(file)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-008 invalid JSON at user level surfaces a ConfigError", () => {
  const root = mkRoot();
  const home = mkRoot();
  try {
    const userPath = path.join(home, ".cortex-agent", "feedback.json");
    fs.mkdirSync(path.dirname(userPath), { recursive: true });
    fs.writeFileSync(userPath, "{not json", "utf8");
    fs.chmodSync(userPath, 0o600);
    assert.throws(() => discoverConfig({ root, env: {}, home, userPathOverride: userPath }), (err) => {
      return err instanceof ConfigError && err.code === "CONFIG_USER_INVALID";
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});