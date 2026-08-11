"use strict";

// ─── P-001 Topology Registry Tests ─────────────────────────────────────────
// Covers: lib/topology/index.js (read/write/validate/register/deregister)
// Source: P-001 §4 验收 — 注册表读写 CLI 单元测试 (≥ 10 cases)

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const topology = require("../../lib/topology");

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topology-test-"));
}

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

const validPeer = {
  project_id: "SamHMI",
  host_root: "/Users/workspace/code/HMI/SamHMI",
  primary_branch: "main",
  roles: ["desktop", "consumer"],
  capabilities: ["coordination", "bridge-consumer"],
  topology_ref: "SamHMI@main",
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("P-001 Topology Registry", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  // 1. readTopology returns default when file missing
  test("readTopology returns default self when projects.json missing", () => {
    const result = topology.readTopology(tmpDir);
    assert.equal(result.self.project_id, "cortex-agent");
    assert.equal(result.self.primary_branch, "main");
    assert.deepEqual(result.peers, []);
  });

  // 2. writeTopology creates file atomically
  test("writeTopology creates projects.json with schema_version", () => {
    const data = {
      self: { project_id: "cortex-agent", host_root: tmpDir, primary_branch: "main" },
      peers: [],
    };
    const result = topology.writeTopology(tmpDir, data);
    assert.equal(result.ok, true);
    assert.equal(result.topology.schema_version, "1.0");

    const filePath = topology.topologyPath(tmpDir);
    assert.ok(fs.existsSync(filePath));
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(parsed.schema_version, "1.0");
  });

  // 3. registerPeer appends a valid peer
  test("registerPeer appends a valid peer", () => {
    const result = topology.registerPeer(tmpDir, validPeer);
    assert.equal(result.ok, true);
    assert.equal(result.topology.peers.length, 1);
    assert.equal(result.topology.peers[0].project_id, "SamHMI");
  });

  // 4. registerPeer rejects duplicate project_id
  test("registerPeer rejects duplicate project_id", () => {
    topology.registerPeer(tmpDir, validPeer);
    const result = topology.registerPeer(tmpDir, validPeer);
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes("already registered"));
  });

  // 5. registerPeer validates required fields
  test("registerPeer rejects peer missing project_id", () => {
    const result = topology.registerPeer(tmpDir, { host_root: "/some/path" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  // 6. registerPeer validates required fields
  test("registerPeer rejects peer missing host_root", () => {
    const result = topology.registerPeer(tmpDir, { project_id: "TestProject" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  // 7. deregisterPeer removes existing peer
  test("deregisterPeer removes existing peer", () => {
    topology.registerPeer(tmpDir, validPeer);
    const result = topology.deregisterPeer(tmpDir, "SamHMI");
    assert.equal(result.ok, true);
    assert.equal(result.removed.project_id, "SamHMI");
    assert.equal(result.topology.peers.length, 0);
  });

  // 8. deregisterPeer returns error for non-existent peer
  test("deregisterPeer returns error for non-existent peer", () => {
    const result = topology.deregisterPeer(tmpDir, "NonExistent");
    assert.equal(result.ok, false);
    assert.ok(result.errors[0].includes("not found"));
  });

  // 9. findPeer locates peer by project_id
  test("findPeer locates peer by project_id", () => {
    topology.registerPeer(tmpDir, validPeer);
    const topo = topology.readTopology(tmpDir);
    const peer = topology.findPeer(topo, "SamHMI");
    assert.ok(peer);
    assert.equal(peer.project_id, "SamHMI");
    assert.equal(peer.host_root, "/Users/workspace/code/HMI/SamHMI");
  });

  // 10. findPeer returns null for unknown project_id
  test("findPeer returns null for unknown project_id", () => {
    const topo = topology.readTopology(tmpDir);
    const peer = topology.findPeer(topo, "Unknown");
    assert.equal(peer, null);
  });

  // 11. resolveTopologyRef resolves "project@branch" format
  test("resolveTopologyRef resolves project@branch format", () => {
    topology.registerPeer(tmpDir, validPeer);
    const topo = topology.readTopology(tmpDir);
    const peer = topology.resolveTopologyRef(topo, "SamHMI@main");
    assert.ok(peer);
    assert.equal(peer.project_id, "SamHMI");
  });

  // 12. resolveTopologyRef resolves plain project_id (no @)
  test("resolveTopologyRef resolves plain project_id without @", () => {
    topology.registerPeer(tmpDir, validPeer);
    const topo = topology.readTopology(tmpDir);
    const peer = topology.resolveTopologyRef(topo, "SamHMI");
    assert.ok(peer);
    assert.equal(peer.project_id, "SamHMI");
  });

  // 13. resolveTopologyRef returns null for unknown ref
  test("resolveTopologyRef returns null for unknown ref", () => {
    const topo = topology.readTopology(tmpDir);
    const peer = topology.resolveTopologyRef(topo, "Unknown@main");
    assert.equal(peer, null);
  });

  // 14. validateTopology rejects invalid data
  test("validateTopology rejects missing self", () => {
    const result = topology.validateTopology({ peers: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("self")));
  });

  // 15. validateTopology rejects duplicate project_id in peers
  test("validateTopology rejects duplicate project_id in peers", () => {
    const result = topology.validateTopology({
      self: { project_id: "cortex-agent" },
      peers: [validPeer, { ...validPeer }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("duplicate")));
  });

  // 16. Multiple peers can be registered
  test("multiple peers can be registered and queried", () => {
    topology.registerPeer(tmpDir, validPeer);
    topology.registerPeer(tmpDir, {
      project_id: "hmi-platform",
      host_root: "/Users/workspace/code/hmi-platform",
      primary_branch: "main",
      roles: ["backend"],
      capabilities: ["coordination", "bridge-consumer"],
    });
    const topo = topology.readTopology(tmpDir);
    assert.equal(topo.peers.length, 2);
    assert.ok(topology.findPeer(topo, "SamHMI"));
    assert.ok(topology.findPeer(topo, "hmi-platform"));
  });

  // 17. writeTopology rejects invalid topology
  test("writeTopology rejects invalid topology", () => {
    const result = topology.writeTopology(tmpDir, { peers: "not-an-array" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  // 18. 5+ peers can be registered (P-001 §4 acceptance)
  test("5+ peers can be registered and queried", () => {
    const projects = ["A", "B", "C", "D", "E"];
    for (const id of projects) {
      topology.registerPeer(tmpDir, { project_id: id, host_root: `/path/${id}` });
    }
    const topo = topology.readTopology(tmpDir);
    assert.equal(topo.peers.length, 5);
    for (const id of projects) {
      assert.ok(topology.findPeer(topo, id), `peer ${id} should exist`);
    }
  });

  // 19. Same role can be declared by multiple projects (P-001 §4)
  test("same role can be declared by multiple projects", () => {
    topology.registerPeer(tmpDir, { project_id: "P1", host_root: "/p1", roles: ["frontend"] });
    topology.registerPeer(tmpDir, { project_id: "P2", host_root: "/p2", roles: ["frontend"] });
    const topo = topology.readTopology(tmpDir);
    assert.equal(topo.peers.length, 2);
    const frontends = topo.peers.filter((p) => p.roles && p.roles.includes("frontend"));
    assert.equal(frontends.length, 2);
  });

  // 20. topologyPath returns correct path
  test("topologyPath returns .agent/topology/projects.json", () => {
    const result = topology.topologyPath(tmpDir);
    assert.ok(result.endsWith(path.join(".agent", "topology", "projects.json")));
  });
});
