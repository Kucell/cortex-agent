"use strict";

// Coverage for P-002 Team Pack manifest v2 file-level project scope:
// v1/v2 dual validators, projects in canonical hash + fingerprint,
// global / project_intersection / project_miss selection with receipt
// evidence, duplicate-target conflict and scoped safety scans.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const t = require("../../lib/team-pack/index.js");

const FAKE_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const FAKE_SHA2 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function makePack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tp-scope-"));
  fs.mkdirSync(path.join(root, ".agent-shared", "references", "learnings"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent", "team-sync"), { recursive: true });
  return root;
}

function writeFile(root, rel, content) {
  const abs = path.join(root, ".agent-shared", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return t.hashBuffer(Buffer.from(content, "utf8"));
}

function v2Manifest(overrides = {}) {
  return {
    schema_version: 2,
    name: "scope-pack",
    version: "1.2.0",
    requires: { cortex_agent: ">=1.14.0" },
    signers: { mode: "git_committers", allowed_committers: [], fallback: "warn" },
    files: [
      { path: "references/learnings/team-general.md", sha256: FAKE_SHA, mode: "merge" },
      { path: "references/learnings/hai-inference/retry.md", sha256: FAKE_SHA2, mode: "merge", projects: ["hai-inference"] },
    ],
    ...overrides,
  };
}

describe("team-pack — manifest v2", () => {
  test("v1 manifest still reads and validates", () => {
    const root = makePack();
    const sha = writeFile(root, "references/learnings/team-general.md", "hello");
    const manifest = v2Manifest({ schema_version: 1, files: [{ path: "references/learnings/team-general.md", sha256: sha, mode: "merge" }] });
    const file = path.join(root, ".agent-shared", "team-pack.json");
    fs.writeFileSync(file, JSON.stringify(manifest));
    const read = t.readManifest(root);
    assert.equal(read.schema_version, 1);
    assert.deepEqual(t.validateManifestShape(read, root), []);
  });

  test("v1 manifest with projects is rejected", () => {
    const root = makePack();
    const manifest = v2Manifest({ schema_version: 1 });
    const errors = t.validateManifestShape(manifest, root);
    assert.ok(errors.some((e) => e.includes("projects requires schema_version=2")));
  });

  test("v2 manifest reads with optional file projects", () => {
    const root = makePack();
    const file = path.join(root, ".agent-shared", "team-pack.json");
    fs.writeFileSync(file, JSON.stringify(v2Manifest()));
    const read = t.readManifest(root);
    assert.equal(read.schema_version, 2);
    assert.ok(t.hasProjectScopedFiles(read));
  });

  test("v2 with invalid project id is invalid", () => {
    const root = makePack();
    const bad = v2Manifest({ files: [
      { path: "references/learnings/a.md", sha256: FAKE_SHA, mode: "merge", projects: ["bad_id"] },
    ] });
    assert.notEqual(t.validateFileProjectsField(bad.files[0].projects).length, 0);
  });

  test("fingerprint changes when projects change", () => {
    const global = [{ path: "a.md", sha256: FAKE_SHA, mode: "merge" }];
    const scoped = [{ path: "a.md", sha256: FAKE_SHA, mode: "merge", projects: ["p1"] }];
    assert.notEqual(t.manifestFingerprint(global), t.manifestFingerprint(scoped));
    assert.equal(t.manifestFingerprint(global), t.manifestFingerprint([{ path: "a.md", sha256: FAKE_SHA, mode: "merge", projects: [] }]));
  });

  test("canonical pack hash includes projects", () => {
    const root = makePack();
    const shaG = writeFile(root, "references/learnings/team-general.md", "general");
    const shaS = writeFile(root, "references/learnings/hai-inference/retry.md", "retry");
    const file = path.join(root, ".agent-shared", "team-pack.json");
    const withProjects = v2Manifest({ files: [
      { path: "references/learnings/team-general.md", sha256: shaG, mode: "merge" },
      { path: "references/learnings/hai-inference/retry.md", sha256: shaS, mode: "merge", projects: ["hai-inference"] },
    ] });
    fs.writeFileSync(file, JSON.stringify(withProjects));
    const loaded1 = t.loadPack(root);
    assert.equal(loaded1.ok, true);
    const without = v2Manifest({ files: [
      { path: "references/learnings/team-general.md", sha256: shaG, mode: "merge" },
      { path: "references/learnings/hai-inference/retry.md", sha256: shaS, mode: "merge" },
    ] });
    fs.writeFileSync(file, JSON.stringify(without));
    const loaded2 = t.loadPack(root);
    assert.equal(loaded2.ok, true);
    assert.notEqual(loaded1.manifestSha256, loaded2.manifestSha256);
  });
});

describe("team-pack — selection and receipt", () => {
  test("selectFileForAgent: global / intersection / miss", () => {
    assert.deepEqual(t.selectFileForAgent({ projects: undefined }, ["p1"]), { selected: true, reason: "global", matched: [] });
    assert.deepEqual(t.selectFileForAgent({ projects: [] }, ["p1"]), { selected: true, reason: "global", matched: [] });
    const hit = t.selectFileForAgent({ projects: ["p1", "p2"] }, ["p2"]);
    assert.equal(hit.selected, true);
    assert.equal(hit.reason, "project_intersection");
    const miss = t.selectFileForAgent({ projects: ["p1"] }, ["p9"]);
    assert.equal(miss.selected, false);
    assert.equal(miss.reason, "project_miss");
  });

  test("buildMergePlan fails closed without --agent when scoped files exist", () => {
    const root = makePack();
    writeFile(root, "references/learnings/team-general.md", "hello");
    writeFile(root, "references/learnings/hai-inference/retry.md", "world");
    const file = path.join(root, ".agent-shared", "team-pack.json");
    fs.writeFileSync(file, JSON.stringify(v2Manifest()));
    const manifest = t.readManifest(root);
    assert.throws(() => t.buildMergePlan(manifest, null, root, {}), { code: "ERR_AGENT_SELECTION_REQUIRED" });
  });

  test("plan selects global + intersection, skips project_miss with evidence", () => {
    const root = makePack();
    writeFile(root, "references/learnings/team-general.md", "hello");
    writeFile(root, "references/learnings/hai-inference/retry.md", "world");
    const file = path.join(root, ".agent-shared", "team-pack.json");
    fs.writeFileSync(file, JSON.stringify(v2Manifest()));
    const manifest = t.readManifest(root);
    const plan = t.buildMergePlan(manifest, null, root, { selection: { agentId: "a1", agentProjects: ["hai-inference"] } });
    const byPath = Object.fromEntries(plan.items.map((it) => [it.path, it]));
    assert.equal(byPath["references/learnings/team-general.md"].selected, true);
    assert.equal(byPath["references/learnings/team-general.md"].selection_reason, "global");
    assert.equal(byPath["references/learnings/hai-inference/retry.md"].selected, true);
    assert.equal(byPath["references/learnings/hai-inference/retry.md"].selection_reason, "project_intersection");
    assert.equal(plan.selection_evidence.length, 2);
    // miss: agent without the project
    const plan2 = t.buildMergePlan(manifest, null, root, { selection: { agentId: "b1", agentProjects: ["billing-platform"] } });
    const missItem = plan2.items.find((it) => it.path === "references/learnings/hai-inference/retry.md");
    assert.equal(missItem.decision, "skip");
    assert.equal(missItem.reason, "project_miss");
    const evidence = plan2.selection_evidence.find((e) => e.path === "references/learnings/hai-inference/retry.md");
    assert.equal(evidence.selected, false);
    assert.equal(evidence.reason, "project_miss");
    assert.equal(evidence.installed_sha256, null);
  });

  test("receipt records selection evidence", () => {
    const root = makePack();
    writeFile(root, "references/learnings/team-general.md", "hello");
    writeFile(root, "references/learnings/hai-inference/retry.md", "world");
    const file = path.join(root, ".agent-shared", "team-pack.json");
    fs.writeFileSync(file, JSON.stringify(v2Manifest()));
    const manifest = t.readManifest(root);
    const plan = t.buildMergePlan(manifest, null, root, { selection: { agentId: "a1", agentProjects: ["hai-inference"] } });
    const receipt = t.buildReceiptFromPlan(manifest, "sha", plan, null);
    assert.ok(Array.isArray(receipt.selection_evidence));
    assert.equal(receipt.selection_evidence.length, 2);
    assert.ok(receipt.selection_evidence.every((row) => row.path && row.selected !== undefined && row.reason));
  });

  test("duplicate target paths fail before writes", () => {
    const root = makePack();
    writeFile(root, "references/learnings/a.md", "a");
    const dup = v2Manifest({ files: [
      { path: "references/learnings/a.md", sha256: FAKE_SHA, mode: "merge" },
      { path: "references/learnings/a.md", sha256: FAKE_SHA2, mode: "merge" },
    ] });
    const file = path.join(root, ".agent-shared", "team-pack.json");
    fs.writeFileSync(file, JSON.stringify(dup));
    const manifest = t.readManifest(root);
    assert.throws(() => t.buildMergePlan(manifest, null, root, { selection: { agentId: "a1", agentProjects: [] } }), { code: "ERR_TEAM_PACK_DUPLICATE_TARGET" });
  });

  test("scoped entries receive the same safety scans", () => {
    const root = makePack();
    writeFile(root, "references/learnings/team-general.md", "hello");
    const secretPath = path.join(root, ".agent-shared", "references", "learnings", "hai-inference", "retry.md");
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, 'password = "hunter2hunter2"', "utf8");
    const scopedSha = t.hashFile(secretPath);
    const manifest = v2Manifest({ files: [
      { path: "references/learnings/team-general.md", sha256: FAKE_SHA, mode: "merge" },
      { path: "references/learnings/hai-inference/retry.md", sha256: scopedSha, mode: "merge", projects: ["hai-inference"] },
    ]});
    const report = t.verifyChecks(manifest, root);
    assert.ok(report.checks.some((c) => c.id === "secret_scan" && c.status === "fail"));
    assert.equal(report.ok, false);
  });
});
