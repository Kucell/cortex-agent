"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const cli = path.resolve(__dirname, "../../bin/cli.js");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failures += 1; console.error(`  ✗ ${name}: ${error.message}`); }
}

function sha(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tap-lifecycle-${label}-`));
}

function write(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeManifest(root, files) {
  const manifest = {
    schema_version: 1,
    name: "lifecycle-safety",
    version: "1.0.0",
    requires: { cortex_agent: ">=1.7.0" },
    signers: { mode: "disabled" },
    includes: ["rules/**/*.md"],
    excludes: [],
    files: files.map((file) => ({
      path: file.path,
      sha256: sha(file.content),
      mode: "merge",
    })),
  };
  write(root, ".agent-shared/team-pack.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(root, args) {
  return spawnSync(process.execPath, [cli, ...args, "--project", root], {
    cwd: root,
    encoding: "utf8",
  });
}

function treeDigest(root) {
  const entries = [];
  function walk(current, rel) {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        entries.push(`d:${childRel}`);
        walk(abs, childRel);
      } else {
        entries.push(`f:${childRel}:${sha(fs.readFileSync(abs))}`);
      }
    }
  }
  walk(root, "");
  return sha(entries.join("\n"));
}

check("CLI publish --dry-run leaves the complete project tree unchanged", () => {
  const root = tmpDir("publish-dry-run");
  write(root, ".agent-shared/team-pack.json", `${JSON.stringify({
    schema_version: 1,
    name: "dry-run",
    version: "1.0.0",
    requires: { cortex_agent: ">=1.7.0" },
    signers: { mode: "disabled" },
    includes: [],
    excludes: [],
    files: [],
  }, null, 2)}\n`);
  write(root, "src/rules/planned.md", "# Planned\n");
  const before = treeDigest(root);
  const result = run(root, ["team", "publish", "--paths", "src/rules/planned.md", "--dry-run"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(treeDigest(root), before);
});

check("L1 update --project resolves the target project instead of caller cwd", () => {
  const caller = tmpDir("project-caller");
  const target = tmpDir("project-target");
  fs.mkdirSync(path.join(target, ".agent"), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [cli, "update", "--project", target, "--dry-run", "--report", "json"],
    { cwd: caller, encoding: "utf8" },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.strictEqual(report.project.root, fs.realpathSync(target));
  assert.strictEqual(report.project.agent_root, fs.realpathSync(path.join(target, ".agent")));
});

check("team update atomically replaces a managed file and keeps a backup", () => {
  const root = tmpDir("backup");
  write(root, ".agent-shared/rules/shared.md", "v1\n");
  writeManifest(root, [{ path: "rules/shared.md", content: "v1\n" }]);
  let result = run(root, ["team", "install"]);
  assert.strictEqual(result.status, 0, result.stderr);

  write(root, ".agent-shared/rules/shared.md", "v2\n");
  writeManifest(root, [{ path: "rules/shared.md", content: "v2\n" }]);
  result = run(root, ["team", "update"]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(path.join(root, ".agent/rules/shared.md"), "utf8"), "v2\n");

  const backupRoot = path.join(root, ".agent/team-sync/backups");
  const runs = fs.readdirSync(backupRoot);
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(backupRoot, runs[0], "rules/shared.md"), "utf8"),
    "v1\n",
  );
});

check("tampered incoming content is rejected before any managed file changes", () => {
  const root = tmpDir("preflight");
  write(root, ".agent-shared/rules/a.md", "A1\n");
  write(root, ".agent-shared/rules/b.md", "B1\n");
  writeManifest(root, [
    { path: "rules/a.md", content: "A1\n" },
    { path: "rules/b.md", content: "B1\n" },
  ]);
  let result = run(root, ["team", "install"]);
  assert.strictEqual(result.status, 0, result.stderr);

  write(root, ".agent-shared/rules/a.md", "A2\n");
  write(root, ".agent-shared/rules/b.md", "B2\n");
  writeManifest(root, [
    { path: "rules/a.md", content: "A2\n" },
    { path: "rules/b.md", content: "B2\n" },
  ]);
  write(root, ".agent-shared/rules/b.md", "tampered after manifest\n");

  result = run(root, ["team", "update"]);
  assert.notStrictEqual(result.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(root, ".agent/rules/a.md"), "utf8"), "A1\n");
  assert.strictEqual(fs.readFileSync(path.join(root, ".agent/rules/b.md"), "utf8"), "B1\n");
});

if (failures > 0) {
  console.error(`\nFAIL: ${failures}`);
  process.exit(1);
}
console.log("\nPASS: Team Pack lifecycle safety");
