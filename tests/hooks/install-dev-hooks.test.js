"use strict";

// Tests for scripts/install-dev-hooks.js.
//
// Every case runs against a scratch `--root` so the suite never touches the
// developer's real .git/hooks/pre-commit. The behaviour worth pinning is the
// durability contract: `.git/` is not version-controlled, so a hook edited in
// place only applies to the machine that wrote it. The tracked source plus a
// re-runnable installer is what makes the gate survive a fresh clone.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, describe, beforeEach, afterEach } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const INSTALLER = path.join(ROOT, "scripts", "install-dev-hooks.js");
const SOURCE_REL = path.join("hooks", "git", "pre-commit");

let scratch;

function run(args) {
  return spawnSync(process.execPath, [INSTALLER, ...args, "--root", scratch], {
    encoding: "utf8",
  });
}

function target() {
  return path.join(scratch, ".git", "hooks", "pre-commit");
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-hooks-"));
  // The installer reads its hook body from <root>/hooks/git/pre-commit, so a
  // scratch root needs the tracked source present.
  const src = path.join(scratch, SOURCE_REL);
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.copyFileSync(path.join(ROOT, SOURCE_REL), src);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("install-dev-hooks", () => {
  test("installs the tracked hook and marks it executable", () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(target()));
    if (process.platform !== "win32") {
      const mode = fs.statSync(target()).mode & 0o777;
      assert.equal(mode, 0o755, `expected 0755, got ${mode.toString(8)}`);
    }
  });

  test("the installed hook is byte-identical to the tracked source", () => {
    run([]);
    assert.ok(
      fs.readFileSync(target()).equals(fs.readFileSync(path.join(scratch, SOURCE_REL))),
      "drift between source and installed hook is exactly what this installer exists to prevent",
    );
  });

  test("the installed hook is valid bash", () => {
    run([]);
    const check = spawnSync("bash", ["-n", target()], { encoding: "utf8" });
    assert.equal(check.status, 0, `bash -n failed: ${check.stderr}`);
  });

  test("--check reports missing before install and clean after", () => {
    const before = run(["--check"]);
    assert.notEqual(before.status, 0, "must fail when no hook is installed");

    run([]);
    const after = run(["--check"]);
    assert.equal(after.status, 0, after.stdout + after.stderr);
  });

  test("--check reports drift instead of silently overwriting", () => {
    run([]);
    fs.writeFileSync(target(), "#!/bin/bash\n# hand-edited\n");
    const r = run(["--check"]);
    assert.notEqual(r.status, 0, "drift must be reported");
    assert.match(r.stdout, /drift/i);
  });

  test("re-installing backs up a differing hand-edited hook", () => {
    run([]);
    const edited = "#!/bin/bash\n# hand-edited\n";
    fs.writeFileSync(target(), edited);
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      fs.existsSync(`${target()}.bak`),
      "a hand-edited hook must not be lost without a backup",
    );
    assert.equal(fs.readFileSync(`${target()}.bak`, "utf8"), edited);
  });

  test("re-installing an identical hook is idempotent", () => {
    run([]);
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      fs.existsSync(`${target()}.bak`),
      false,
      "no backup should be written when nothing changed",
    );
  });

  test("--uninstall removes the hook and is safe to repeat", () => {
    run([]);
    const first = run(["--uninstall"]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.existsSync(target()), false);
    const second = run(["--uninstall"]);
    assert.equal(second.status, 0, "uninstalling twice must not fail");
  });

  test("the hook is inert when the L3 checker is absent", () => {
    // A project that adopts this hook without shipping lib/l3-boundary must not
    // have its commits blocked by a missing script.
    run([]);
    const body = fs.readFileSync(target(), "utf8");
    assert.match(
      body,
      /if \[ -f "\$L3_CHECK" \]/,
      "the gate must be guarded by an existence check on the checker script",
    );
  });

  test("the hook distinguishes a violation from a broken gate", () => {
    const body = fs.readFileSync(path.join(ROOT, SOURCE_REL), "utf8");
    assert.match(body, /L3 Distribution Boundary Report/,
      "output must be inspected so a gate crash is not reported as a violation");
  });
});
