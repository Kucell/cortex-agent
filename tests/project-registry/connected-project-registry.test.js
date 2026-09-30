"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const registry = require(path.join(ROOT, "lib", "project-registry"));
const topology = require(path.join(ROOT, "lib", "topology"));
const protocol = require(path.join(ROOT, "packages", "protocol", "src"));

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function descriptor(projectId = "axrail") {
  return {
    schema_version: "1",
    project_id: projectId,
    repository: { slug: `Kucell/${projectId}`, default_branch: "main" },
    integration_mode: "connected",
    capabilities: {
      provided: ["project.discover", "project.validation.list"],
      required: [],
    },
    validation: {
      profiles: [{
        id: "check",
        command: "pnpm check",
        purpose: "check",
        blocking: true,
      }],
    },
    artifacts: [],
    events: { mode: "none" },
    boundaries: {
      authoritative_domain: projectId,
      authoritative_runtime: projectId,
      cortex_role: "governance-orchestration",
      protected_components: ["Runtime"],
    },
  };
}

function writeDescriptor(root, value) {
  fs.writeFileSync(
    path.join(root, "cortex.project.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
}

test("connected project registration extends topology instead of creating another registry file", () => {
  const cortex = makeRoot("m041-cortex-");
  const project = makeRoot("m041-project-");
  try {
    writeDescriptor(project, descriptor());
    const result = registry.registerConnectedProject(cortex, project);
    assert.equal(result.registered, true);
    assert.equal(result.project.project_ref, "project:axrail");

    const topo = topology.readTopology(cortex);
    assert.equal(topo.peers.length, 1);
    assert.equal(topo.peers[0].connected_project.repository_slug, "Kucell/axrail");
    assert.equal(fs.existsSync(path.join(cortex, ".agent", "projects.json")), false);
  } finally {
    fs.rmSync(cortex, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("connected project registration is idempotent and refreshes descriptor digest", () => {
  const cortex = makeRoot("m041-cortex-");
  const project = makeRoot("m041-project-");
  try {
    writeDescriptor(project, descriptor());
    registry.registerConnectedProject(cortex, project);
    const again = registry.registerConnectedProject(cortex, project);
    assert.equal(again.registered, false);
    assert.equal(again.idempotent, true);

    const changed = descriptor();
    changed.validation.profiles.push({
      id: "test",
      command: "pnpm test",
      purpose: "test",
      blocking: true,
    });
    writeDescriptor(project, changed);
    const updated = registry.registerConnectedProject(cortex, project);
    assert.equal(updated.updated, true);
    assert.equal(updated.idempotent, false);
    assert.equal(registry.getConnectedProject(cortex, "axrail").drift.detected, false);
  } finally {
    fs.rmSync(cortex, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("descriptor drift is observable without mutating the registered snapshot", () => {
  const cortex = makeRoot("m041-cortex-");
  const project = makeRoot("m041-project-");
  try {
    writeDescriptor(project, descriptor());
    registry.registerConnectedProject(cortex, project);
    const changed = descriptor();
    changed.repository.slug = "Other/axrail";
    writeDescriptor(project, changed);

    const current = registry.getConnectedProject(cortex, "project:axrail");
    assert.equal(current.drift.detected, true);
    assert.equal(current.drift.repository_identity_changed, true);

    const topo = topology.readTopology(cortex);
    assert.equal(topo.peers[0].connected_project.repository_slug, "Kucell/axrail");
  } finally {
    fs.rmSync(cortex, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("unregister is idempotent", () => {
  const cortex = makeRoot("m041-cortex-");
  const project = makeRoot("m041-project-");
  try {
    writeDescriptor(project, descriptor());
    registry.registerConnectedProject(cortex, project);
    assert.equal(registry.unregisterConnectedProject(cortex, "project:axrail").removed, true);
    assert.equal(registry.unregisterConnectedProject(cortex, "axrail").idempotent, true);
  } finally {
    fs.rmSync(cortex, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("connected project health producer reports descriptor drift as degraded", async () => {
  const cortex = makeRoot("m041-cortex-");
  const project = makeRoot("m041-project-");
  try {
    writeDescriptor(project, descriptor());
    registry.registerConnectedProject(cortex, project);
    const changed = descriptor();
    changed.validation.profiles[0].purpose = "changed";
    writeDescriptor(project, changed);

    const producer = registry.createConnectedProjectHealthProducer(cortex);
    const components = await producer.produce({ now: "2026-09-30T02:30:00.000Z" });
    assert.equal(components.length, 1);
    assert.equal(components[0].kind, "project");
    assert.equal(components[0].status, "degraded");

    const health = protocol.normalizePlatformHealth({
      generated_at: "2026-09-30T02:30:00.000Z",
      components,
    });
    assert.equal(health.overall, "degraded");
  } finally {
    fs.rmSync(cortex, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});
