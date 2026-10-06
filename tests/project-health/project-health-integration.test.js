"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  ensureProjectDescriptor,
  readDescriptor,
  writeDescriptor,
} = require("../../lib/governance/lifecycle");
const { createGitGovernanceStore } = require("../../lib/governance/git-store");
const { projectHealth } = require("../../lib/project/health");
const { reconcile } = require("../../lib/reconciliation");
const { createLocalCortexClient } = require("../../lib/sdk/local-client");
const { createHandler } = require("../../lib/mcp/server");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-project-health-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  ensureProjectDescriptor(root, { project_id: "cortex-project-health-fixture" });
  return root;
}

function replaceBinding(root, governance) {
  const current = readDescriptor(root);
  return writeDescriptor(root, {
    schema_version: current.schema_version,
    project_id: current.project_id,
    repository: current.repository,
    integration_mode: current.integration_mode,
    capabilities: current.capabilities,
    validation: current.validation,
    artifacts: current.artifacts,
    events: current.events,
    boundaries: current.boundaries,
    governance,
  });
}

test("embedded filesystem project health is observed and healthy", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const health = projectHealth(root);
  assert.equal(health.project.project_id, "cortex-project-health-fixture");
  assert.equal(health.governance.binding.kind, "filesystem");
  assert.equal(health.governance.accessibility.status, "observed");
  assert.equal(health.governance.store.capabilities.read, true);
  assert.equal(health.health.status, "healthy");
});

test("project health passes through reconciliation summary without reimplementing rules", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = reconcile({
    governance_snapshot: { expected_revision: "G-1", actual_revision: "G-2" },
    workspace: { head_revision: "P-1" },
    product: { head_revision: "P-1" },
    change_request: { revision: "P-1" },
    governance: { decisions: [], waitpoints: [], locks: [] },
    observations: [],
  });
  const health = projectHealth(root, { reconciliation_result: result });
  assert.equal(health.reconciliation.disposition, "RECONCILIATION_REQUIRED");
  assert.equal(health.reconciliation.can_resume, false);
  assert.equal(health.health.status, "blocked");
});

test("locally accessible Git governance projects expose revision and capabilities", (t) => {
  const root = fixture();
  const repo = path.join(path.dirname(root), path.basename(root) + "-governance.git");
  fs.mkdirSync(repo);
  const init = spawnSync("git", ["init", "-q", "--bare"], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const store = createGitGovernanceStore(repo);
  const write = store.writeJson("tasks/T-1.json", { task_id: "T-1" }, { expected_revision: null });

  replaceBinding(root, {
    kind: "git",
    locator: path.relative(root, repo).replace(/\\/g, "/"),
    ref: "main",
  });

  const health = projectHealth(root);
  assert.equal(health.governance.accessibility.status, "observed");
  assert.equal(health.governance.store.revision.value, write.revision.value);
  assert.equal(health.governance.store.capabilities.compare_and_write, true);
  assert.equal(health.health.status, "healthy");
});

test("remote Git locator without bound transport is explicit degraded/unavailable", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  replaceBinding(root, {
    kind: "git",
    locator: "github://org/project-agent",
    ref: "main",
  });

  const health = projectHealth(root);
  assert.equal(health.governance.accessibility.status, "unavailable");
  assert.equal(health.governance.accessibility.reason, "remote_transport_unbound");
  assert.equal(health.health.status, "degraded");
  assert.ok(health.health.reasons.includes("remote_transport_unbound"));
});

test("SDK project health uses stable descriptor identity and synthetic projection", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const ctx = { cwd: root, args: ["query", "project-health"], options: {}, lang: "en" };
  const client = createLocalCortexClient(ctx);
  assert.equal(client.project.resolve().project_id, "cortex-project-health-fixture");
  const health = client.project.health();
  assert.equal(health.project.project_id, "cortex-project-health-fixture");
  assert.equal(health.health.status, "healthy");
});

test("MCP exposes the same project-health projection as a read-only tool and resource", async (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expected = projectHealth(root);
  const handler = createHandler({
    cwd: root,
    projectHealth: () => expected,
  });

  const listed = await handler.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  assert.ok(listed.tools.some((tool) => tool.name === "project/health"));

  const called = await handler.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "project/health", arguments: {} },
  });
  assert.equal(called.isError, false);
  assert.equal(called.structuredContent.project.project_id, expected.project.project_id);

  const resource = await handler.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "cortex://project/health" },
  });
  assert.equal(JSON.parse(resource.contents[0].text).project.project_id, expected.project.project_id);
});
