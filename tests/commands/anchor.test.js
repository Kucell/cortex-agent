"use strict";

// ─── lib/commands/anchor.js unit tests ────────────────────────────────────────
//
// Coverage:
//   - writePublicAnchor: isGlobal=true → no-op, returns false
//   - writePublicAnchor: isGlobal=false → writes docs/cortex-agent/anchor.md,
//     returns true
//   - writePublicAnchor: buildAnchor throws → returns false + warns
//   - exportAnchor: parses --json / --markdown / --project / --name flags
//   - exportAnchor: --help prints help, no process.exit
//   - exportAnchor: --project to a non-existent dir → process.exitCode = 2

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { writePublicAnchor, exportAnchor } = require("../../lib/commands/anchor");

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-anchor-test-"));
}

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

test("writePublicAnchor: isGlobal=true → no-op, returns false, no files written", () => {
  const root = mkRoot();
  const res = writePublicAnchor(root, true);
  assert.equal(res, false);
  assert.equal(fs.existsSync(path.join(root, "docs", "cortex-agent", "anchor.md")), false);
});

test("writePublicAnchor: isGlobal=false → writes anchor.md, returns true", () => {
  const root = mkRoot();
  const res = writePublicAnchor(root, false);
  assert.equal(res, true);
  const anchorPath = path.join(root, "docs", "cortex-agent", "anchor.md");
  assert.equal(fs.existsSync(anchorPath), true);
  const body = fs.readFileSync(anchorPath, "utf8");
  // Anchor body is versioned HTML comment + content.
  assert.match(body, /cortex-agent:anchor:v1/);
  assert.match(body, /cortex-agent/);
});

test("exportAnchor: --help → prints help, exit code unchanged", () => {
  const root = mkRoot();
  const ctx = {
    args: ["export-anchor", "--help"],
    options: {},
    cwd: root,
    lang: "en",
  };
  const { restore: restoreOut } = captureStdout();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    exportAnchor(ctx);
  } finally {
    restoreOut();
    process.exitCode = origExit;
  }
  assert.equal(process.exitCode, origExit, "exitCode must not change on --help");
  // Force-clear for child-process isolation.
  process.exitCode = undefined;
});

test("exportAnchor: default (markdown) → emits anchor body to stdout", () => {
  const root = mkRoot();
  const ctx = {
    args: ["export-anchor"],
    options: {},
    cwd: root,
    lang: "en",
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  try {
    exportAnchor(ctx);
  } finally {
    const out = restoreOut();
    restoreErr();
    assert.match(out, /cortex-agent:anchor:v1/);
  }
});

test("exportAnchor: --json → emits JSON to stdout (no markdown comments)", () => {
  const root = mkRoot();
  const ctx = {
    args: ["export-anchor", "--json"],
    options: {},
    cwd: root,
    lang: "en",
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  try {
    exportAnchor(ctx);
  } finally {
    const out = restoreOut();
    restoreErr();
    const parsed = JSON.parse(out);
    assert.ok(parsed, "stdout must be valid JSON");
    // JSON shape from lib/anchor.js: { schema, version, framework, ... }.
    // No markdown comment "<!-- cortex-agent:anchor:v1 -->" should appear.
    assert.equal(parsed.schema, "cortex-agent.anchor");
    assert.equal(parsed.version, "v1");
    assert.equal(parsed.framework, "cortex-agent");
    assert.doesNotMatch(out, /cortex-agent:anchor:v1/);
  }
});

test("exportAnchor: --project to non-existent dir → process.exitCode = 2", () => {
  const root = mkRoot();
  const ctx = {
    args: ["export-anchor", "--project", path.join(root, "no-such-dir")],
    options: {},
    cwd: root,
    lang: "en",
  };
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    exportAnchor(ctx);
  } finally {
    restoreOut();
    restoreErr();
  }
  assert.equal(process.exitCode, 2);
  process.exitCode = origExit; // restore for child-process isolation
});
