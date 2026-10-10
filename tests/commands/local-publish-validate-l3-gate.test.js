"use strict";

// ─── local-publish-validate must not publish past the L3 boundary gate ────────
//
// `gitCommitAndTag()` commits with `--no-verify`, which disables every
// pre-commit hook — including the L3 distribution boundary gate added in
// 79f3677. Publishing is exactly when that gate must hold: it is the last point
// before templates/ reaches every managed project.
//
// A real leak reached main this way: 1eb3d98 added an author-local absolute
// path to templates/{en,zh}/.agent/workflows/briefing.md and the hook never
// fired, because the commit went through this script.
//
// The gate runs in step 3, before npm pack (step 4) and volta install (step 5),
// so a failure exits before anything is packed or installed. These tests
// therefore run the real script against a throwaway git repo and assert that
// nothing was committed, packed or installed.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, describe, beforeEach, afterEach } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "bin", "local-publish-validate.cjs");

let repo;

function git(args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function writeStubGate(body) {
  const dir = path.join(repo, "scripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "check-l3-boundary.js"), body);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lpv-l3-"));
  git(["init", "-q"]);
  git(["config", "user.email", "lpv@test"]);
  git(["config", "user.name", "lpv"]);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "lpv-l3-fixture", version: "1.0.0", private: true }),
  );
  fs.mkdirSync(path.join(repo, "templates", "x"), { recursive: true });
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

function run() {
  return spawnSync(process.execPath, [SCRIPT, "--force", "--skip-tests"], {
    cwd: repo,
    encoding: "utf8",
  });
}

describe("local-publish-validate — L3 boundary gate before commit", () => {
  test("a failing gate blocks the commit and tags nothing", () => {
    writeStubGate('process.stdout.write("violation found\\n"); process.exit(1);');
    const before = git(["rev-parse", "HEAD"]).stdout.trim();

    const r = run();

    assert.notEqual(r.status, 0, "the script must fail when the gate fails");
    assert.match(r.stdout + r.stderr, /L3 distribution boundary check failed/);
    assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), before, "HEAD must not advance");
    assert.equal(git(["tag"]).stdout.trim(), "", "no tag may be created");
  });

  test("a failing gate stops before npm pack", () => {
    writeStubGate("process.exit(1);");
    const r = run();
    assert.doesNotMatch(r.stdout, /npm pack/, "pack must not run once the gate fails");
    assert.doesNotMatch(r.stdout, /volta install/, "install must not run once the gate fails");
  });

  test("the gate is invoked at all", () => {
    // A marker file proves the script actually executed the checker rather
    // than merely carrying the code path.
    writeStubGate(
      'require("node:fs").writeFileSync(process.env.LPV_MARKER, "ran");\n' +
        "process.exit(1);"
    );
    const marker = path.join(repo, "gate-ran.marker");
    spawnSync(process.execPath, [SCRIPT, "--force", "--skip-tests"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, LPV_MARKER: marker },
    });
    assert.ok(fs.existsSync(marker), "the boundary checker must be executed");
  });

  test("the commit still passes --no-verify, which is why the explicit gate exists", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    assert.match(
      src,
      /'commit', '-m', message, '--no-verify'/,
      "the --no-verify call is expected; the guard above it is what must hold",
    );
    const gateIdx = src.indexOf("check-l3-boundary.js");
    const commitIdx = src.indexOf("'--no-verify'");
    assert.ok(
      gateIdx !== -1 && gateIdx < commitIdx,
      "the boundary gate must be checked before the commit that skips hooks",
    );
  });
});