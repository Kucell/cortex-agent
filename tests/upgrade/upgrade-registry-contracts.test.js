"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { testRuntime } = require("../helpers/runtime-sandbox");
const { buildManagedScriptsMap } = require("../helpers/managed-scripts");
const manifest = require("../../lib/script/manifest");

const ROOT = path.resolve(__dirname, "../..");
const OLD = path.join(ROOT, "tests/fixtures/registry-contracts");
const CURRENT = path.join(ROOT, "templates/_base/.agent/agents");
const contracts = ["agent.schema.json", "README.md"];
const oldName = name => name === "README.md" ? "README.pre-reconcile.md" : "agent.pre-reconcile.schema.json";

function fixture(t) {
  const dir = testRuntime("registry-contract-upgrade");
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.mkdtempSync(path.join(dir, "consumer-"));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  fs.mkdirSync(path.join(root, ".agent/agents"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agent/config"));
  for (const name of contracts) fs.copyFileSync(path.join(OLD, oldName(name)), path.join(root, ".agent/agents", name));
  fs.writeFileSync(path.join(root, ".agent/.cortex-version"), "1.15.7\n");
  fs.writeFileSync(path.join(root, ".agent/config/agent-registry.json"), '{"owner":"preserve-owner-policy"}\n');
  fs.writeFileSync(path.join(root, ".agent/agents/owner-profile.json"), '{"identity":"preserve-native-identity","enabled":true}\n');
  fs.writeFileSync(path.join(root, ".agent/user-rule.md"), "preserve local rules\n");
  fs.writeFileSync(path.join(root, ".agent/.script-manifest.json"), JSON.stringify({ schema_version: 1, scripts: buildManagedScriptsMap(ROOT) }));
  return root;
}

function run(root, command, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "bin/cli.js"), command, "--lang", "en", "--report", "json", ...args], {
    cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CORTEX_STATE_SYNC: "off" },
  });
  assert.equal(r.error, undefined);
  const report = args.includes("--dry-run") ? JSON.parse(r.stdout) : JSON.parse(fs.readFileSync(path.join(root, ".agent/updates/latest.json")));
  assert.ok([0, 2].includes(r.status), JSON.stringify({ status: r.status, failed: report.verification?.filter(c => c.status === "failed"), stderr: r.stderr }));
  return report;
}

function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), stat = fs.lstatSync(file), rel = path.relative(root, file);
      if (stat.isDirectory()) walk(file);
      else result[rel] = stat.isSymbolicLink() ? "link:" + fs.readlinkSync(file) : fs.readFileSync(file).toString("base64");
    }
  }
  walk(root);
  return result;
}

test("old published Registry contracts converge through update while upgrade and dry-run preserve them", t => {
  const root = fixture(t), before = snapshot(root);
  const dry = run(root, "update", ["--dry-run"]);
  for (const name of contracts) assert.ok(dry.changes.updated.some(x => x.path === ".agent/agents/" + name));
  assert.deepEqual(snapshot(root), before, "dry-run must have zero writes");

  run(root, "upgrade");
  for (const name of contracts) assert.deepEqual(fs.readFileSync(path.join(root, ".agent/agents", name)), fs.readFileSync(path.join(OLD, oldName(name))));
  const applied = run(root, "update");
  for (const name of contracts) {
    const dest = path.join(root, ".agent/agents", name);
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(CURRENT, name)));
    assert.deepEqual(fs.readFileSync(dest + ".bak"), fs.readFileSync(path.join(OLD, oldName(name))));
    assert.ok(applied.changes.updated.some(x => x.path === ".agent/agents/" + name));
  }
  const schema = JSON.parse(fs.readFileSync(path.join(root, ".agent/agents/agent.schema.json")));
  assert.ok(schema.properties.profile_revision);
  assert.ok(schema.properties.registration.properties.events.items.properties.action.enum.includes("reconcile"));
  for (const name of [".agent/config/agent-registry.json", ".agent/agents/owner-profile.json", ".agent/user-rule.md"]) {
    assert.equal(fs.readFileSync(path.join(root, name)).toString("base64"), before[name]);
  }
  const again = run(root, "update");
  assert.equal(again.changes.updated.some(x => contracts.some(name => x.path === ".agent/agents/" + name)), false);
  for (const name of contracts) assert.deepEqual(fs.readFileSync(path.join(root, ".agent/agents", name + ".bak")), fs.readFileSync(path.join(OLD, oldName(name))));
});

test("custom Registry contracts are protected even with force-scripts", t => {
  const root = fixture(t);
  for (const name of contracts) fs.appendFileSync(path.join(root, ".agent/agents", name), "\n ");
  const before = snapshot(root);
  const applied = run(root, "update", ["--force-scripts"]);
  for (const name of contracts) {
    const rel = ".agent/agents/" + name;
    assert.equal(fs.readFileSync(path.join(root, rel)).toString("base64"), before[rel]);
    assert.ok(applied.changes.protected.some(x => x.path === rel));
  }
  assert.equal(applied.status, "partial");
  assert.equal(fs.readFileSync(path.join(root, ".agent/.cortex-version"), "utf8"), "1.15.7\n");
});

test("Registry contract links and linked directories never overwrite external content", { skip: process.platform === "win32" }, t => {
  for (const directoryLink of [false, true]) {
    const root = fixture(t), outside = fixture(t);
    const dest = path.join(root, ".agent/agents"), target = path.join(outside, ".agent/agents");
    if (directoryLink) {
      fs.rmSync(dest, { recursive: true });
      fs.symlinkSync(target, dest);
    } else {
      fs.unlinkSync(path.join(dest, "agent.schema.json"));
      fs.symlinkSync(path.join(target, "agent.schema.json"), path.join(dest, "agent.schema.json"));
      fs.unlinkSync(path.join(dest, "README.md"));
      fs.symlinkSync(path.join(target, "missing-readme"), path.join(dest, "README.md"));
    }
    const before = snapshot(outside);
    run(root, "update", ["--force-scripts"]);
    assert.deepEqual(snapshot(outside), before);
    assert.ok(fs.lstatSync(directoryLink ? dest : path.join(dest, "agent.schema.json")).isSymbolicLink());
  }
});

test("contract write failure restores the old bytes and keeps public script discovery unchanged", t => {
  const root = fixture(t), dest = path.join(root, ".agent/agents/agent.schema.json");
  const templateDir = path.join(ROOT, "templates/en");
  assert.ok(manifest.discoverTemplateScripts(templateDir).every(rel => rel.endsWith(".js")));
  const copy = fs.copyFileSync;
  let injected = false;
  let result;
  try {
    fs.copyFileSync = function (src, target, ...args) {
      if (!injected && target === dest) {
        injected = true;
        throw Object.assign(new Error("injected contract write failure"), { code: "EIO" });
      }
      return copy.call(this, src, target, ...args);
    };
    result = manifest.reconcileScripts({ cwd: root, templateDir, lang: "en", apply: true });
  } finally { fs.copyFileSync = copy; }
  assert.equal(injected, true);
  assert.ok(result.failed.some(x => x.path === "agents/agent.schema.json"));
  assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(OLD, oldName("agent.schema.json"))));
  assert.deepEqual(fs.readFileSync(dest + ".bak"), fs.readFileSync(dest));
});

test("Registry backup links cannot overwrite external files", { skip: process.platform === "win32" }, t => {
  for (const suffix of [".bak", ".bak.prev"]) {
    const root = fixture(t), outside = fixture(t);
    const dest = path.join(root, ".agent/agents/agent.schema.json");
    const target = path.join(outside, "private.txt");
    fs.writeFileSync(target, "preserve unrelated data\n");
    if (suffix === ".bak.prev") fs.writeFileSync(dest + ".bak", "preserve older backup\n");
    fs.symlinkSync(target, dest + suffix);
    const before = snapshot(outside);
    const report = run(root, "update");
    assert.deepEqual(snapshot(outside), before);
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(path.join(OLD, oldName("agent.schema.json"))));
    assert.ok(report.changes.protected.some(x => x.path === ".agent/agents/agent.schema.json"));
    assert.ok(fs.lstatSync(dest + suffix).isSymbolicLink());
  }
});
