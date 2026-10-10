"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/npm-release.yml"), "utf8");
const docs = fs.readFileSync(path.join(root, "docs/releasing.md"), "utf8");

test("npm release stays manual-compatible and adds opt-in governed comment trigger", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /issue_comment:/);
  assert.match(workflow, /CORTEX_AUTO_RELEASE_ENABLED/);
  assert.match(workflow, /verify-approved-release\.cjs/);
  assert.doesNotMatch(workflow, /\npush:\s*\n/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
});

test("npm release workflow never relies on a long-lived npm publish token", () => {
  assert.doesNotMatch(workflow, /NPM_TOKEN/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
  assert.match(workflow, /npm publish --access public --tag/);
  assert.match(workflow, /npm install --global npm@11/);
  assert.match(workflow, /npm >= 11\.5\.1 required/);
});

test("npm release workflow validates before any release write", () => {
  const guard = workflow.indexOf("Run architecture guard");
  const focused = workflow.indexOf("Run focused product validation");
  const pack = workflow.indexOf("Verify package can be packed");
  const push = workflow.indexOf("Commit version and create tag");
  const publish = workflow.indexOf("Publish to npm with Trusted Publishing");

  assert.ok(guard >= 0);
  assert.ok(focused > guard);
  assert.ok(pack > focused);
  assert.ok(push > pack);
  assert.ok(publish > push);
});

test("npm release workflow defaults to dry-run and supports current or version bumps", () => {
  assert.match(workflow, /default:\s*current/);
  for (const releaseType of ["current", "patch", "minor", "major"]) {
    assert.match(workflow, new RegExp("- " + releaseType));
  }
  assert.match(workflow, /default:\s*false/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && !inputs\.publish/);
  assert.match(workflow, /github\.event_name == 'issue_comment' \|\| inputs\.publish/);
});

test("npm release workflow is retry-safe for published versions and GitHub releases", () => {
  assert.match(workflow, /is already published; treating npm publish as completed/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /git push origin HEAD:main/);
  assert.doesNotMatch(workflow, /git push .*--force/);
});

test("release documentation names the exact npm Trusted Publisher workflow", () => {
  assert.match(docs, /Workflow filename: `npm-release\.yml`/);
  assert.match(docs, /Organization or user: `Kucell`/);
  assert.match(docs, /Repository: `cortex-agent`/);
  assert.match(docs, /release_type=current/);
  assert.match(docs, /Never force-push `main`/);
});

test("automatic read-only preflight cannot trigger npm publication", () => {
  const preflight = fs.readFileSync(path.join(root, ".github/workflows/npm-release-preflight.yml"), "utf8");
  assert.match(preflight, /push:/);
  assert.match(preflight, /permissions:\s*\n\s*contents: read/);
  assert.match(preflight, /verify-approved-release\.test\.js/);
  assert.doesNotMatch(preflight, /npm publish|gh release create|git push|id-token:\s*write/);
});

test("release publication rechecks current main and live approval at the effect boundary", () => {
  const tag = workflow.indexOf("Commit version and create tag");
  const immutability = workflow.indexOf("Verify main/tag immutability before any registry write");
  const secondGate = workflow.indexOf("Revalidate Cortex authorization at npm effect boundary");
  const publishing = workflow.indexOf("Publish to npm with Trusted Publishing");
  assert.ok(tag >= 0 && immutability > tag && secondGate > immutability && publishing > secondGate);
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.match(workflow, /refusing npm publish/);
});


test("v1.15.4 publication and preflight run real reconcile CLI subprocess regressions", () => {
  const preflight = fs.readFileSync(path.join(root, ".github/workflows/npm-release-preflight.yml"), "utf8");
  const command = "node --test tests/commands/reconcile.test.js tests/cli/reconcile-entrypoint.test.js tests/cli/cli-contract.test.js";
  for (const source of [workflow, preflight]) {
    assert.match(source, /Verify shipped reconcile CLI entrypoint/);
    assert.ok(source.includes(command));
    assert.match(source, /v1\.15\.4 requires the real reconcile CLI regression tests/);
    assert.ok(source.indexOf("Verify shipped reconcile CLI entrypoint") < source.indexOf("npm pack --dry-run"));
  }
});

test("manual publish cannot bypass the Cortex release gate", () => {
  for (const input of ["release_pr:", "expected_sha:", "decision_id:", "waitpoint_id:"]) {
    assert.ok(workflow.includes(input), "Missing manual release input " + input);
  }
  const gate = "if: ${{ github.event_name == 'issue_comment' || inputs.publish }}";
  const lines = workflow.split("\n").filter(line => line.trim() === gate);
  assert.ok(lines.length >= 3, "all authorization checkpoints must cover manual publish");
  for (const name of [
    "Verify exact-head Cortex release authorization",
    "Revalidate Cortex authorization before Git tag write",
    "Revalidate Cortex authorization at npm effect boundary"
  ]) {
    const segment = "- name: " + name + "\n        " + gate;
    assert.ok(workflow.includes(segment), "unprotected authorization checkpoint: " + name);
  }
  assert.match(workflow, /Revalidate Cortex authorization before Git tag write/);
  assert.match(workflow, /Revalidate Cortex authorization at npm effect boundary/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && !inputs\.publish/);
  assert.match(workflow, /github\.event_name == 'issue_comment' \|\| inputs\.publish/);
});
