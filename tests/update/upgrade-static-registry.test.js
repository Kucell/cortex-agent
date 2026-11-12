"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const ROOT = path.resolve(__dirname, "../..");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-static-registry-")));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  fs.mkdirSync(path.join(root, ".agent"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0" }));
  return root;
}

function run(root, args, nodeArgs = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, path.join(ROOT, "bin/cli.js"), "upgrade", "--lang", "en", "--report", "json", ...args],
    { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return args.includes("--dry-run") ? JSON.parse(r.stdout) : r.stdout;
}

test("code-mode upgrade dry-run reports missing Registry contracts without writes", (t) => {
  const root = fixture(t);
  const report = run(root, ["--dry-run"]);
  const paths = report.plan.map((item) => item.path);
  assert.ok(paths.some((p) => p.endsWith("agents/agent.schema.json")));
  assert.ok(paths.some((p) => p.endsWith("agents/README.md")));
  assert.deepEqual(fs.readdirSync(path.join(root, ".agent")), []);
});

test("code-mode upgrade installs the canonical contracts without sample profiles or authority", (t) => {
  const root = fixture(t);
  run(root, []);
  for (const file of ["agent.schema.json", "README.md"]) {
    assert.deepEqual(fs.readFileSync(path.join(root, ".agent/agents", file)),
      fs.readFileSync(path.join(ROOT, "templates/_base/.agent/agents", file)));
  }
  assert.equal(fs.existsSync(path.join(root, ".agent/agents/sample.json")), false);
  assert.equal(fs.existsSync(path.join(root, ".agent/config/agent-registry.json")), false);
});

test("upgrade preserves owner policy, existing profiles and local contract overrides", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".agent/agents"));
  fs.mkdirSync(path.join(root, ".agent/config"));
  const files = ["agents/agent.schema.json", "agents/README.md", "agents/existing.json", "config/agent-registry.json"];
  for (const file of files) fs.writeFileSync(path.join(root, ".agent", file), "owner-local-content");
  run(root, []);
  for (const file of files) assert.equal(fs.readFileSync(path.join(root, ".agent", file), "utf8"), "owner-local-content");
});

test("upgrade preserves broken contract links and never writes their external targets", (t) => {
  if (process.platform === "win32") return; // Windows symlink privilege is not guaranteed.
  const root = fixture(t), outside = fixture(t);
  fs.mkdirSync(path.join(root, ".agent/agents"));
  const target = path.join(outside, "external-schema.json");
  const link = path.join(root, ".agent/agents/agent.schema.json");
  fs.symlinkSync(target, link);
  run(root, []);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(target), false);
});

test("a concurrent contract creator wins over upgrade's atomic no-replace copy", (t) => {
  const root = fixture(t), target = path.join(root, ".agent/agents/agent.schema.json");
  const preload = path.join(root, "concurrent-create.cjs");
  fs.writeFileSync(preload, `const fs = require('node:fs');
const original = fs.copyFileSync;
fs.copyFileSync = function(src, dest, mode) {
  if (dest === ${JSON.stringify(target)} && !fs.existsSync(dest)) fs.writeFileSync(dest, 'owner-concurrent-content', { flag: 'wx' });
  return original.apply(this, arguments);
};\n`);
  run(root, [], ["--require", preload]);
  assert.equal(fs.readFileSync(target, "utf8"), "owner-concurrent-content");
});
