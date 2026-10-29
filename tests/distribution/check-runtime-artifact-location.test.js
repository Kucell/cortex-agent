"use strict";

// ---------------------------------------------------------------------------
// Runtime artifact location gate — reverse verification.
//
// The gate exists to stop a skill from shipping a `/tmp` draft directory to
// every managed project. It is only worth having if it actually fires, and
// only useful if it does not fire on the legitimate exception the rule
// documents (process plumbing, a single-test fixture).
//
// So each case injects one defect and asserts the corresponding check fires,
// plus the negative cases that keep the gate from crying wolf.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CHECK = path.join(ROOT, "scripts", "check-runtime-artifact-location.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// A fixture tree with one distributed skill. `files` maps a relative path
// inside the skill directory to its content.
function buildFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-artifact-loc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillDir = path.join(root, "templates", "_shared", ".agent", "skills", "demo-skill");
  for (const [rel, content] of Object.entries(files || {})) {
    write(path.join(skillDir, rel), content);
  }
  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK, "--root", root], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

test("a skill that writes an artifact into a temp directory fails", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-"));',
      'const out = path.join(dir, "report.md");',
      "fs.writeFileSync(out, content);",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /artifact-written-to-temp/);
});

test("an artifact directory created under a temp root fails", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const draftDir = path.join(os.tmpdir(), "drafts");',
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /artifact-dir-under-temp/);
});

test("a document that points an agent at a temp artifact path fails", (t) => {
  const root = buildFixture(t, {
    "SKILL.md": "Write the summary to /tmp/session-summary.json when done.\n",
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /temp-artifact-path-literal/);
});

test("process plumbing — a private child-process context file — passes", (t) => {
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-launch-"));',
      'const filePath = path.join(dir, "context.json");',
      'fs.writeFileSync(filePath, serialized, { encoding: "utf8", mode: 0o600 });',
      "spawnSync(cmd, [filePath]);",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
});

test("a single-test fixture that is cleaned up passes", (t) => {
  const root = buildFixture(t, {
    "tests/demo.test.js": [
      'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-"));',
      'fs.writeFileSync(path.join(dir, "catalog.json"), "{}");',
      "fs.rmSync(dir, { recursive: true, force: true });",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
});

test("a test fixture that is never cleaned up fails", (t) => {
  const root = buildFixture(t, {
    "tests/demo.test.js": [
      'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-"));',
      'fs.writeFileSync(path.join(dir, "catalog.json"), "{}");',
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /fixture-not-cleaned-up/);
});

test("a file name that merely contains an artifact keyword is not an artifact", (t) => {
  // "catalog.json" contains "log" but is a fixture, not a runtime artifact.
  const root = buildFixture(t, {
    "scripts/index.js": [
      'const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-"));',
      'fs.writeFileSync(path.join(dir, "catalog.json"), "{}");',
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
});

test("the rule text naming /tmp in order to forbid it passes", (t) => {
  const root = buildFixture(t, {
    "rules/runtime-artifacts-location.md": [
      "# Runtime Artifact Location",
      "",
      "- Do not write runtime artifacts or scripts to /tmp (or os.tmpdir()).",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, `expected pass, got:\n${result.stdout}${result.stderr}`);
});

