"use strict";

// Merge matrix: every cell of base/local/incoming that buildMergePlan should
// classify deterministically. The fixture is rebuilt per case to keep the
// test hermetic.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const t = require("../../lib/team-pack/index.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tap-merge-${label}-`));
  return dir;
}

function sha(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function writePack(root, files) {
  fs.mkdirSync(path.join(root, ".agent-shared", "rules"), { recursive: true });
  const entries = files.map((f) => {
    fs.mkdirSync(path.dirname(path.join(root, ".agent-shared", f.path)), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent-shared", f.path), f.content);
    return { path: f.path, sha256: sha(f.content), mode: f.mode || "add" };
  });
  const manifest = {
    schema_version: 1,
    name: "merge-test",
    version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: ["rules/**/*.md"],
    excludes: [],
    files: entries,
  };
  fs.writeFileSync(path.join(root, ".agent-shared", "team-pack.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function writeLocal(root, files) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, ".agent", f.path)), { recursive: true });
    fs.writeFileSync(path.join(root, ".agent", f.path), f.content);
  }
}

function writeReceipt(root, manifest, baseByPath) {
  fs.mkdirSync(path.join(root, ".agent/team-sync"), { recursive: true });
  const receipt = {
    schema_version: 1,
    pack: { name: manifest.name, version: manifest.version, manifest_sha256: "x" },
    installed_at: new Date().toISOString(),
    manifest_schema_drift: null,
    files: manifest.files.map((f) => ({
      path: f.path,
      baseline_sha256: baseByPath[f.path] || f.sha256,
      installed_sha256: baseByPath[f.path] || f.sha256,
      status: "installed",
    })),
  };
  fs.writeFileSync(path.join(root, ".agent/team-sync/.team-receipt.json"), JSON.stringify(receipt, null, 2));
}

// ─── Cases ──────────────────────────────────────────────────────────────────
check("cold start (no receipt, no local) → add", () => {
  const root = tmpDir("cold");
  const m = writePack(root, [{ path: "rules/a.md", content: "AAA" }]);
  const plan = t.buildMergePlan(m, null, root, { dryRun: true });
  assert.strictEqual(plan.items[0].decision, "add");
});

check("base=local=incoming → unchanged", () => {
  const root = tmpDir("eq");
  const m = writePack(root, [{ path: "rules/a.md", content: "AAA" }]);
  writeLocal(root, [{ path: "rules/a.md", content: "AAA" }]);
  writeReceipt(root, m, { "rules/a.md": sha("AAA") });
  const plan = t.buildMergePlan(m, t.readReceipt(root), root, { dryRun: true });
  assert.strictEqual(plan.items[0].decision, "unchanged");
});

check("local unchanged, incoming changed → apply", () => {
  const root = tmpDir("incoming");
  const m = writePack(root, [{ path: "rules/a.md", content: "BBB" }]);
  writeLocal(root, [{ path: "rules/a.md", content: "AAA" }]);
  writeReceipt(root, m, { "rules/a.md": sha("AAA") });
  const plan = t.buildMergePlan(m, t.readReceipt(root), root, { dryRun: true });
  assert.strictEqual(plan.items[0].decision, "apply");
  assert.strictEqual(plan.items[0].kept_sha, sha("BBB"));
});

check("local changed, incoming unchanged → unchanged (keep local)", () => {
  const root = tmpDir("local");
  const m = writePack(root, [{ path: "rules/a.md", content: "AAA" }]);
  writeLocal(root, [{ path: "rules/a.md", content: "LOCAL" }]);
  writeReceipt(root, m, { "rules/a.md": sha("AAA") });
  const plan = t.buildMergePlan(m, t.readReceipt(root), root, { dryRun: true });
  assert.strictEqual(plan.items[0].decision, "unchanged");
  assert.strictEqual(plan.items[0].kept_sha, null);
});

check("local + incoming changed identically → apply", () => {
  const root = tmpDir("bilateral-same");
  const m = writePack(root, [{ path: "rules/a.md", content: "BBB" }]);
  writeLocal(root, [{ path: "rules/a.md", content: "BBB" }]);
  writeReceipt(root, m, { "rules/a.md": sha("AAA") });
  const plan = t.buildMergePlan(m, t.readReceipt(root), root, { dryRun: true });
  assert.strictEqual(plan.items[0].decision, "apply");
});

check("local + incoming changed differently → conflict keeps local", () => {
  const root = tmpDir("conflict");
  const m = writePack(root, [{ path: "rules/a.md", content: "BBB" }]);
  writeLocal(root, [{ path: "rules/a.md", content: "LOCAL" }]);
  writeReceipt(root, m, { "rules/a.md": sha("AAA") });
  const plan = t.buildMergePlan(m, t.readReceipt(root), root, { dryRun: true });
  assert.strictEqual(plan.items[0].decision, "conflict");
  assert.strictEqual(plan.items[0].kept_sha, sha("LOCAL"));
});

check("manifest invalid (no schema_version) → loadPack returns ok=false", () => {
  const root = tmpDir("invalid");
  fs.mkdirSync(path.join(root, ".agent-shared"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), '{"name":"x","version":"0.1.0","files":[]}');
  const r = t.loadPack(root);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "manifest_invalid_or_missing");
});

if (failures > 0) {
  console.error(`\nFAIL: ${failures} check(s)`);
  process.exit(1);
}
console.log(`\nPASS: merge matrix`);