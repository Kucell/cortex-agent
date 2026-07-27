"use strict";

// SamHMI pilot: simulate a typical SamHMI team-pack scenario end-to-end.
// Build a temp directory containing .agent-shared/ with multiple rules,
// workflows, and references; then run install, update, publish, verify.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const t = require("../../lib/team-pack");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures += 1; console.error(`  ✗ ${name}: ${err.message}`); }
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tap-samhmi-${label}-`));
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function writePackFiles(root, files) {
  fs.mkdirSync(path.join(root, ".agent-shared/rules"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent-shared/workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent-shared/references"), { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, ".agent-shared", f.path)), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-shared", f.path), f.content);
  }
  const manifest = {
    schema_version: 1,
    name: "samhmi-pilot",
    version: "1.0.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: ["rules/**/*.md", "workflows/**/*.md", "references/**/*.md"],
    excludes: t.DEFAULT_EXCLUDES,
    files: files.map((f) => ({ path: f.path, sha256: sha(f.content), mode: f.mode || "add" })),
  };
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ─── End-to-end pilot ────────────────────────────────────────────────────────
check("SamHMI pilot: init → install → verify → update cycle", () => {
  const root = tmpDir("e2e");
  // 1. init
  const skel = t.initSkeleton(root, "samhmi-pilot");
  assert.ok(fs.existsSync(skel.manifest_path));

  // 2. populate the pack with realistic SamHMI-style content
  const files = [
    { path: "rules/agent-guard.md", content: "---\nname: agent-guard\n---\n# Agent Guard rule" },
    { path: "rules/git-discipline.md", content: "---\nname: git-discipline\n---\n# Git discipline" },
    { path: "workflows/sync-team.md", content: "---\nname: sync-team\n---\n# Sync team workflow" },
    { path: "references/decision-log.md", content: "# Decision log" },
  ];
  const m = writePackFiles(root, files);

  // 3. install (apply path)
  const receipt = t.readReceipt(root);
  assert.strictEqual(receipt, null);
  const plan = t.buildMergePlan(m, null, root, { dryRun: false });
  assert.strictEqual(plan.items.length, 4);
  // All four are "add" on cold start
  for (const it of plan.items) {
    assert.strictEqual(it.decision, "add", `expected add for ${it.path}, got ${it.decision}`);
  }

  // Apply plan
  for (const it of plan.items) {
    const src = path.join(root, ".agent-shared", it.path);
    const dest = path.join(root, ".agent", it.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  const loaded = t.loadPack(root);
  const finalReceipt = t.buildReceiptFromPlan(loaded.manifest, loaded.manifestSha256, plan);
  t.writeReceiptAtomic(root, finalReceipt);

  // 4. verify
  const verify = t.verifyChecks(loaded.manifest, root, { strict: true });
  assert.ok(verify.ok, "verify must pass in clean pilot: " + JSON.stringify(verify.checks.filter((c) => c.status === "fail")));

  // 5. developer tweak — local rule edit
  const tweaked = path.join(root, ".agent/rules/agent-guard.md");
  fs.writeFileSync(tweaked, "# Local tweak by developer\n");

  // 6. update — local change should be preserved, other files unchanged
  const receipt2 = t.readReceipt(root);
  const plan2 = t.buildMergePlan(m, receipt2, root, { dryRun: true });
  const agentGuard = plan2.items.find((it) => it.path === "rules/agent-guard.md");
  assert.strictEqual(agentGuard.decision, "unchanged", "local change must not be overwritten");

  // 7. publish a new file via the publishPack API
  fs.mkdirSync(path.join(root, "src/rules"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/rules/ci-fast.md"), "# CI fast");
  const pub = t.publishPack(root, [{ source: "src/rules/ci-fast.md", dest: "rules/ci-fast.md" }], {
    name: "samhmi-pilot",
    version: "1.0.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: loaded.manifest.signers,
    includes: loaded.manifest.includes,
    excludes: loaded.manifest.excludes,
  });
  assert.strictEqual(pub.ok, true);
  assert.strictEqual(pub.applied.length, 1);

  // 8. fresh verify — manifest now has 5 files
  const m2 = t.readManifest(root);
  assert.strictEqual(m2.files.length, 5);
  const v2 = t.verifyChecks(m2, root, { strict: true });
  assert.ok(v2.ok);
});

check("SamHMI pilot: signers rejects unknown committer (defense in depth)", () => {
  const root = tmpDir("signer");
  execSync("git init -q", { cwd: root });
  execSync("git config user.email stranger@example.com", { cwd: root });
  execSync("git config user.name Stranger", { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "# Pilot");
  execSync("git add -A && git -c commit.gpgsign=false commit -q -m initial", { cwd: root });

  fs.mkdirSync(path.join(root, ".agent-shared/rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-shared/rules/x.md"), "# X");
  const manifest = {
    schema_version: 1,
    name: "samhmi-signer",
    version: "1.0.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "git_committers", allowed_committers: ["alice@samhmi.example"], fallback: "reject" },
    includes: [], excludes: [],
    files: [{ path: "rules/x.md", sha256: sha("# X"), mode: "add" }],
  };
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), JSON.stringify(manifest, null, 2));

  const loaded = t.loadPack(root);
  assert.strictEqual(loaded.ok, true);
  const v = t.verifyStrict(loaded.manifest, root);
  const sig = v.checks.find((c) => c.id === "manifest_signature");
  assert.strictEqual(sig.status, "fail");
  assert.match(sig.reason, /committer_not_allowed/);
});

if (failures > 0) { console.error(`\nFAIL: ${failures}`); process.exit(1); }
console.log(`\nPASS: SamHMI pilot`);