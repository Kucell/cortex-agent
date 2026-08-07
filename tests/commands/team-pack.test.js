"use strict";

// ─── lib/commands/team-pack.js unit tests ─────────────────────────────────────
//
// Coverage:
//   - teamUsage: dispatch by subcommand name
//   - teamDispatch: missing sub → prints usage, no exit code
//   - teamDispatch: --help / -h → prints usage, no exit code
//   - teamDispatch: unknown sub → process.exitCode = 2
//   - parsePathsOption: --paths takes following values
//   - parsePathsOption: --paths=a,b,c comma form
//   - parsePathsOption: no --paths → empty
//   - normalizePublishDest: allowlist passthrough
//   - normalizePublishDest: leading non-allowlist dropped to nearest allowlist
//   - normalizePublishDest: no allowlist found → rules/<segs>
//   - teamVerify: missing manifest → exitCode 2
//   - teamInstall: missing manifest → exitCode 2
//   - teamPublish: missing --paths → exitCode 2
//   - teamStatus: prints single-line summary for a freshly-initialised project
//   - teamInit: non-interactive default prints hint, no install

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  teamUsage,
  teamDispatch,
  teamVerify,
  teamInstall,
  teamPublish,
  teamStatus,
  teamInit,
  parsePathsOption,
  normalizePublishDest,
  teamUpdate,
  teamResolveProject,
  applyPlanToProject,
  writeConflictArtifact,
} = require("../../lib/commands/team-pack");

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stdout.write = orig; return chunks.join(""); } };
}

function captureStderr() {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return { chunks, restore: () => { process.stderr.write = orig; return chunks.join(""); } };
}

function makeCtx(args, options = {}, cwd) {
  return {
    args,
    options,
    cwd: cwd || process.cwd(),
    lang: "en",
    command: "team",
  };
}

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-team-pack-test-"));
}

// ─── teamUsage ────────────────────────────────────────────────────────────────

test("teamUsage: init subcommand", () => {
  assert.match(teamUsage({ args: ["team", "init"], options: {}, cwd: process.cwd(), lang: "en" }), /team init/);
});
test("teamUsage: status subcommand", () => {
  assert.match(teamUsage({ args: ["team", "status"], options: {}, cwd: process.cwd(), lang: "en" }), /team status/);
});
test("teamUsage: install subcommand", () => {
  assert.match(teamUsage({ args: ["team", "install"], options: {}, cwd: process.cwd(), lang: "en" }), /team install/);
});
test("teamUsage: update subcommand", () => {
  assert.match(teamUsage({ args: ["team", "update"], options: {}, cwd: process.cwd(), lang: "en" }), /team update/);
});
test("teamUsage: publish subcommand", () => {
  assert.match(teamUsage({ args: ["team", "publish"], options: {}, cwd: process.cwd(), lang: "en" }), /team publish/);
});
test("teamUsage: verify subcommand", () => {
  assert.match(teamUsage({ args: ["team", "verify"], options: {}, cwd: process.cwd(), lang: "en" }), /team verify/);
});
test("teamUsage: unknown subcommand → generic usage", () => {
  assert.match(teamUsage({ args: ["team", "bogus"], options: {}, cwd: process.cwd(), lang: "en" }), /team <init\|status\|install\|update\|publish\|verify>/);
});

// ─── teamDispatch ─────────────────────────────────────────────────────────────

test("teamDispatch: missing subcommand → prints usage, no exit", async () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamDispatch(makeCtx(["team"]));
    assert.equal(process.exitCode, origExit);
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  assert.match(out, /Usage: cortex-agent team/);
});

test("teamDispatch: --help → prints usage, no exit", async () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamDispatch(makeCtx(["team", "--help"]));
    assert.equal(process.exitCode, origExit);
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  assert.match(out, /Usage: cortex-agent team/);
});

test("teamDispatch: -h → prints usage, no exit", async () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamDispatch(makeCtx(["team", "-h"]));
    assert.equal(process.exitCode, origExit);
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  assert.match(out, /Usage: cortex-agent team/);
});

test("teamDispatch: unknown sub → exitCode = 2", async () => {
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamDispatch(makeCtx(["team", "bogus"]));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

// ─── parsePathsOption ─────────────────────────────────────────────────────────

test("parsePathsOption: --paths takes following values until next flag", () => {
  const out = parsePathsOption({ args: ["team", "publish", "--paths", "a.md", "b.md", "--dry-run"] });
  assert.deepEqual(out, ["a.md", "b.md"]);
});

test("parsePathsOption: --paths=a,b,c comma form", () => {
  const out = parsePathsOption({ args: ["team", "publish", "--paths=a.md,b.md"] });
  assert.deepEqual(out, ["a.md", "b.md"]);
});

test("parsePathsOption: no --paths → empty array", () => {
  const out = parsePathsOption({ args: ["team", "publish"] });
  assert.deepEqual(out, []);
});

// ─── normalizePublishDest ─────────────────────────────────────────────────────

test("normalizePublishDest: allowlist passthrough (rules/foo.md)", () => {
  assert.equal(normalizePublishDest("rules/foo.md"), "rules/foo.md");
});

test("normalizePublishDest: allowlist passthrough (skills/foo/bar.md)", () => {
  assert.equal(normalizePublishDest("skills/foo/bar.md"), "skills/foo/bar.md");
});

test("normalizePublishDest: leading non-allowlist dropped to nearest allowlist", () => {
  // `src/rules/foo.md` → top "src" not allowlist, next seg "rules" IS allowlist,
  // so we drop the leading "src" and return "rules/foo.md".
  assert.equal(normalizePublishDest("src/rules/foo.md"), "rules/foo.md");
  // `my-rules/foo.md` → top "my-rules" not allowlist, next seg "foo.md" is NOT
  // allowlist either, so the function falls through to the default `rules/<segs>`
  // (i.e. it does NOT strip "my-rules" in this case — the source is left
  // prepended with "rules/" verbatim).
  assert.equal(normalizePublishDest("my-rules/foo.md"), "rules/my-rules/foo.md");
});

test("normalizePublishDest: no allowlist found → rules/<segs>", () => {
  assert.equal(normalizePublishDest("hello.md"), "rules/hello.md");
  assert.equal(normalizePublishDest("a/b/c.md"), "rules/a/b/c.md");
});

test("normalizePublishDest: falsy source → returned as-is", () => {
  assert.equal(normalizePublishDest(""), "");
  assert.equal(normalizePublishDest(null), null);
  assert.equal(normalizePublishDest(undefined), undefined);
});

// ─── teamVerify: missing manifest → exitCode 2 ───────────────────────────────

test("teamVerify: missing manifest → exitCode = 2", () => {
  const root = mkRoot();
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    teamVerify(makeCtx(["team", "verify"], {}, root));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

// ─── teamInstall: missing manifest → exitCode 2 ──────────────────────────────

test("teamInstall: missing manifest → exitCode = 2", async () => {
  const root = mkRoot();
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamInstall(makeCtx(["team", "install"], {}, root));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

// ─── teamUpdate is a thin alias for teamInstall ──────────────────────────────

test("teamUpdate: missing manifest → exitCode = 2 (delegates to teamInstall)", async () => {
  const root = mkRoot();
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamUpdate(makeCtx(["team", "update"], {}, root));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

// ─── teamPublish: missing --paths → exitCode 2 ───────────────────────────────

test("teamPublish: missing --paths → exitCode = 2", () => {
  const root = mkRoot();
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    teamPublish(makeCtx(["team", "publish"], {}, root));
    assert.equal(process.exitCode, 2);
  } finally {
    restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
});

// ─── teamStatus: freshly initialised project → single-line summary ───────────

test("teamStatus: freshly initialised project → single-line summary", () => {
  const root = mkRoot();
  // Initialise the pack.
  const teamPack = require("../../lib/team-pack/index.js");
  teamPack.initSkeleton(root, "demo-pack");
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    teamStatus(makeCtx(["team", "status"], {}, root));
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  assert.match(out, /Pack: demo-pack/);
  assert.match(out, /Files declared:/);
});

// ─── teamStatus with --json → emits valid JSON ────────────────────────────────

test("teamStatus: --json → emits valid JSON with schema_version=1", () => {
  const root = mkRoot();
  const teamPack = require("../../lib/team-pack/index.js");
  teamPack.initSkeleton(root, "demo-pack");
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    teamStatus(makeCtx(["team", "status"], { json: true }, root));
  } finally {
    out = restoreOut();
    restoreErr();
    process.exitCode = origExit;
  }
  const parsed = JSON.parse(out);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.pack_present, true);
  assert.equal(parsed.receipt_present, false);
});

// ─── teamInit: non-interactive default prints hint, no install ───────────────

test("teamInit: non-interactive default prints hint, no install", async () => {
  const root = mkRoot();
  // Make sure stdin is non-TTY for this test.
  const origIsTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  const { restore: restoreOut } = captureStdout();
  const { restore: restoreErr } = captureStderr();
  const origExit = process.exitCode;
  process.exitCode = undefined;
  let out;
  try {
    await teamInit(makeCtx(["team", "init"], {}, root));
  } finally {
    out = restoreOut();
    restoreErr();
    Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    process.exitCode = origExit;
  }
  assert.match(out, /Created/);
  // Hint should mention --team
  assert.match(out, /--team/);
  // .agent-shared/manifest should now exist
  assert.equal(fs.existsSync(path.join(root, ".agent-shared", "team-pack.json")), true);
});

// ─── teamResolveProject: respects options.project ────────────────────────────

test("teamResolveProject: respects options.project", () => {
  const cwd = "/tmp/seed";
  assert.equal(teamResolveProject({ options: { project: "sub" }, cwd }), path.resolve(cwd, "sub"));
  assert.equal(teamResolveProject({ options: {}, cwd }), cwd);
});

// ─── applyPlanToProject + writeConflictArtifact (smoke) ──────────────────────

test("applyPlanToProject + writeConflictArtifact: empty plan returns empty applied/conflicts", () => {
  const project = mkRoot();
  // An empty plan with no items.
  const emptyPlan = { items: [] };
  const result = applyPlanToProject(project, { name: "x", version: "0.0.0" }, emptyPlan);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.conflicts, []);
});

test("writeConflictArtifact: empty conflicts → returns null, no file written", () => {
  const project = mkRoot();
  const result = writeConflictArtifact(project, []);
  assert.equal(result, null);
});
