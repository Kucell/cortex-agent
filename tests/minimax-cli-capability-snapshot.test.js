"use strict";

// ─── M-011 / ARI P-005 — capability-snapshot contract tests ───────────────
// Zero external dependencies.

const test = require("node:test");
const assert = require("node:assert/strict");

const cc = require("../lib/runtime-adapters/minimax-cli-capability-contract");

const ALLOWED_FAMILIES = ["version", "help", "resource_help"];
const ALLOWED_RESOURCES = ["text", "image", "video", "speech", "music", "vision", "search"];
const ALLOWED_LEVELS = ["native", "adapter", "explicit", "unobservable", "unsupported"];
const ALLOWED_SOURCES = [
  "extension-api",
  "runtime-trace",
  "static-analysis",
  "manifest-claim",
  "self-reported",
  "not-exposed",
  "not-implemented",
];

function makeCapabilityEntry(level, source, reason) {
  return { level, source, reason };
}

function buildSnapshot(overrides) {
  const now = "2026-07-29T03:00:00.000Z";
  const capabilities = {};
  for (const r of ALLOWED_RESOURCES) {
    capabilities[r] = makeCapabilityEntry("explicit", "manifest-claim", `${r}_--help_exit_0`);
  }
  return Object.assign(
    {
      schema_version: cc.MINIMAX_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
      snapshot_id: "MCAP-deadbeef1234",
      probe_at: now,
      binary: { available: true, version: "mmx 1.0.18", source: "probe" },
      auth_state: "unknown",
      auth_state_reason: "auth_probing_disabled",
      probe_families: ALLOWED_FAMILIES.slice(),
      capabilities,
      no_credential: true,
      probe_command_log: ["mmx --version", "mmx --help"],
    },
    overrides || {}
  );
}

test("MINIMAX_PROBE_FAMILIES is exactly three (ARI P-005 VC-011-01-04)", () => {
  assert.deepEqual(cc.MINIMAX_PROBE_FAMILIES, ALLOWED_FAMILIES);
  assert.equal(cc.MINIMAX_PROBE_FAMILIES.length, 3);
});

test("MINIMAX_AUTH_STATES is forced to ['unknown'] in this Mission", () => {
  assert.deepEqual(cc.MINIMAX_AUTH_STATES, ["unknown"]);
});

test("MINIMAX_AUTH_STATES_FULL is the full vocabulary for future authorization", () => {
  assert.deepEqual(cc.MINIMAX_AUTH_STATES_FULL, ["ready", "blocked", "unknown"]);
});

test("isAuthReadinessEnabled returns false in this Mission", () => {
  assert.equal(cc.isAuthReadinessEnabled(), false);
  assert.equal(cc.AUTH_READINESS_ENABLED, false);
  assert.equal(cc.AUTH_READINESS_DISABLED_REASON, "auth_probing_disabled");
});

test("redactAuthStatus throws ERR_AUTH_READINESS_DISABLED", () => {
  assert.throws(
    () => cc.redactAuthStatus("{}"),
    (err) => err instanceof cc.CapabilitySnapshotContractError && err.code === "ERR_AUTH_READINESS_DISABLED"
  );
});

test("classifyAuthState throws ERR_AUTH_READINESS_DISABLED", () => {
  assert.throws(
    () => cc.classifyAuthState({}),
    (err) => err instanceof cc.CapabilitySnapshotContractError && err.code === "ERR_AUTH_READINESS_DISABLED"
  );
});

test("validateCapabilitySnapshot accepts the canonical shape", () => {
  const snap = cc.validateCapabilitySnapshot(buildSnapshot());
  assert.equal(snap.auth_state, "unknown");
  assert.equal(snap.auth_state_reason, "auth_probing_disabled");
  assert.equal(snap.no_credential, true);
  assert.deepEqual(snap.probe_families, ALLOWED_FAMILIES);
  assert.equal(snap.capabilities.text.level, "explicit");
});

test("validateCapabilitySnapshot rejects auth_state='ready' with ERR_AUTH_STATE_DISABLED", () => {
  assert.throws(
    () => cc.validateCapabilitySnapshot(buildSnapshot({ auth_state: "ready" })),
    (err) => err.code === "ERR_AUTH_STATE_DISABLED"
  );
});

test("validateCapabilitySnapshot rejects auth_state='blocked' with ERR_AUTH_STATE_DISABLED", () => {
  assert.throws(
    () => cc.validateCapabilitySnapshot(buildSnapshot({ auth_state: "blocked" })),
    (err) => err.code === "ERR_AUTH_STATE_DISABLED"
  );
});

test("validateCapabilitySnapshot rejects unknown auth_state with ERR_AUTH_STATE_UNKNOWN", () => {
  assert.throws(
    () => cc.validateCapabilitySnapshot(buildSnapshot({ auth_state: "expired" })),
    (err) => err.code === "ERR_AUTH_STATE_UNKNOWN"
  );
});

test("validateProbeFamilies rejects 'auth_status' as non-allow-listed", () => {
  assert.throws(
    () => cc.validateProbeFamilies(["version", "help", "resource_help", "auth_status"], "t"),
    (err) => err.code === "ERR_PROBE_FAMILY_NOT_ALLOWED"
  );
});

test("validateProbeFamilies rejects 'config_export_schema' as non-allow-listed", () => {
  assert.throws(
    () => cc.validateProbeFamilies(["version", "config_export_schema"], "t"),
    (err) => err.code === "ERR_PROBE_FAMILY_NOT_ALLOWED"
  );
});

test("validateProbeFamilies rejects length mismatch", () => {
  assert.throws(
    () => cc.validateProbeFamilies(["version", "help"], "t"),
    (err) => err.code === "ERR_PROBE_FAMILIES_LENGTH_MISMATCH"
  );
});

test("validateCapabilitySnapshot rejects unknown top-level field", () => {
  const bad = buildSnapshot();
  bad.extra = "nope";
  assert.throws(
    () => cc.validateCapabilitySnapshot(bad),
    (err) => err.code === "ERR_FIELD_UNKNOWN"
  );
});

test("validateCapabilitySnapshot rejects unknown capability level", () => {
  const bad = buildSnapshot();
  bad.capabilities.text.level = "magical";
  assert.throws(
    () => cc.validateCapabilitySnapshot(bad),
    (err) => err.code === "ERR_CAPABILITY_LEVEL_UNKNOWN"
  );
});

test("validateCapabilitySnapshot rejects unknown capability source", () => {
  const bad = buildSnapshot();
  bad.capabilities.text.source = "fairy";
  assert.throws(
    () => cc.validateCapabilitySnapshot(bad),
    (err) => err.code === "ERR_CAPABILITY_SOURCE_UNKNOWN"
  );
});

test("validateCapabilitySnapshot rejects no_credential=false", () => {
  assert.throws(
    () => cc.validateCapabilitySnapshot(buildSnapshot({ no_credential: false })),
    (err) => err.code === "ERR_NO_CREDENTIAL_FALSE"
  );
});

test("validateCapabilitySnapshot rejects snapshot_id with bad format", () => {
  assert.throws(
    () => cc.validateCapabilitySnapshot(buildSnapshot({ snapshot_id: "bad" })),
    (err) => err.code === "ERR_SNAPSHOT_ID_INVALID"
  );
});

test("validateCapabilitySnapshot rejects any sk-... taint in auth_state_reason", () => {
  assert.throws(
    () => cc.validateCapabilitySnapshot(buildSnapshot({ auth_state_reason: "leaked sk-c-XYZABCDEF1234567890" })),
    (err) => err.code === "ERR_SNAPSHOT_TAINTED"
  );
});

test("validateAsyncJobDescriptor accepts canonical shape and rejects raw URLs / keys", () => {
  const ok = {
    schema_version: cc.MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
    job_id: "TASK-abc123",
    resource: "video",
    status: "submitted",
    submitted_at: "2026-07-29T03:00:00.000Z",
    last_observed_at: "2026-07-29T03:00:00.000Z",
    output_refs: [{ kind: "url", ref: "https://example.com/asset", redacted: true }],
    cost_status: "unavailable",
    redacted: true,
  };
  const validated = cc.validateAsyncJobDescriptor(ok);
  assert.equal(validated.redacted, true);

  const tainted = Object.assign({}, ok, {
    output_refs: [{ kind: "url", ref: "https://user:pass@example.com/asset", redacted: true }],
  });
  assert.throws(() => cc.validateAsyncJobDescriptor(tainted), (err) => err.code === "ERR_SNAPSHOT_TAINTED");

  const noRedaction = Object.assign({}, ok, {
    output_refs: [{ kind: "url", ref: "https://example.com/asset", redacted: false }],
  });
  assert.throws(() => cc.validateAsyncJobDescriptor(noRedaction), (err) => err.code === "ERR_OUTPUT_REF_NOT_REDACTED");
});

test("validateAsyncJobDescriptor rejects non-async resource", () => {
  const bad = {
    schema_version: cc.MINIMAX_ASYNC_JOB_SCHEMA_VERSION,
    job_id: "TASK-abc123",
    resource: "text",
    status: "submitted",
    submitted_at: "2026-07-29T03:00:00.000Z",
    last_observed_at: "2026-07-29T03:00:00.000Z",
    output_refs: [],
    cost_status: "unavailable",
    redacted: true,
  };
  assert.throws(() => cc.validateAsyncJobDescriptor(bad), (err) => err.code === "ERR_ASYNC_RESOURCE_UNKNOWN");
});

test("stableSnapshotHash is deterministic for identical inputs", () => {
  const snap = cc.validateCapabilitySnapshot(buildSnapshot());
  const h1 = cc.stableSnapshotHash(snap);
  const h2 = cc.stableSnapshotHash(snap);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});