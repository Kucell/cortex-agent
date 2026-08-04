"use strict";

// ─── M-011 / ARI P-005 — safe-probe contract tests ────────────────────────
// Zero external dependencies.

const test = require("node:test");
const assert = require("node:assert/strict");

const cc = require("../lib/runtime-adapters/minimax-cli-capability-contract");
const probeMod = require("../lib/runtime-adapters/minimax-cli-probe");

function makeFakeExec(scriptedResponses) {
  // scriptedResponses: array of { args_match: string[], result: {status, stdout?, stderr?} }
  const calls = [];
  return {
    calls,
    exec: (binary, args) => {
      calls.push({ binary, args });
      for (const sr of scriptedResponses) {
        const matched = sr.args_match.every((m, i) => args[i] === m);
        if (matched) {
          return Object.assign({ status: sr.result.status, signal: null, stdout: sr.result.stdout || "", stderr: sr.result.stderr || "" }, sr.result);
        }
      }
      return { status: 0, signal: null, stdout: "", stderr: "" };
    },
  };
}

test("buildArgs refuses every non-allow-listed family", () => {
  const forbidden = [
    "config_export_schema",
    "auth_status",
    "auth_login",
    "auth_logout",
    "auth_refresh",
    "config_show",
    "config_set",
    "config_export",
    "quota_show",
    "update",
    "install",
    "file_upload",
    "file_list",
    "file_delete",
    "text_chat",
    "image_generate",
    "video_generate",
    "video_task_get",
    "music_generate",
    "music_cover",
    "search_query",
    "vision_describe",
    "speech_synthesize",
  ];
  for (const f of forbidden) {
    assert.throws(
      () => probeMod.buildArgs(f),
      (err) => err instanceof probeMod.MiniMaxCliProbeError && err.code === "ERR_PROBE_FAMILY_NOT_ALLOWED",
      `expected buildArgs(${f}) to throw ERR_PROBE_FAMILY_NOT_ALLOWED`
    );
  }
});

test("buildArgs accepts the three allow-listed families", () => {
  assert.deepEqual(probeMod.buildArgs("version"), ["--version"]);
  assert.deepEqual(probeMod.buildArgs("help"), ["--help"]);
  assert.deepEqual(probeMod.buildArgs("resource_help", "text"), ["text", "--help"]);
});

test("buildArgs requires resource for resource_help", () => {
  assert.throws(
    () => probeMod.buildArgs("resource_help"),
    (err) => err.code === "ERR_RESOURCE_REQUIRED"
  );
});

test("buildArgs rejects unknown resource", () => {
  assert.throws(
    () => probeMod.buildArgs("resource_help", "foo"),
    (err) => err.code === "ERR_RESOURCE_UNKNOWN"
  );
});

test("runSafeProbe produces a snapshot with auth_state='unknown' regardless of binary content", () => {
  const fake = makeFakeExec([
    { args_match: ["--version"], result: { status: 0, stdout: "mmx 1.0.18\n" } },
    { args_match: ["--help"], result: { status: 0, stdout: "" } },
    { args_match: ["text", "--help"], result: { status: 0 } },
    { args_match: ["image", "--help"], result: { status: 0 } },
    { args_match: ["video", "--help"], result: { status: 0 } },
    { args_match: ["speech", "--help"], result: { status: 0 } },
    { args_match: ["music", "--help"], result: { status: 0 } },
    { args_match: ["vision", "--help"], result: { status: 0 } },
    { args_match: ["search", "--help"], result: { status: 0 } },
  ]);
  const snap = probeMod.runSafeProbe({ exec: fake.exec, binary: "mmx", now: "2026-07-29T03:00:00.000Z" });
  assert.equal(snap.auth_state, "unknown");
  assert.equal(snap.auth_state_reason, "auth_probing_disabled");
  assert.equal(snap.no_credential, true);
  assert.deepEqual(snap.probe_families, ["version", "help", "resource_help"]);
  assert.equal(snap.binary.available, true);
  assert.equal(snap.binary.version, "mmx 1.0.18");
  // Every resource must be reported (level "explicit" because help exited 0).
  for (const r of cc.MINIMAX_RESOURCES) {
    assert.equal(snap.capabilities[r].level, "explicit");
  }
  // Probe command log should reference ONLY allow-listed families.
  for (const cmd of snap.probe_command_log) {
    assert.match(cmd, /^mmx (--version|--help|[a-z]+ --help)$/);
  }
});

test("runSafeProbe reports binary_missing when mmx is not on PATH", () => {
  const fake = {
    calls: [],
    exec: () => ({ error: { code: "ENOENT" }, status: null, signal: null, stdout: "", stderr: "" }),
  };
  const snap = probeMod.runSafeProbe({ exec: fake.exec, binary: "mmx", now: "2026-07-29T03:00:00.000Z" });
  assert.equal(snap.binary.available, false);
  for (const r of cc.MINIMAX_RESOURCES) {
    assert.equal(snap.capabilities[r].level, "unsupported");
    assert.equal(snap.capabilities[r].source, "not-implemented");
    assert.equal(snap.capabilities[r].reason, "binary_missing");
  }
});

test("runSafeProbe marks resource as unsupported when <resource> --help exits non-zero", () => {
  const fake = makeFakeExec([
    { args_match: ["--version"], result: { status: 0, stdout: "mmx 1.0.18\n" } },
    { args_match: ["--help"], result: { status: 0 } },
    { args_match: ["text", "--help"], result: { status: 1 } },
    { args_match: ["image", "--help"], result: { status: 1 } },
    { args_match: ["video", "--help"], result: { status: 1 } },
    { args_match: ["speech", "--help"], result: { status: 1 } },
    { args_match: ["music", "--help"], result: { status: 1 } },
    { args_match: ["vision", "--help"], result: { status: 1 } },
    { args_match: ["search", "--help"], result: { status: 1 } },
  ]);
  const snap = probeMod.runSafeProbe({ exec: fake.exec, binary: "mmx", now: "2026-07-29T03:00:00.000Z" });
  for (const r of cc.MINIMAX_RESOURCES) {
    assert.equal(snap.capabilities[r].level, "unsupported");
  }
});

test("runSafeProbe persists no help text in probe_command_log", () => {
  const fake = makeFakeExec([
    { args_match: ["--version"], result: { status: 0, stdout: "mmx 1.0.18\n" } },
    { args_match: ["--help"], result: { status: 0, stdout: "irrelevant" } },
    { args_match: ["text", "--help"], result: { status: 0, stdout: "irrelevant" } },
    { args_match: ["image", "--help"], result: { status: 0 } },
    { args_match: ["video", "--help"], result: { status: 0 } },
    { args_match: ["speech", "--help"], result: { status: 0 } },
    { args_match: ["music", "--help"], result: { status: 0 } },
    { args_match: ["vision", "--help"], result: { status: 0 } },
    { args_match: ["search", "--help"], result: { status: 0 } },
  ]);
  const snap = probeMod.runSafeProbe({ exec: fake.exec, binary: "mmx", now: "2026-07-29T03:00:00.000Z" });
  // probe_command_log entries are command lines, NOT stdout bodies.
  for (const cmd of snap.probe_command_log) {
    assert.ok(cmd.indexOf("irrelevant") === -1, `probe_command_log must not carry stdout: ${cmd}`);
  }
});

test("summarizeBinaryAvailability returns 'available' for present binaries", () => {
  const fake = makeFakeExec([
    { args_match: ["--version"], result: { status: 0, stdout: "mmx 1.0.18\n" } },
    { args_match: ["--help"], result: { status: 0 } },
  ]);
  const snap = probeMod.runSafeProbe({ exec: fake.exec, binary: "mmx", now: "2026-07-29T03:00:00.000Z" });
  assert.equal(probeMod.summarizeBinaryAvailability(snap), "available");
});

test("assertNoForbiddenFamilies accepts the allow-list", () => {
  probeMod.assertNoForbiddenFamilies(["version", "help", "resource_help"]);
});

test("assertNoForbiddenFamilies rejects 'auth_status'", () => {
  assert.throws(
    () => probeMod.assertNoForbiddenFamilies(["version", "auth_status"]),
    (err) => err.code === "ERR_PROBE_FAMILY_NOT_ALLOWED"
  );
});

test("snapshot probe_command_log only references the three allow-listed families", () => {
  const fake = makeFakeExec([
    { args_match: ["--version"], result: { status: 0, stdout: "mmx 1.0.18\n" } },
    { args_match: ["--help"], result: { status: 0 } },
  ]);
  const snap = probeMod.runSafeProbe({ exec: fake.exec, binary: "mmx", now: "2026-07-29T03:00:00.000Z" });
  // Each probe_command_log entry must match `mmx --version`, `mmx --help`, or
  // `mmx <resource> --help`. We assert the pattern directly without calling
  // assertNoForbiddenFamilies on full command lines.
  const pattern = /^mmx (--version|--help|[a-z]+ --help)$/;
  for (const cmd of snap.probe_command_log) {
    assert.match(cmd, pattern, `unexpected probe_command_log entry: ${cmd}`);
  }
});