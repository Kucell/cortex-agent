"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "skills", "friction", "scripts", "share-learnings.js");
const SCORE_SCRIPT = path.join(__dirname, "..", "..", "templates", "_shared", ".agent", "skills", "friction", "scripts", "friction-score.js");

function run(args, opts) {
  return execFileSync(process.execPath, [SCRIPT].concat(args), Object.assign({ encoding: "utf8" }, opts || {}));
}

test("share-learnings without --confirm refuses and creates no /tmp file", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-share-"));
  const sessionId = "S-refuse-" + path.basename(tmp);
  const draft = path.join(os.tmpdir(), "exp-" + sessionId.replace(/[^A-Za-z0-9._-]/g, "_") + "-draft.md");
  try {
    fs.unlinkSync(draft);
  } catch (_) { /* ignore */ }
  let threw = null;
  try {
    run(["--session", sessionId, "--title", "Demo"]);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, "must exit non-zero without --confirm");
  assert.ok(!fs.existsSync(draft), "no draft created without confirmation");
});

test("share-learnings with --confirm writes the draft and prints a diff", () => {
  const sessionId = "S-confirm-ok";
  const out = run(["--session", sessionId, "--title", "Retry lesson", "--confirm"]);
  assert.ok(out.includes("diff --git"));
  assert.ok(out.includes("+"));
  const draft = path.join(os.tmpdir(), "exp-" + sessionId + "-draft.md");
  assert.ok(fs.existsSync(draft), "draft created after confirmation");
  const content = fs.readFileSync(draft, "utf8");
  assert.ok(content.includes("# Retry lesson"));
  assert.ok(content.includes("status: draft (human review required)"));
});

test("share-learnings with --body includes the body text", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fr-share-"));
  const bodyPath = path.join(tmp, "body.md");
  fs.writeFileSync(bodyPath, "After three retries, switch to a fresh context.", "utf8");
  const sessionId = "S-body-ok";
  const out = run(["--session", sessionId, "--title", "T", "--body", bodyPath, "--confirm"]);
  assert.ok(out.includes("After three retries"));
  const draft = path.join(os.tmpdir(), "exp-" + sessionId + "-draft.md");
  assert.ok(fs.readFileSync(draft, "utf8").includes("After three retries"));
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
