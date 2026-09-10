"use strict";

// M-035 MS-004 (P-009): help distribution matrix.
//
// Every subcommand whose contract lives in the tracked .help/ directory must
// answer --help with that contract, exit 0, and never fall through to argument
// validation. Regression guard for the two original P-009 defects:
//   - `task create --help` returned the overview usage banner only
//   - `lease acquire --help` failed with ERR_ARG_REQUIRED

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const HELP_DIR = path.join(ROOT, ".help");

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
}

const CASES = [
  { args: ["task", "create", "--help"], file: "task-create.md", markers: ["--project", "--event-json"] },
  { args: ["lease", "acquire", "--help"], file: "lease-acquire.md", markers: ["--scope", "--owner"] },
  { args: ["decisions", "request", "--help"], file: "decisions-request.md", markers: ["--gate", "--gate-action", "--action"] },
  { args: ["agent", "adapter", "list", "--help"], file: "agent-adapter-list.md", markers: ["--project", "--output"] },
];

for (const entry of CASES) {
  test("help contract: " + entry.args.join(" "), () => {
    const result = run(entry.args);
    assert.equal(result.status, 0, result.stderr);
    const contract = fs.readFileSync(path.join(HELP_DIR, entry.file), "utf8");
    const expected = contract.endsWith("\n") ? contract : contract + "\n";
    assert.equal(result.stdout, expected, "stdout must be the .help/ contract document");
    for (const marker of entry.markers) {
      assert.ok(result.stdout.includes(marker), "contract is missing " + marker);
    }
  });

  test("help contract via -h: " + entry.args.join(" "), () => {
    const long = run(entry.args);
    const short = run(entry.args.map((arg) => (arg === "--help" ? "-h" : arg)));
    assert.equal(short.status, 0, short.stderr);
    assert.equal(short.stdout, long.stdout);
  });
}

test("every .help/ contract is at least 20 lines", () => {
  for (const entry of CASES) {
    const lines = fs.readFileSync(path.join(HELP_DIR, entry.file), "utf8").split("\n").length;
    assert.ok(lines >= 20, entry.file + " has only " + lines + " lines");
  }
});

test("contract dispatch does not shadow a command without a contract", () => {
  // `agent --help` is owned by the M-002 registry dispatcher and must keep
  // printing its own help rather than borrowing the adapter contract.
  const result = run(["agent", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("cortex-agent agent discover"), result.stdout);
  assert.ok(!result.stdout.includes("# cortex-agent agent adapter list"));
});

test("unknown commands still fail closed rather than printing a contract", () => {
  const result = run(["frobnicate", "--help"]);
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes("# cortex-agent"));
});

test(".help/ is part of the published package", () => {
  // Without this entry the contracts exist in the repo but vanish from the
  // installed tarball, which would silently restore the P-009 defects on any
  // user machine that installed cortex-agent from npm.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes(".help"), "package.json files must include .help");
  assert.ok(pkg.files.includes("lib"), "package.json files must include lib");
});

