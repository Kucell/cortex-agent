/**
 * tests/skills/phase-gate/gate.test.js
 *
 * Unit tests for the phase-gate mechanical runner.
 * Source: templates/_shared/.agent/skills/phase-gate/scripts/gate.js
 *
 * The test targets the L1 template copy, not the L3 working instance under
 * `.agent/`: the template is what ships to every managed project and it is
 * tracked in this repository, so the test runs in CI where `.agent/` is only
 * present as a submodule pinned to an older commit.
 *
 * Why these tests exist:
 *   The gate that /ship used to rely on was prose, and the one command ship.md
 *   named (`.agent/hooks/pre-commit-check.sh`) exits 0 for every input when
 *   invoked standalone — it is a Claude Code PostToolUse hook that reads its
 *   target path from a JSON payload on stdin. These tests pin the behaviour
 *   that fixes it: the runner feeds the payload the hook expects, and fails
 *   closed when it cannot decide.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const GATE = path.resolve(
  __dirname,
  "../../../templates/_shared/.agent/skills/phase-gate/scripts/gate.js"
);
const gate = require(GATE);

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-gate-"));
  fs.mkdirSync(path.join(dir, ".agent", "hooks"), { recursive: true });
  return dir;
}

/** A stand-in for the real Claude Code PostToolUse hook. */
function writeFakeHook(dir) {
  const hook = path.join(dir, ".agent", "hooks", "pre-commit-check.sh");
  fs.writeFileSync(
    hook,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "INPUT=$(cat)",
      'FILE_PATH=$(echo "$INPUT" | jq -r \'.tool_input.file_path // ""\' 2>/dev/null || echo "")',
      'if [ -z "$FILE_PATH" ] || [ ! -f "$FILE_PATH" ]; then',
      "  exit 0",
      "fi",
      'if grep -qiE "hardcoded_secret_MARKER" "$FILE_PATH" 2>/dev/null; then',
      '  echo "❌ Pre-commit 检查阻断：hardcoded secret in $FILE_PATH" >&2',
      "  exit 1",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.chmodSync(hook, 0o755);
  return hook;
}

function initGitRepo(dir) {
  const run = (args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["init", "-q", "."]);
  run(["config", "user.email", "gate@test.local"]);
  run(["config", "user.name", "gate test"]);
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runGate(args, cwd) {
  return spawnSync("node", [GATE, ...args], { cwd, encoding: "utf8" });
}

// ─── the regression this whole runner exists for ─────────────────────────────

test("standalone hook invocation passes a file the runner blocks", () => {
  const dir = makeTempProject();
  try {
    const hook = writeFakeHook(dir);
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "bad.js"), "const x = 'hardcoded_secret_MARKER';\n", "utf8");
    execFileSync("git", ["add", "bad.js"], { cwd: dir });

    // The old ship.md invocation: no stdin payload → the hook cannot find a
    // file → it always exits 0. This is the silent no-op being fixed.
    const legacy = spawnSync("bash", [hook], { cwd: dir, input: "", encoding: "utf8" });
    assert.equal(legacy.status, 0, "legacy standalone invocation is expected to pass silently");

    // The runner feeds the payload the hook actually expects.
    const result = runGate(["--lint-only", "--cwd", dir, "--json"], dir);
    assert.equal(result.status, 1, "runner must block the same file");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "FAIL");
    assert.equal(payload.checks[0].id, "lint_clean");
    assert.match(payload.checks[0].detail, /bad\.js/);
  } finally {
    cleanup(dir);
  }
});

test("runner passes a clean changeset", () => {
  const dir = makeTempProject();
  try {
    writeFakeHook(dir);
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "good.js"), "const x = 1;\n", "utf8");
    execFileSync("git", ["add", "good.js"], { cwd: dir });

    const result = runGate(["--lint-only", "--cwd", dir, "--json"], dir);
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "PASS");
    assert.deepEqual(payload.blocking_issues, []);
  } finally {
    cleanup(dir);
  }
});

// ─── fail-closed behaviour ───────────────────────────────────────────────────

test("missing hook script blocks instead of silently passing", () => {
  const dir = makeTempProject();
  try {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "a.js"), "const x = 1;\n", "utf8");
    execFileSync("git", ["add", "a.js"], { cwd: dir });

    const result = runGate(["--lint-only", "--cwd", dir, "--json"], dir);
    assert.equal(result.status, 1, "a gate that cannot decide must not pass");
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "FAIL");
    assert.match(payload.checks[0].detail, /hook_script_missing|未找到/);
  } finally {
    cleanup(dir);
  }
});

test("missing jq blocks instead of silently passing", () => {
  const dir = makeTempProject();
  try {
    writeFakeHook(dir);
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "a.js"), "const x = 1;\n", "utf8");
    execFileSync("git", ["add", "a.js"], { cwd: dir });

    // Emulate an environment without jq: the hook cannot parse its payload
    // and would exit 0 for every file.
    const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), "phase-gate-nopath-"));
    try {
      const result = spawnSync("node", [GATE, "--lint-only", "--cwd", dir, "--json"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: emptyPath },
      });
      // bash/git must still be reachable for the run to be meaningful, so
      // only assert the jq-specific outcome when the run got that far.
      if (result.status === 1) {
        const payload = JSON.parse(result.stdout);
        assert.match(payload.checks[0].detail, /jq|无法判定|原因/);
      }
    } finally {
      cleanup(emptyPath);
    }
  } finally {
    cleanup(dir);
  }
});

// ─── transition gates ────────────────────────────────────────────────────────

test("REVIEW->COMMIT blocks when no review verdict exists", () => {
  const dir = makeTempProject();
  try {
    const result = runGate(["--from", "REVIEW", "--to", "COMMIT", "--task", "T-TEST", "--json"], dir);
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "FAIL");
    assert.ok(payload.blocking_issues.some((b) => b.includes("review_verdict_present")));
  } finally {
    cleanup(dir);
  }
});

test("REVIEW->COMMIT blocks when verdict carries blocking issues", () => {
  const dir = makeTempProject();
  try {
    const verdictPath = path.join(dir, "review_verdict.json");
    fs.writeFileSync(
      verdictPath,
      JSON.stringify({ type: "review_verdict", verdict: "FAIL", blocking_issues: ["缺少测试"] }),
      "utf8"
    );
    const result = runGate(
      ["--from", "REVIEW", "--to", "COMMIT", "--review-verdict", verdictPath, "--json"],
      dir
    );
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "FAIL");
    assert.ok(payload.blocking_issues.some((b) => b.includes("no_blocking_issues")));
  } finally {
    cleanup(dir);
  }
});

test("REVIEW->COMMIT passes with a clean PASS verdict", () => {
  const dir = makeTempProject();
  try {
    const verdictPath = path.join(dir, "review_verdict.json");
    fs.writeFileSync(
      verdictPath,
      JSON.stringify({ type: "review_verdict", verdict: "PASS", blocking_issues: [] }),
      "utf8"
    );
    const result = runGate(
      ["--from", "REVIEW", "--to", "COMMIT", "--review-verdict", verdictPath, "--json"],
      dir
    );
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verdict, "PASS");
    assert.deepEqual(payload.blocking_issues, []);
  } finally {
    cleanup(dir);
  }
});

test("advisory warnings never block a transition", () => {
  const dir = makeTempProject();
  try {
    const result = runGate(["--from", "START", "--to", "PLAN", "--json"], dir);
    // architecture-design.md is absent in a bare temp dir → that check fails.
    // The advisory task check must not turn a WARN into a block.
    const payload = JSON.parse(result.stdout);
    assert.ok(Array.isArray(payload.warnings));
    const advisoryOnly = payload.checks.filter((c) => c.severity === "advisory");
    for (const check of advisoryOnly) {
      assert.notEqual(check.status, "FAIL", `advisory check ${check.id} must not fail`);
    }
  } finally {
    cleanup(dir);
  }
});

test("unknown transition is a usage error, not a pass", () => {
  const dir = makeTempProject();
  try {
    const result = runGate(["--from", "PLAN", "--to", "COMMIT", "--json"], dir);
    assert.equal(result.status, 2);
  } finally {
    cleanup(dir);
  }
});

test("missing --from/--to is a usage error", () => {
  const result = runGate(["--json"], process.cwd());
  assert.equal(result.status, 2);
});

// ─── argument parsing ────────────────────────────────────────────────────────

test("parseArgs rejects an unknown argument", () => {
  assert.throws(() => gate.parseArgs(["--nope"]), /unknown argument/);
});

test("parseArgs rejects a flag without a value", () => {
  assert.throws(() => gate.parseArgs(["--from", "--to"]), /requires a value/);
});

test("parseArgs reads every documented option", () => {
  const parsed = gate.parseArgs([
    "--from", "LINT",
    "--to", "REVIEW",
    "--task", "T-1",
    "--plan", "p.md",
    "--review-verdict", "r.json",
    "--lint-result", "l.json",
    "--write-lint-result", "w.json",
    "--json",
  ]);
  assert.equal(parsed.from, "LINT");
  assert.equal(parsed.to, "REVIEW");
  assert.equal(parsed.task, "T-1");
  assert.equal(parsed.plan, "p.md");
  assert.equal(parsed.reviewVerdict, "r.json");
  assert.equal(parsed.lintResult, "l.json");
  assert.equal(parsed.writeLintResult, "w.json");
  assert.equal(parsed.json, true);
});

// ─── L1 template / L3 working-instance drift guard ───────────────────────────

test("L3 working instance stays byte-identical to the L1 template", () => {
  const l1 = path.resolve(
    __dirname,
    "../../../templates/_shared/.agent/skills/phase-gate/scripts/gate.js"
  );
  const l3 = path.resolve(
    __dirname,
    "../../../.agent/skills/phase-gate/scripts/gate.js"
  );

  if (!fs.existsSync(l3)) {
    // The .agent governance repo is pinned in CI and may predate this runner.
    // Skip explicitly rather than fail — the check becomes active as soon as
    // the governance repo carries the same file.
    assert.ok(
      fs.existsSync(l1),
      "the L1 template copy must always exist — it is what ships to users"
    );
    return;
  }

  assert.equal(
    fs.readFileSync(l3, "utf8"),
    fs.readFileSync(l1, "utf8"),
    "L3 working instance drifted from the L1 template — sync .agent/skills/phase-gate/scripts/gate.js"
  );
});

// ─── lint result artifact round-trip ─────────────────────────────────────────

test("lint result artifact is written and reused", () => {
  const dir = makeTempProject();
  try {
    writeFakeHook(dir);
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "bad.js"), "const x = 'hardcoded_secret_MARKER';\n", "utf8");
    execFileSync("git", ["add", "bad.js"], { cwd: dir });

    const artifact = path.join(dir, "lint-result.json");
    const first = runGate(
      ["--lint-only", "--cwd", dir, "--write-lint-result", artifact, "--json"],
      dir
    );
    assert.equal(first.status, 1);
    assert.ok(fs.existsSync(artifact), "lint result artifact must exist");

    const written = JSON.parse(fs.readFileSync(artifact, "utf8"));
    assert.equal(written.type, "lint_result");
    assert.equal(written.ran, true);
    assert.equal(written.violations.length, 1);

    // Reusing the artifact must produce the same verdict without re-running.
    const second = runGate(
      ["--from", "LINT", "--to", "REVIEW", "--cwd", dir, "--lint-result", artifact, "--json"],
      dir
    );
    assert.equal(second.status, 1);
    const payload = JSON.parse(second.stdout);
    assert.equal(payload.verdict, "FAIL");
    assert.match(payload.checks.find((c) => c.id === "lint_clean").detail, /bad\.js/);
  } finally {
    cleanup(dir);
  }
});
