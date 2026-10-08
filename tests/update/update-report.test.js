"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-update-report-"));
  fs.mkdirSync(path.join(cwd, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".agent", "README.md"), "# project README\n", "utf8");
  return cwd;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8" },
  });
}

function snapshot(cwd) {
  const agentRoot = path.join(cwd, ".agent");
  const snap = new Map();
  const walk = (abs, relBase) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(abs, entry.name);
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        snap.set(rel, fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(agentRoot, "");
  return snap;
}

test("update --dry-run --report json emits a machine-readable zero-write plan", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const before = snapshot(cwd);

  const result = runCli(cwd, ["update", "--lang", "en", "--dry-run", "--report", "json"]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  assert.equal(result.stderr, "");

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.command, "update");
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.language, "en");
  assert.equal(payload.project.root, fs.realpathSync(cwd));
  assert.equal(payload.project.agent_root, fs.realpathSync(path.join(cwd, ".agent")));
  assert.ok(Array.isArray(payload.plan));
  assert.ok(payload.plan.length > 0, "fixture should produce at least one planned change");
  assert.equal(payload.summary.total_plan_items, payload.plan.length);
  assert.ok(payload.plan.some((item) => item.layer === "L0" && item.action === "add"));
  assert.ok(payload.skipped_checks.some((item) => item.name === "check-drift"));

  const after = snapshot(cwd);
  assert.deepEqual(after, before);
});

test("update dry run reports a pre-fix script claim as protected without changing files", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const rel = "skills/management-api/scripts/index.js";
  const dest = path.join(cwd, ".agent", rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, "// old custom script\n");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
  fs.writeFileSync(path.join(cwd, ".agent", ".script-manifest.json"), JSON.stringify({
    schema_version: 1,
    scripts: { [rel]: { origin_hash: hash, source_template_sha256: hash } },
  }));
  const before = snapshot(cwd);

  const result = runCli(cwd, ["update", "--lang", "en", "--dry-run", "--report", "json"]);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.ok(report.changes.protected.some((item) =>
    item.path === `.agent/${rel}` && item.reason === "unverified_legacy_manifest"));
  assert.ok(!report.changes.updated.some((item) => item.path === `.agent/${rel}`));
  assert.deepEqual(snapshot(cwd), before);
});

test("update --dry-run --report=json uses the same JSON contract", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = runCli(cwd, ["update", "--lang=en", "--dry-run", "--report=json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "update");
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.changes.added.length, payload.summary.would_add);
});
