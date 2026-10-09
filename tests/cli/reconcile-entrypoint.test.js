"use strict";

// Top-level CLI regression: exercise the shipped dispatcher, not a unit-level import.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function snapshot(directory) {
  const collected = {};
  function walk(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(dir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        collected[relative] = { kind: "symlink", target: fs.readlinkSync(absolute) };
      } else if (stat.isDirectory()) {
        collected[relative] = { kind: "directory" };
        walk(absolute, relative);
      } else {
        collected[relative] = {
          kind: "file",
          sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
        };
      }
    }
  }
  walk(directory);
  return collected;
}

function runReconcile(t, args = []) {
  assert.ok(fs.existsSync(CLI), "test requires the real repo CLI");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-cli-reconcile-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const project = path.join(sandbox, "project");
  const home = path.join(sandbox, "home");
  fs.mkdirSync(path.join(project, ".agent", "tasks"), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(project, ".agent", "tasks", "sentinel.json"), '{"preserve":true}\n');
  const before = snapshot(sandbox);
  const result = spawnSync(process.execPath, [CLI, "reconcile", ...args], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      PATH: "", // Must work without a MiniMax CLI binary.
      CI: "true",
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].join("\n");
  assert.equal(result.error, undefined, String(result.error || ""));
  assert.equal(result.status, 0, "CLI exit status="+result.status+": "+output);
  assert.doesNotMatch(output, /ReferenceError|minimaxCliReconcile is not defined/);
  assert.match(output, /MiniMax CLI reconcile|MiniMax CLI governed-tool adapter (?:not registered|未注册)/i);
  assert.deepEqual(snapshot(sandbox), before, "read-only reconcile must preserve project and HOME");
  if (/MiniMax CLI reconcile/i.test(output)) {
    assert.match(output, /read-only reconcile|只读 reconcile/i);
  }
}

test("cortex-agent reconcile uses the real top-level bound handler without writes", { timeout: 30_000 }, (t) => {
  runReconcile(t);
});

test("cortex-agent reconcile --lang zh remains bound and read-only", { timeout: 30_000 }, (t) => {
  runReconcile(t, ["--lang", "zh"]);
});
