"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createAgentSandbox } = require("../helpers/agent-sandbox");

const SCRIPT = path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "skills", "friction", "scripts", "share-learnings.js");
const SCORE_SCRIPT = path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "skills", "friction", "scripts", "friction-score.js");

function run(args, opts) {
  return execFileSync(process.execPath, [SCRIPT].concat(args), Object.assign({ encoding: "utf8" }, opts || {}));
}

// The draft lands under .agent/runtime-evidence/friction/drafts/ — see
// .agent/rules/runtime-artifacts-location.md. That means the suite must run
// against a sandboxed project root: writing into the real .agent/ would leave
// debris in the developer's working copy and trip the hermetic gate.
let sandbox = null;
let ROOT = "";
let DRAFT_DIR = "";

test.before(() => {
  sandbox = createAgentSandbox({ git: false });
  ROOT = sandbox.root;
  DRAFT_DIR = path.join(ROOT, ".agent", "runtime-evidence", "friction", "drafts");
});

test.after(() => {
  if (sandbox) sandbox.cleanup();
});

// share-learnings writes .agent/runtime-evidence/friction/drafts/exp-<session-id>-draft.md.
// Every case must own its session id, otherwise two concurrent runs (parallel
// workers, a local run next to CI) write to the same file and the suite fails
// for reasons that have nothing to do with the code.
function uniqueSessionId(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function draftPathFor(sessionId) {
  return path.join(
    DRAFT_DIR,
    "exp-" + sessionId.replace(/[^A-Za-z0-9._-]/g, "_") + "-draft.md"
  );
}

function runInSandbox(args, opts) {
  return run(args, Object.assign({ cwd: ROOT }, opts || {}));
}

test("share-learnings without --confirm refuses and creates no draft", () => {
  const sessionId = uniqueSessionId("S-refuse");
  const draft = draftPathFor(sessionId);
  try {
    fs.unlinkSync(draft);
  } catch (_) { /* ignore */ }
  let threw = null;
  try {
    runInSandbox(["--session", sessionId, "--title", "Demo"]);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "must exit non-zero without --confirm");
  assert.ok(!fs.existsSync(draft), "no draft created without confirmation");
});

test("share-learnings with --confirm writes the draft and prints a diff", () => {
  const sessionId = uniqueSessionId("S-confirm-ok");
  const draft = draftPathFor(sessionId);
  try {
    const out = runInSandbox(["--session", sessionId, "--title", "Retry lesson", "--confirm"]);
    assert.ok(out.includes("diff --git"));
    assert.ok(out.includes("+"));
    assert.ok(fs.existsSync(draft), "draft created after confirmation");
    const content = fs.readFileSync(draft, "utf8");
    assert.ok(content.includes("# Retry lesson"));
    assert.ok(content.includes("status: draft (human review required)"));
  } finally {
    fs.rmSync(draft, { force: true });
  }
});

test("share-learnings with --body includes the body text", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-share-"));
  const bodyPath = path.join(tmp, "body.md");
  fs.writeFileSync(bodyPath, "After three retries, switch to a fresh context.", "utf8");
  const sessionId = uniqueSessionId("S-body-ok");
  const draft = draftPathFor(sessionId);
  try {
    const out = runInSandbox(["--session", sessionId, "--title", "T", "--body", bodyPath, "--confirm"]);
    assert.ok(out.includes("After three retries"));
    assert.ok(fs.readFileSync(draft, "utf8").includes("After three retries"));
  } finally {
    fs.rmSync(draft, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("friction-score CLI prints assessment with coverage and never implies zero friction", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-score-cli-"));
  const out = execFileSync(process.execPath, [SCORE_SCRIPT, "--project", tmp, "--host-matrix", "pi"], { encoding: "utf8" });
  const a = JSON.parse(out);
  assert.equal(a.score, 0);
  assert.equal(a.recommendation, "none");
  assert.equal(a.coverage.not_supported.length, 6);
  assert.equal(a.coverage.absent.length, 0);
});
