"use strict";

// ─── proposal-share — export / import / verify round-trip tests ────────────
//
// Covers the T-H14 scenario: sharing a dual-repo joint proposal package
// (primary volume + peer volume + missions + topology + mirrored symlink)
// with absolute-path tokenization and symlink rebuilding.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "..", "..", ".agent", "scripts", "proposal-share.js");

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: "utf8", cwd: cwd || process.cwd() });
}

function mkRoot(name) { return fs.mkdtempSync(path.join(os.tmpdir(), name)); }

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

// Build a dual-repo fixture:
//   repo-a (primary)  — demo-var-cards package + M-dvc-001 mission + topology
//   repo-b (peer)     — same slug package with a symlink mirroring repo-a's D-001
function buildFixture(root) {
  const a = path.join(root, "repo-a");
  const b = path.join(root, "repo-b");
  const aPkg = path.join(a, ".agent", "plans", "proposals", "projects", "demo-var-cards");
  const bPkg = path.join(b, ".agent", "plans", "proposals", "projects", "demo-var-cards");
  // primary volume
  write(path.join(aPkg, "index.md"), [
    "---",
    "cross_project_peers:",
    "  - " + path.join(root, "repo-b"),
    "---",
    "# Demo Var Cards",
    "> 双仓联合提案：本目录是后台范围真源；移动端仓库 " + path.join(root, "repo-b") + "/.agent/plans/proposals/projects/demo-var-cards/ 是移动端范围真源。",
    "> 主仓根路径: " + path.join(root, "repo-a") + "/.agent/plans/proposals/projects/demo-var-cards",
    "",
  ].join("\n"));
  write(path.join(aPkg, "proposals", "P-001-demo-proposal.md"), "# P-001 领域模型与 API\n\n状态: approved → M-dvc-001。\n");
  write(path.join(aPkg, "decisions", "D-001-scope.md"), "# D-001 配置范围\n\nPeer 镜像: " + path.join(root, "repo-b") + "\n");
  write(path.join(aPkg, "references.md"), "# References\n");
  write(path.join(aPkg, "relations.md"), "# Relations\n\n移动端仓库: " + path.join(root, "repo-b") + "\n");
  // missions: M-dvc-001 references the proposal; M-other does not
  write(path.join(a, ".agent", "missions", "M-dvc-001", "mission-plan.md"), "# M-dvc-001\n\n执行 projects/demo-var-cards 的 P-001。\n");
  write(path.join(a, ".agent", "missions", "M-other", "mission-plan.md"), "# M-other\n\n无关任务，不应被打包。\n");
  write(path.join(a, ".agent", "topology", "projects.json"), JSON.stringify({
    schema_version: "1.0",
    self: { project_id: "repo-a", host_root: a, primary_branch: "master" },
    peers: [{ project_id: "repo-b", host_root: path.join(root, "repo-b"), primary_branch: "main", roles: ["mobile"] }],
  }, null, 2));
  // peer volume (mobile side)
  write(path.join(bPkg, "index.md"), "# Demo Var Cards (移动端)\n\n后台: " + a + "\n");
  write(path.join(bPkg, "proposals", "P-002-peer-proposal.md"), "# P-002 移动端卡片交互\n");
  write(path.join(bPkg, "relations.md"), "# Relations (mobile)\n\n后台仓库: " + a + "\n");
  write(path.join(bPkg, "decisions", "D-002-peer.md"), "# D-002 移动端决策\n");
  // symlink mirror: repo-b mirrors repo-a's shared decision
  fs.symlinkSync(path.join(aPkg, "decisions", "D-001-scope.md"), path.join(bPkg, "decisions", "D-001-scope.md"));
  return { root: root, a: a, b: b };
}

test("export packages primary + peer + missions + symlink, tokenizes paths", () => {
  const root = mkRoot("cortex-ps-test-");
  const fix = buildFixture(root);
  const out = path.join(root, "out");
  const res = run(["export", "--slug", "demo-var-cards", "--root", fix.a, "--out", out]);
  assert.equal(res.status, 0, res.stderr);
  const summary = JSON.parse(res.stdout);
  assert.equal(summary.ok, true);
  assert.equal(summary.slug, "demo-var-cards");
  // primary + peer volumes
  assert.equal(summary.volumes.length, 2);
  assert.deepEqual(summary.volumes.map(v => v.repo).sort(), ["repo-a", "repo-b"]);
  // missions: M-dvc-001 included, M-other excluded
  assert.ok(summary.missions.some(m => m.id === "M-dvc-001"));
  assert.ok(!summary.missions.some(m => m.id === "M-other"));
  // symlink detected
  assert.equal(summary.symlinks, 1);
  // tokens
  assert.ok(summary.path_rewrites.tokens.includes("@ROOT:repo-a@"));
  assert.ok(summary.path_rewrites.tokens.includes("@ROOT:repo-b@"));
  // archive exists
  assert.ok(fs.existsSync(summary.package));
  fs.rmSync(root, { recursive: true, force: true });
});

test("verify passes on an exported package", () => {
  const root = mkRoot("cortex-ps-test-");
  const fix = buildFixture(root);
  const out = path.join(root, "out");
  const exp = run(["export", "--slug", "demo-var-cards", "--root", fix.a, "--out", out]);
  assert.equal(exp.status, 0, exp.stderr);
  const pkg = JSON.parse(exp.stdout).package;
  const res = run(["verify", "--package", pkg, "--root", path.join(root, "vroot")]);
  const summary = JSON.parse(res.stdout);
  assert.equal(res.status, 0);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.volumes, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("import installs to standard paths, rewrites tokens, rebuilds symlink, stages peer", () => {
  const root = mkRoot("cortex-ps-test-");
  const fix = buildFixture(root);
  const out = path.join(root, "out");
  const exp = run(["export", "--slug", "demo-var-cards", "--root", fix.a, "--out", out]);
  assert.equal(exp.status, 0, exp.stderr);
  const pkg = JSON.parse(exp.stdout).package;
  const target = path.join(root, "target");
  const imp = run(["import", "--package", pkg, "--root", target]);
  assert.equal(imp.status, 0, imp.stderr);
  const summary = JSON.parse(imp.stdout);
  assert.equal(summary.ok, true);
  // primary at standard path with repo-a tokens rewritten to target root
  const primIndex = path.join(target, ".agent", "plans", "proposals", "projects", "demo-var-cards", "index.md");
  assert.ok(fs.existsSync(primIndex));
  const indexContent = fs.readFileSync(primIndex, "utf8");
  assert.ok(!indexContent.includes("@ROOT:repo-a@"));
  assert.ok(indexContent.includes(target));
  // missions installed
  assert.ok(fs.existsSync(path.join(target, ".agent", "missions", "M-dvc-001", "mission-plan.md")));
  // topology installed with host_root rewritten
  const topo = JSON.parse(fs.readFileSync(path.join(target, ".agent", "topology", "projects.json"), "utf8"));
  assert.equal(topo.self.host_root, target);
  // peer staged (unmapped)
  const stagedPeerIndex = path.join(target, ".agent", "plans", "proposals", "imports", "demo-var-cards", "peers", "repo-b", "proposals", "projects", "demo-var-cards", "index.md");
  assert.ok(fs.existsSync(stagedPeerIndex));
  // staged peer symlink rebuilt and pointing at the target primary
  const stagedLink = path.join(target, ".agent", "plans", "proposals", "imports", "demo-var-cards", "peers", "repo-b", "proposals", "projects", "demo-var-cards", "decisions", "D-001-scope.md");
  assert.ok(fs.lstatSync(stagedLink).isSymbolicLink());
  assert.ok(fs.readlinkSync(stagedLink).includes(target));
  fs.rmSync(root, { recursive: true, force: true });
});

test("import with --root-map merges peer into a real repo without deleting existing files", () => {
  const root = mkRoot("cortex-ps-test-");
  const fix = buildFixture(root);
  const out = path.join(root, "out");
  const exp = run(["export", "--slug", "demo-var-cards", "--root", fix.a, "--out", out]);
  assert.equal(exp.status, 0, exp.stderr);
  const pkg = JSON.parse(exp.stdout).package;
  // peer repo already exists with a marker file
  const peerHome = path.join(root, "peer-home");
  write(path.join(peerHome, "repo-b", ".agent", "keep-me.json"), "{\"keep\": true}\n");
  const target = path.join(root, "target");
  const imp = run(["import", "--package", pkg, "--root", target, "--root-map", "repo-b=" + peerHome + "/repo-b"]);
  assert.equal(imp.status, 0, imp.stderr);
  // pre-existing file survives
  assert.ok(fs.existsSync(path.join(peerHome, "repo-b", ".agent", "keep-me.json")));
  // peer proposals at the standard path
  const peerIndex = path.join(peerHome, "repo-b", ".agent", "plans", "proposals", "projects", "demo-var-cards", "index.md");
  assert.ok(fs.existsSync(peerIndex));
  // peer tokens resolved (repo-a token → target root)
  const peerContent = fs.readFileSync(peerIndex, "utf8");
  assert.ok(!peerContent.includes("@ROOT:repo-a@"));
  // peer symlink rebuilt inside the mapped repo
  const peerLink = path.join(peerHome, "repo-b", ".agent", "plans", "proposals", "projects", "demo-var-cards", "decisions", "D-001-scope.md");
  assert.ok(fs.lstatSync(peerLink).isSymbolicLink());
  fs.rmSync(root, { recursive: true, force: true });
});

test("import --dry-run prints a plan and writes nothing", () => {
  const root = mkRoot("cortex-ps-test-");
  const fix = buildFixture(root);
  const out = path.join(root, "out");
  const exp = run(["export", "--slug", "demo-var-cards", "--root", fix.a, "--out", out]);
  assert.equal(exp.status, 0, exp.stderr);
  const pkg = JSON.parse(exp.stdout).package;
  const target = path.join(root, "target");
  const res = run(["import", "--package", pkg, "--root", target, "--dry-run"]);
  assert.equal(res.status, 0, res.stderr);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.ok, true);
  // nothing was written
  assert.ok(!fs.existsSync(path.join(target, ".agent")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("export fails when the proposal package has no index.md", () => {
  const root = mkRoot("cortex-ps-test-");
  const a = path.join(root, "repo-a");
  write(path.join(a, ".agent", "plans", "proposals", "projects", "broken", "proposals", "P-001.md"), "# broken\n");
  const res = run(["export", "--slug", "broken", "--root", a, "--out", path.join(root, "out")]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /index\.md/);
  fs.rmSync(root, { recursive: true, force: true });
});

// vim: set ts=2 sw=2 et: