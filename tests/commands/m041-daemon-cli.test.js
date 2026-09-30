"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  daemonCommand,
  parse,
} = require("../../lib/commands/daemon.js");

function io() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    read() { return { stdout, stderr }; },
  };
}

test("daemon CLI parser keeps lifecycle explicit", () => {
  assert.deepEqual(parse(["daemon", "start", "--poll-interval-ms", "2500", "--json"]), {
    action: "start",
    json: true,
    help: false,
    poll_interval_ms: 2500,
  });
});

test("daemon status is read-only and includes PlatformHealth", async () => {
  const output = io();
  const old = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await daemonCommand({
      cwd: "/tmp/project",
      args: ["daemon", "status", "--json"],
    }, {
      io: output,
      status: () => ({
        ok: true,
        read_only: true,
        live: false,
        stale_owner: false,
        state: { enabled: false, status: "stopped", pid: null },
      }),
      createHealth: () => ({
        produce: async () => [{
          id: "daemon:control-service",
          kind: "daemon",
          status: "healthy",
          observed_at: "2026-09-30T04:00:00.000Z",
          producer: { id: "test", kind: "fixture", version: "1" },
          checks: [],
          evidence_refs: [],
          redacted: true,
        }],
      }),
    });

    assert.equal(result.mutated, false);
    const payload = JSON.parse(output.read().stdout);
    assert.equal(payload.read_only, true);
    assert.equal(payload.platform_health.overall, "healthy");
  } finally {
    process.exitCode = old;
  }
});

test("daemon invalid action never calls lifecycle owners", async () => {
  let calls = 0;
  const output = io();
  const old = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await daemonCommand({
      cwd: "/tmp/project",
      args: ["daemon", "magic", "--json"],
    }, {
      io: output,
      start: () => { calls += 1; },
      stop: () => { calls += 1; },
      status: () => { calls += 1; },
      createHealth: () => ({ produce: async () => [] }),
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.equal(process.exitCode, 2);
  } finally {
    process.exitCode = old;
  }
});
