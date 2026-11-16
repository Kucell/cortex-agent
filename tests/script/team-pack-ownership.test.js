"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const team = require("../../lib/team-pack");
const scripts = require("../../lib/script/manifest");
const { verifiedTeamFiles } = scripts;
const { testRuntime } = require("../helpers/runtime-sandbox");
const { buildAppliedUpdateReport, buildDryRunUpdateReport } = require("../../lib/commands/update/report");
const rel = "skills/example/scripts/index.js";

function fixture(t) {
  const runtime = testRuntime("team-ownership");
  fs.mkdirSync(runtime, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtime, "consumer-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const template = path.join(root, "provider/templates/en");
  put(path.join(template, ".agent", rel), "// framework implementation\n");
  put(path.join(root, ".agent", rel), "// project team implementation\n");
  team.initSkeleton(root, "example-team");
  put(path.join(root, ".agent-shared", rel), "// project team implementation\n");
  const manifest = team.readManifest(root);
  manifest.files = [{ path: rel, sha256: team.hashFile(path.join(root, ".agent", rel)), mode: "add" }];
  put(team.manifestPath(root), JSON.stringify(manifest));
  const loaded = team.loadPack(root);
  assert.equal(loaded.ok, true);
  const receipt = { schema_version: 1, pack: { name: manifest.name, version: manifest.version, manifest_sha256: loaded.manifestSha256 },
    files: [{ path: rel, baseline_sha256: manifest.files[0].sha256, installed_sha256: manifest.files[0].sha256, status: "installed" }] };
  put(team.receiptFile(root), JSON.stringify(receipt));
  return { root, template, manifest, receipt, put, dest: path.join(root, ".agent", rel), source: path.join(root, ".agent-shared", rel) };
}

test("verified Team Pack ownership preserves L2 bytes even with force and never claims an L1 baseline", t => {
  const f = fixture(t), original = fs.readFileSync(f.dest);
  assert.deepEqual([...verifiedTeamFiles(f.root)], [rel]);
  for (const force of [false, true]) {
    const result = scripts.reconcileScripts({ cwd: f.root, templateDir: f.template, lang: "en", apply: true, force });
    assert.deepEqual(result.applied, []);
    assert.ok(result.skipped.some(x => x.path === rel && x.reason === "team_pack_managed"));
    assert.deepEqual(fs.readFileSync(f.dest), original);
  }
  const ledger = scripts.ensureManifestForInit(f.root, f.template, "en");
  assert.equal(ledger.scripts[rel], undefined);
});

for (const drift of ["receipt-digest", "receipt-installed-hash", "receipt-baseline", "receipt-status", "pack-source", "local-bytes", "duplicate-receipt", "missing-receipt", "missing-pack", "pack-version"]) {
  test(`unverified ${drift} stays protected instead of being declared team-managed`, t => {
    const f = fixture(t);
    if (drift === "receipt-digest") f.receipt.pack.manifest_sha256 = "0".repeat(64);
    if (drift === "receipt-installed-hash") f.receipt.files[0].installed_sha256 = "0".repeat(64);
    if (drift === "receipt-baseline") f.receipt.files[0].baseline_sha256 = "0".repeat(64);
    if (drift === "receipt-status") f.receipt.files[0].status = "conflict";
    if (drift === "pack-source") fs.appendFileSync(f.source, "// source drift\n");
    if (drift === "local-bytes") fs.appendFileSync(f.dest, "// local drift\n");
    if (drift === "duplicate-receipt") f.receipt.files.push({ ...f.receipt.files[0] });
    if (drift === "pack-version") f.receipt.pack.version = "other-version";
    f.put(team.receiptFile(f.root), JSON.stringify(f.receipt));
    if (drift === "missing-receipt") fs.unlinkSync(team.receiptFile(f.root));
    if (drift === "missing-pack") fs.unlinkSync(team.manifestPath(f.root));
    const before = fs.readFileSync(f.dest);
    assert.equal(verifiedTeamFiles(f.root).size, 0);
    const result = scripts.reconcileScripts({ cwd: f.root, templateDir: f.template, lang: "en", apply: true });
    assert.deepEqual(result.applied, []);
    assert.ok(result.skipped.some(x => x.path === rel && x.reason === "unmanaged_cold_start"));
    assert.deepEqual(fs.readFileSync(f.dest), before);
  });
}

test("ownership evidence cannot follow pack, receipt or installed file links", { skip: process.platform === "win32" }, t => {
  for (const field of ["source", "receipt", "dest"]) {
    const f = fixture(t), target = field === "receipt" ? team.receiptFile(f.root) : f[field];
    const outside = path.join(f.root, "outside-data");
    fs.renameSync(target, outside);
    fs.symlinkSync(outside, target);
    assert.equal(verifiedTeamFiles(f.root).size, 0);
  }
});

test("upgrade reports identify preserved L2 files without calling them blockers or applied updates", t => {
  const f = fixture(t);
  const skipped = [{ path: rel, reason: "team_pack_managed" }];
  const ctx = { cwd: f.root, templateDir: f.template, lang: "en", command: "update", options: {} };
  const dry = buildDryRunUpdateReport(ctx, { agentDest: path.join(f.root, ".agent"), wouldAdd: [], scriptCandidates: [], teamManagedScripts: skipped, skippedChecks: [] });
  assert.deepEqual(dry.changes.preserved.map(x => [x.path, x.layer, x.action]), [[".agent/" + rel, "L2", "preserve"]]);
  assert.deepEqual(dry.changes.protected, []);
  const applied = buildAppliedUpdateReport(ctx, { updateId: "test", startedAt: "test", agentDest: path.join(f.root, ".agent"), added: [],
    reconcileReport: { applied: [], skipped, failed: [] }, semanticMergePlan: [], verification: { verification: [], summary: { failed: 0, skipped: 0 } }, status: "passed" });
  assert.equal(applied.status, "passed");
  assert.equal(applied.summary.protected, 0);
  assert.equal(applied.changes.preserved[0].reason, "team_pack_managed");
});
