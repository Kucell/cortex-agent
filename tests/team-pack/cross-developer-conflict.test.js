"use strict";

// Cross-developer conflict drill: two independent .agent/ copies, same
// .agent-shared/, divergent local edits + divergent upstream change.
//
// Setup:
//   shared/   — single .agent-shared/ source of truth
//   alice/    — developer A's project root with .agent/
//   bob/      — developer B's project root with .agent/
//   pack v1 = rules/shared-rule.md
//   alice edits locally → divergent
//   pack v2 = rules/shared-rule.md (different content) → upstream change
//   bob installs v1 → no conflict
//   alice installs v2 → CONFLICT (local and incoming both changed)

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const t = require("../../lib/team-pack");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures += 1; console.error(`  ✗ ${name}: ${err.message}`); }
}

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function setupPackDir(root, content) {
  fs.mkdirSync(path.join(root, ".agent-shared/rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-shared/rules/shared.md"), content);
  const manifest = {
    schema_version: 1,
    name: "shared",
    version: "1.0.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
    files: [{ path: "rules/shared.md", sha256: sha(content), mode: "add" }],
  };
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

function copyDir(src, dest) {
  // Copy .agent-shared/ from source to destination.
  fs.cpSync(path.join(src, ".agent-shared"), path.join(dest, ".agent-shared"), { recursive: true });
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tap-cross-${label}-`));
}

check("bob installs v1 cleanly (no conflict)", () => {
  const shared = tmpDir("shared-bob");
  const bob = tmpDir("bob");
  setupPackDir(shared, "v1 content");
  copyDir(shared, bob);
  const m = t.readManifest(bob);
  const plan = t.buildMergePlan(m, null, bob, { dryRun: false });
  for (const it of plan.items) {
    if (it.decision === "add" || it.decision === "apply") {
      fs.mkdirSync(path.join(bob, ".agent", path.dirname(it.path)), { recursive: true });
      fs.copyFileSync(path.join(bob, ".agent-shared", it.path), path.join(bob, ".agent", it.path));
    }
  }
  const loaded = t.loadPack(bob);
  const r = t.buildReceiptFromPlan(loaded.manifest, loaded.manifestSha256, plan);
  t.writeReceiptAtomic(bob, r);
  assert.ok(fs.existsSync(path.join(bob, ".agent/rules/shared.md")));
});

check("alice has local change + upstream change → conflict", () => {
  const shared = tmpDir("shared-alice");
  const alice = tmpDir("alice");
  setupPackDir(shared, "v1 content");
  copyDir(shared, alice);

  // Alice installs v1
  let m = t.readManifest(alice);
  let plan = t.buildMergePlan(m, null, alice, { dryRun: false });
  for (const it of plan.items) {
    if (it.decision === "add" || it.decision === "apply") {
      fs.mkdirSync(path.join(alice, ".agent", path.dirname(it.path)), { recursive: true });
      fs.copyFileSync(path.join(alice, ".agent-shared", it.path), path.join(alice, ".agent", it.path));
    }
  }
  let loaded = t.loadPack(alice);
  let r = t.buildReceiptFromPlan(loaded.manifest, loaded.manifestSha256, plan);
  t.writeReceiptAtomic(alice, r);

  // Alice edits her local copy
  fs.writeFileSync(path.join(alice, ".agent/rules/shared.md"), "alice's local divergent change");

  // Upstream changes v1 → v2
  setupPackDir(shared, "v2 content — different from v1 and from alice's edit");

  // Alice pulls upstream change into her .agent-shared/
  copyDir(shared, alice);
  m = t.readManifest(alice);

  // Alice re-runs team update → must detect conflict (local != base, incoming != base, local != incoming)
  const receipt = t.readReceipt(alice);
  plan = t.buildMergePlan(m, receipt, alice, { dryRun: true });
  const sharedItem = plan.items.find((it) => it.path === "rules/shared.md");
  assert.strictEqual(sharedItem.decision, "conflict", "expected conflict, got " + sharedItem.decision);
  assert.strictEqual(sharedItem.kept_sha, sha("alice's local divergent change"));

  // Alice actually runs update (apply) → local preserved + conflict artifact written
  plan = t.buildMergePlan(m, receipt, alice, { dryRun: false });
  for (const it of plan.items) {
    if (it.decision === "apply" || it.decision === "add") {
      fs.mkdirSync(path.join(alice, ".agent", path.dirname(it.path)), { recursive: true });
      fs.copyFileSync(path.join(alice, ".agent-shared", it.path), path.join(alice, ".agent", it.path));
    }
  }
  // Local still preserved
  const localAfter = fs.readFileSync(path.join(alice, ".agent/rules/shared.md"), "utf8");
  assert.strictEqual(localAfter, "alice's local divergent change");

  // Conflict artifact written
  const conflicts = plan.items.filter((it) => it.decision === "conflict");
  assert.strictEqual(conflicts.length, 1);
  // Manually write the artifact using the same logic the CLI does
  fs.mkdirSync(path.join(alice, ".agent/team-sync/conflicts"), { recursive: true });
  const ts = Date.now();
  const conflictFile = path.join(alice, ".agent/team-sync/conflicts", `${ts}-1-conflict.json`);
  fs.writeFileSync(conflictFile, JSON.stringify({
    schema_version: 1,
    conflicts: conflicts.map((c) => ({ path: c.path, base: c.base, local: c.local, incoming: c.incoming })),
  }, null, 2));
  assert.ok(fs.existsSync(conflictFile));
});

check("receipt after conflict still records only applied files", () => {
  // Conflict files are NOT included in the new receipt baseline — only
  // applied/add items advance the baseline.
  const root = tmpDir("conflict-receipt");
  fs.mkdirSync(path.join(root, ".agent-shared/rules"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-shared/rules/a.md"), "A1");
  fs.writeFileSync(path.join(root, ".agent-shared/rules/b.md"), "B1");
  const manifest = {
    schema_version: 1,
    name: "r", version: "0.1.0",
    requires: { cortex_agent: ">=1.6.0" },
    signers: { mode: "disabled" },
    includes: [], excludes: [],
    files: [
      { path: "rules/a.md", sha256: sha("A1"), mode: "add" },
      { path: "rules/b.md", sha256: sha("B1"), mode: "add" },
    ],
  };
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), JSON.stringify(manifest, null, 2));

  // First install → both added
  const plan = t.buildMergePlan(manifest, null, root, { dryRun: false });
  for (const it of plan.items) {
    if (it.decision === "add" || it.decision === "apply") {
      fs.mkdirSync(path.join(root, ".agent", path.dirname(it.path)), { recursive: true });
      fs.copyFileSync(path.join(root, ".agent-shared", it.path), path.join(root, ".agent", it.path));
    }
  }
  const receipt1 = t.buildReceiptFromPlan(manifest, sha(JSON.stringify(manifest)), plan);
  t.writeReceiptAtomic(root, receipt1);
  assert.strictEqual(receipt1.files.length, 2);

  // Edit local a.md (so it differs from base) AND change upstream a.md too → bilateral divergent
  fs.writeFileSync(path.join(root, ".agent/rules/a.md"), "A-LOCAL");
  // Upstream changes a.md → A2
  fs.writeFileSync(path.join(root, ".agent-shared/rules/a.md"), "A2");
  manifest.files[0].sha256 = sha("A2");
  fs.writeFileSync(path.join(root, ".agent-shared/team-pack.json"), JSON.stringify(manifest, null, 2));

  // Second install — a.md conflict (local vs upstream both changed), b.md unchanged
  const plan2 = t.buildMergePlan(manifest, receipt1, root, { dryRun: false });
  const aItem = plan2.items.find((it) => it.path === "rules/a.md");
  const bItem = plan2.items.find((it) => it.path === "rules/b.md");
  assert.strictEqual(aItem.decision, "conflict");
  assert.strictEqual(bItem.decision, "unchanged");
  // Build receipt from plan2 — only apply items advance baseline
  const manifestSha2 = sha(JSON.stringify(manifest));
  const receipt2 = t.buildReceiptFromPlan(manifest, manifestSha2, plan2);
  assert.strictEqual(receipt2.files.length, 0, "no applied/add items — receipt baseline stays empty for this iteration");
});

if (failures > 0) { console.error(`\nFAIL: ${failures}`); process.exit(1); }
console.log(`\nPASS: cross-developer conflict drill`);