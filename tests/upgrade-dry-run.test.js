"use strict";

// Coverage for `cortex-agent upgrade --dry-run`. The contract:
//   1. Zero-byte side effect: mtime / file list on the project's `.agent/`
//      is identical before and after `--dry-run`.
//   2. The dry-run output must contain a "Would add (N)" line and at least
//      one candidate path.
//   3. After a real `upgrade` (apply path), a follow-up `--dry-run` reports
//      `Would add (0)` — the additive contract is satisfied.
//   4. cli-level help text lists --dry-run.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "bin", "cli.js");

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-upgrade-dryrun-"));
  // Minimal `.agent/` so upgrade() does not bail with "no .agent dir".
  fs.mkdirSync(path.join(cwd, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".agent", "README.md"), "# project README\n", "utf8");
  return cwd;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function snapshot(cwd) {
  // Capture current state: relative paths under .agent/ with content hash.
  const agentRoot = path.join(cwd, ".agent");
  const snap = new Map();
  const walk = (abs, relBase) => {
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(abs, e.name);
      const rel = relBase ? path.posix.join(relBase, e.name) : e.name;
      if (e.isDirectory()) {
        walk(full, rel);
      } else if (e.isFile()) {
        snap.set(rel, fs.readFileSync(full));
      }
    }
  };
  walk(agentRoot, "");
  return snap;
}

function diffSnapshots(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const diffs = [];
  for (const k of keys) {
    const a = before.get(k);
    const b = after.get(k);
    if (!a || !b) { diffs.push({ key: k, kind: !a ? "added" : "removed" }); continue; }
    if (!a.equals(b)) diffs.push({ key: k, kind: "modified" });
  }
  return diffs;
}

// ─── primary contract: zero byte residue ──────────────────────────────────────

test("upgrade --dry-run: leaves zero byte residue on .agent/", () => {
  const cwd = fixture();
  const before = snapshot(cwd);
  const r = runCli(cwd, ["upgrade", "--lang", "en", "--dry-run"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const after = snapshot(cwd);
  const diffs = diffSnapshots(before, after);
  assert.deepEqual(diffs, [], `dry-run modified: ${JSON.stringify(diffs)}`);
});

// ─── output contract ─────────────────────────────────────────────────────────

test("upgrade --dry-run: prints 'Would add (N)' line and at least one path", () => {
  const cwd = fixture();
  const r = runCli(cwd, ["upgrade", "--lang", "en", "--dry-run"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Would add \(\d+\)/, "stdout should contain Would add (N) summary line");
  // The fixture starts missing most of the template — at least one + line.
  assert.match(r.stdout, /\+ \.gitignore|\+ .+\.md|\+ .+\.js/, "stdout should list a concrete would-add path");
});

test("upgrade --dry-run: skips check-drift (does not write self-check-report.json)", () => {
  const cwd = fixture();
  const r = runCli(cwd, ["upgrade", "--lang", "en", "--dry-run"]);
  assert.equal(r.status, 0);
  // self-check-report.json is written by runSelfCheck('check-drift').
  // Under --dry-run we MUST NOT have created it.
  const reportPath = path.join(cwd, ".agent", "metrics", "self-check-report.json");
  assert.equal(fs.existsSync(reportPath), false,
    `dry-run leaked ${reportPath}; check-drift must be skipped.`);
  // And the skip should be communicated.
  assert.match(r.stdout, /Skipping check-drift/);
});

// ─── idempotence: apply then dry-run reports (0) ─────────────────────────────

test("upgrade apply followed by --dry-run reports Would add (0)", () => {
  const cwd = fixture();
  const beforeApply = snapshot(cwd);
  // Real apply path — copies all missing files.
  const r1 = runCli(cwd, ["upgrade", "--lang", "en"]);
  assert.equal(r1.status, 0, `apply failed: ${r1.stderr}\n${r1.stdout}`);
  const afterApply = snapshot(cwd);
  // Apply MUST have produced residue (templates missing in fixture).
  const added = afterApply.size - beforeApply.size;
  assert.ok(added > 5, `apply should add files; added=${added}`);

  // Now dry-run — should report 0 added (everything aligned).
  const r2 = runCli(cwd, ["upgrade", "--lang", "en", "--dry-run"]);
  assert.equal(r2.status, 0);
  assert.match(r2.stdout, /Would add \(0\)/);
});

// ─── help / cli-level discovery ─────────────────────────────────────────────

test("help text exposes --dry-run", () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.match(r.stdout, /--dry-run/);
});
