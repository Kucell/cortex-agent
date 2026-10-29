"use strict";

// ---------------------------------------------------------------------------
// Framework generality gate — reverse verification.
//
// cortex-agent ships to every managed project, so a field project's identity
// bound into the framework is a defect. The gate is only worth having if it
// actually fires on that defect, and only useful if it stays quiet on the
// legitimate mentions that carry real meaning — a decision trail naming the
// project a change was verified against, and the framework's own
// identifiers.
//
// So each case injects one defect and asserts the check fires, plus the
// negative cases that keep the gate from crying wolf on every project name
// that appears in the framework's own history.
// ---------------------------------------------------------------------------

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CHECK = path.join(ROOT, "scripts", "check-framework-generality.js");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

// A fixture tree with one distributed file. `files` maps a relative path
// inside the tree to its content.
function buildFixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-framework-generality-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files || {})) {
    write(path.join(root, rel), content);
  }
  return root;
}

function runCheck(root) {
  return spawnSync(process.execPath, [CHECK, "--root", root], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

// ─── The defects the gate must catch ─────────────────────────────────────────

test("a field project's repo name in a distributed config fails", (t) => {
  const root = buildFixture(t, {
    "templates/_shared/.agent/config/vcs.yml.example": [
      "default:",
      "  org: SamkoonHMI",
      "  repo: SamHMI",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, "the gate must fire on a bound repo name");
  assert.match(result.stderr, /field-project-identity/);
});

test("a field project's mission identifier fails", (t) => {
  const root = buildFixture(t, {
    "lib/coordination/anchor-authorization.js": [
      '"use strict";',
      'const TRACKED_MISSION = "M-053";',
      "module.exports = { TRACKED_MISSION };",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, "the gate must fire on a field mission id");
  assert.match(result.stderr, /field-mission-identifier/);
});

test("a field project's slug in a code literal fails", (t) => {
  const root = buildFixture(t, {
    "lib/coordination/anchor-authorization.js": [
      '"use strict";',
      'const SCOPE = "samhmi:dispatch-authority";',
      "module.exports = { SCOPE };",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, "the gate must fire on a field project slug");
  assert.match(result.stderr, /field-project-identity/);
});

test("a personal account name fails", (t) => {
  const root = buildFixture(t, {
    "templates/_shared/.agent/config/secrets.yml.example": [
      "secrets:",
      "  - ref: gitea-pr",
      "    account: xueyq",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, "the gate must fire on a personal account");
  assert.match(result.stderr, /personal-account/);
});

test("a private host address fails", (t) => {
  const root = buildFixture(t, {
    "templates/_shared/.agent/config/vcs.yml.example": [
      'host: "http://192.168.2.110:3000"',
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, "the gate must fire on a private host");
  assert.match(result.stderr, /private-host-address/);
});

test("a field project named in a document title fails", (t) => {
  const root = buildFixture(t, {
    "docs/architecture/samhmi-integration.md": [
      "# SamHMI integration notes",
      "",
      "The body may name the project.",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1, "the gate must fire on a bound document name");
  assert.match(result.stderr, /field-project-document-name/);
});

test("a field project named in a document body does not fail", (t) => {
  const root = buildFixture(t, {
    "docs/architecture/integration-notes.md": [
      "# Integration notes",
      "",
      "Verified against SamHMI on 2026-10-28.",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, "a decision trail naming a project is legitimate");
});

// ─── The legitimate mentions the gate must not flag ───────────────────────────

test("the framework's own mission identifiers do not fail", (t) => {
  const root = buildFixture(t, {
    "lib/coordination/protected-scope.js": [
      '"use strict";',
      "// See M-044 / MS-004 / VC-044-013 for the derivation.",
      "module.exports = {};",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, "the framework's own traceability is not a binding");
});

test("a loopback address does not fail", (t) => {
  const root = buildFixture(t, {
    "templates/_shared/.agent/skills/dashboard/scripts/serve.js": [
      'server.listen(port, "127.0.0.1", () => {});',
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, "127.0.0.1 addresses a local server on every machine");
});

test("a placeholder project name does not fail", (t) => {
  const root = buildFixture(t, {
    "templates/_shared/.agent/config/vcs.yml.example": [
      "default:",
      "  org: your-org",
      "  repo: your-repo",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, "a placeholder is the recommended spelling");
});

test("a comment explaining a decision does not fail", (t) => {
  const root = buildFixture(t, {
    "lib/coordination/cross-machine-permit.js": [
      '"use strict";',
      "// Observed in SamHMI: the stale run captured the next PR event.",
      "module.exports = {};",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, "a comment explains; it does not bind");
});

test("a fenced example in a document does not fail", (t) => {
  const root = buildFixture(t, {
    "docs/architecture/config-shape.md": [
      "# Config shape",
      "",
      "```yaml",
      "default:",
      "  repo: SamHMI",
      "```",
      "",
    ].join("\n"),
  });
  const result = runCheck(root);
  assert.equal(result.status, 0, "a fenced block shows an example");
});

// ─── The repository itself must be clean ──────────────────────────────────────

test("the repository has no field-project binding", () => {
  const result = runCheck(ROOT);
  assert.equal(
    result.status,
    0,
    `the framework must not bind a field project:\n${result.stderr}`,
  );
});
