"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const team = require("../../lib/team-pack");
const { testRuntime } = require("../helpers/runtime-sandbox");
const { buildManagedScriptsMap } = require("../helpers/managed-scripts");
const ROOT = path.resolve(__dirname, "../..");
const rel = "skills/vcs-pr/scripts/index.js";

function fixture(t, withTeam = true) {
  const runtime = testRuntime("team-upgrade-cli");
  fs.mkdirSync(runtime, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtime, "consumer-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(root, ".agent", rel), "// verified project-specific implementation\n");
  put(path.join(root, ".agent/.cortex-version"), "1.15.7\n");
  put(path.join(root, ".agent/.script-manifest.json"), JSON.stringify({ schema_version: 1, scripts: buildManagedScriptsMap(ROOT) }));
  if (withTeam) {
    team.initSkeleton(root, "example-project-team");
    put(path.join(root, ".agent-shared", rel), "// verified project-specific implementation\n");
    const manifest = team.readManifest(root);
    const digest = team.hashFile(path.join(root, ".agent-shared", rel));
    manifest.files = [{ path: rel, sha256: digest, mode: "add" }];
    put(team.manifestPath(root), JSON.stringify(manifest));
    const loaded = team.loadPack(root);
    assert.equal(loaded.ok, true);
    team.writeReceiptAtomic(root, { schema_version: 1,
      pack: { name: manifest.name, version: manifest.version, manifest_sha256: loaded.manifestSha256 },
      files: [{ path: rel, baseline_sha256: digest, installed_sha256: digest, status: "installed" }] });
  }
  return root;
}

function run(root, args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "bin/cli.js"), "update", "--lang", "en", "--report", "json", ...args], {
    cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CORTEX_STATE_SYNC: "off" },
  });
  assert.equal(result.error, undefined);
  const report = args.includes("--dry-run") ? JSON.parse(result.stdout) : JSON.parse(fs.readFileSync(path.join(root, ".agent/updates/latest.json")));
  return { status: result.status, report };
}

test("public update completes L1 upgrade while keeping verified L2 scripts and records byte-identical", t => {
  const root = fixture(t);
  const files = [path.join(root, ".agent", rel), team.receiptFile(root), team.manifestPath(root)];
  const before = files.map(f => fs.readFileSync(f));
  const dry = run(root, ["--dry-run", "--force-scripts"]);
  assert.equal(dry.status, 0);
  assert.ok(dry.report.changes.preserved.some(c => c.path === ".agent/" + rel && c.reason === "team_pack_managed"));
  assert.equal(dry.report.changes.updated.some(c => c.path === ".agent/" + rel), false);
  assert.equal(dry.report.changes.protected.some(c => c.path === ".agent/" + rel), false);
  for (const args of [[], ["--force-scripts"], []]) {
    const applied = run(root, args);
    assert.equal(applied.status, 0, JSON.stringify(applied.report));
    assert.equal(applied.report.status, "passed");
    assert.equal(applied.report.summary.protected, 0);
    assert.ok(applied.report.changes.preserved.some(c => c.path === ".agent/" + rel));
    assert.equal(fs.readFileSync(path.join(root, ".agent/.cortex-version"), "utf8").trim(), require("../../package.json").version);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
  }
});

test("invalid Team Pack evidence remains partial and keeps the previous version stamp", t => {
  const root = fixture(t), receipt = team.readReceipt(root);
  receipt.pack.manifest_sha256 = "0".repeat(64);
  team.writeReceiptAtomic(root, receipt);
  const before = fs.readFileSync(path.join(root, ".agent", rel));
  const result = run(root, []);
  assert.equal(result.status, 2);
  assert.equal(result.report.status, "partial");
  assert.ok(result.report.changes.protected.some(c => c.path === ".agent/" + rel));
  assert.equal(fs.readFileSync(path.join(root, ".agent/.cortex-version"), "utf8"), "1.15.7\n");
  assert.deepEqual(fs.readFileSync(path.join(root, ".agent", rel)), before);
});

test("force-scripts dry-run reports the same reviewed local replacement as apply", t => {
  const root = fixture(t, false), destination = path.join(root, ".agent", rel);
  const before = fs.readFileSync(destination);
  const dry = run(root, ["--dry-run", "--force-scripts"]);
  assert.equal(dry.status, 0);
  assert.ok(dry.report.changes.updated.some(c => c.path === ".agent/" + rel && c.reason === "forced"));
  assert.equal(dry.report.changes.protected.some(c => c.path === ".agent/" + rel), false);
  assert.deepEqual(fs.readFileSync(destination), before);
  const applied = run(root, ["--force-scripts"]);
  assert.equal(applied.status, 0);
  assert.ok(applied.report.changes.updated.some(c => c.path === ".agent/" + rel));
  assert.deepEqual(fs.readFileSync(destination + ".bak"), before);
});
