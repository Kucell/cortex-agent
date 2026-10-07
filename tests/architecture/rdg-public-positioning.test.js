"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..", "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("README positions Cortex as durable distributed governance", () => {
  const readme = read("README.md");
  assert.match(readme, /durable engineering governance layer|持久工程治理层/);
  assert.match(readme, /Develop anywhere\. Resume everywhere\. Keep one authoritative project state\./);
  assert.match(readme, /ProjectIdentity/);
  assert.match(readme, /GovernanceStore/);
  assert.match(readme, /ExecutionWorkspace/);
});

test("public provider claims distinguish live GitHub from GitLab and Gitee conformance", () => {
  const readme = read("README.md");
  const matrix = read("docs/architecture/provider-capability-matrix.md");

  assert.match(readme, /GitHub.*Live end-to-end validated/s);
  assert.match(readme, /GitLab.*Adapter \+ capability conformance/s);
  assert.match(readme, /Gitee.*Adapter \+ capability conformance/s);

  assert.doesNotMatch(readme, /GitLab[^\n]{0,120}live end-to-end validated/i);
  assert.doesNotMatch(readme, /Gitee[^\n]{0,120}live end-to-end validated/i);
  assert.match(matrix, /GitHub \| ✅ \| ✅ \| ✅/);
  assert.match(matrix, /GitLab \| ✅ \| ✅ \| Not currently claimed/);
  assert.match(matrix, /Gitee \| ✅ \| ✅ \| Not currently claimed/);
});

test("remote governance doc describes delivered architecture instead of MS-001-only baseline", () => {
  const doc = read("docs/architecture/remote-detached-governance.md");
  assert.match(doc, /Status: delivered architecture/);
  assert.match(doc, /Reconciliation and controlled resume/);
  assert.match(doc, /Remote \/parallel/);
  assert.match(doc, /project-health/);
  assert.doesNotMatch(doc, /Scope: contract freeze only/);
});
