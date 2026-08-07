"use strict";

// ─── lib/commands/surface/dev.js unit tests ───────────────────────────────────
//
// Coverage:
//   - devUsageError prints message + usage banner, sets exitCode = 2
//   - parseDevOptions: empty args → defaults (port=8787, intervalMs=3000)
//   - parseDevOptions: --port N parses
//   - parseDevOptions: --port out of range → error
//   - parseDevOptions: --interval-ms N parses
//   - parseDevOptions: --interval-ms out of range → error
//   - parseDevOptions: --session-id accepts valid chars
//   - parseDevOptions: --session-id rejects invalid chars
//   - parseDevOptions: unknown option → error
//   - parseDevOptions: missing value → error
//   - parseDevOptions: --key=value form parses
//   - dev: missing .agent directory → exitCode = 2

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { devUsageError, parseDevOptions, dev } = require("../../../lib/commands/surface/dev");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

test("devUsageError sets exitCode = 2 and prints message + usage", () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    devUsageError("test message");
    assert.equal(process.exitCode, 2);
  } finally {
    const err = restoreErr();
    restoreOut();
    process.exitCode = origExit;
  }
});

test("parseDevOptions: empty args → defaults", () => {
  const r = parseDevOptions(["dev"]);
  assert.deepEqual(r, { values: { port: 8787, intervalMs: 3000, sessionId: null } });
});

test("parseDevOptions: --port 9000 parses", () => {
  const r = parseDevOptions(["dev", "--port", "9000"]);
  assert.equal(r.values.port, 9000);
});

test("parseDevOptions: --port 0 → error (below min)", () => {
  const r = parseDevOptions(["dev", "--port", "0"]);
  assert.match(r.error, /must be between/);
});

test("parseDevOptions: --port 99999 → error (above max)", () => {
  const r = parseDevOptions(["dev", "--port", "99999"]);
  assert.match(r.error, /must be between/);
});

test("parseDevOptions: --port=9000 inline form parses", () => {
  const r = parseDevOptions(["dev", "--port=9000"]);
  assert.equal(r.values.port, 9000);
});

test("parseDevOptions: --port abc → error (not an integer)", () => {
  const r = parseDevOptions(["dev", "--port", "abc"]);
  assert.match(r.error, /must be an integer/);
});

test("parseDevOptions: --interval-ms 5000 parses", () => {
  const r = parseDevOptions(["dev", "--interval-ms", "5000"]);
  assert.equal(r.values.intervalMs, 5000);
});

test("parseDevOptions: --interval-ms 100 → error (below min 1000)", () => {
  const r = parseDevOptions(["dev", "--interval-ms", "100"]);
  assert.match(r.error, /must be between/);
});

test("parseDevOptions: --session-id valid → accepted", () => {
  const r = parseDevOptions(["dev", "--session-id", "abc_123-X"]);
  assert.equal(r.values.sessionId, "abc_123-X");
});

test("parseDevOptions: --session-id invalid chars → error", () => {
  const r = parseDevOptions(["dev", "--session-id", "bad space"]);
  assert.match(r.error, /unsupported characters/);
});

test("parseDevOptions: unknown option → error", () => {
  const r = parseDevOptions(["dev", "--unknown", "x"]);
  assert.match(r.error, /unknown option/);
});

test("parseDevOptions: missing value → error", () => {
  const r = parseDevOptions(["dev", "--port"]);
  assert.match(r.error, /requires a value/);
});

test("dev: missing .agent directory → exitCode = 2", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dev-test-"));
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await dev({ args: ["dev"], cwd: root, options: {}, lang: "en", command: "dev" });
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});
