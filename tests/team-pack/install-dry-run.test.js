"use strict";

// dry-run / no-team-pack / install path integration tests for team-pack.
// Run with: `node tests/team-pack/install-dry-run.test.js`

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const t = require("../../lib/team-pack");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tap-dry-${label}-`));
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function writeManifest(root, files) {
  fs.mkdirSync(path.join(root, ".agent-shared/rules"), { recursive: true });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, ".agent-shared", f.path)), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-shared", f.path), f.content);
  }
  const manifest = {
    schema_version: 1,
    name: "dry-run-test",
    version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: ["rules/**/*.md"],
    excludes: [],
    files: files.map((f) => ({ path: f.path, sha256: sha(f.content), mode: f.mode || "add" })),
  };
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ─── dry-run must not write ──────────────────────────────────────────────────
check("dry-run buildMergePlan produces plan without writing", () => {
  const root = tmpDir("dry1");
  const m = writeManifest(root, [{ path: "rules/x.md", content: "X" }]);
  const before = fs.readdirSync(root);
  const plan = t.buildMergePlan(m, null, root, { dryRun: true });
  assert.strictEqual(plan.mode, "dry-run");
  // No `.agent/` written
  assert.ok(!fs.existsSync(path.join(root, ".agent")));
  // Top-level unchanged
  const after = fs.readdirSync(root);
  assert.deepStrictEqual(before, after);
});

// ─── cold-start install writes receipt ──────────────────────────────────────
check("install path (apply) writes receipt + .agent/ files", () => {
  const root = tmpDir("install1");
  const m = writeManifest(root, [{ path: "rules/x.md", content: "X" }]);
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  const plan = t.buildMergePlan(m, null, root, { dryRun: false });
  // Apply items manually (CLI layer will do this; here we exercise the
  // receipt + writeReceiptAtomic plumbing directly).
  for (const it of plan.items) {
    if (it.decision !== "apply" && it.decision !== "add") continue;
    const src = path.join(root, ".agent-shared", it.path);
    const dest = path.join(root, ".agent", it.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  const manifestSha256 = sha(JSON.stringify(m));
  const receipt = t.buildReceiptFromPlan(m, manifestSha256, plan);
  t.writeReceiptAtomic(root, receipt);
  // Verify
  assert.ok(fs.existsSync(path.join(root, ".agent/rules/x.md")));
  const r = JSON.parse(fs.readFileSync(t.receiptFile(root), "utf8"));
  assert.strictEqual(r.pack.name, "dry-run-test");
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].status, "installed");
});

// ─── legacy no-team-pack ────────────────────────────────────────────────────
check("legacy project without .agent-shared returns null manifest", () => {
  const root = tmpDir("legacy");
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent/.platforms"), "{}");
  assert.strictEqual(t.readManifest(root), null);
  // Plan on missing manifest: loadPack rejects
  const r = t.loadPack(root);
  assert.strictEqual(r.ok, false);
});

// ─── receipt atomic rename ──────────────────────────────────────────────────
check("writeReceiptAtomic uses temp file + rename", () => {
  const root = tmpDir("receipt");
  const m = writeManifest(root, [{ path: "rules/x.md", content: "X" }]);
  fs.mkdirSync(path.join(root, ".agent/team-sync"), { recursive: true });
  const receipt = t.emptyReceipt({ name: m.name, version: m.version, manifest_sha256: "x" });
  t.writeReceiptAtomic(root, receipt);
  // No stray tmp files left behind
  const entries = fs.readdirSync(path.join(root, ".agent/team-sync"));
  assert.deepStrictEqual(entries, [".team-receipt.json"]);
});

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s)`);
  process.exit(1);
}
console.log(`\nPASS: install/dry-run/no-team-pack`);