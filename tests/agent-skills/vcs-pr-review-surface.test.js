"use strict";

// Regression coverage for the vcs-pr review surface at the CLI layer.
//
// The backend cases (github.test.js) pin the HTTP routing.  These cases pin
// the contract the CLI adds on top of it, because each of those rules
// exists to stop a specific silent failure:
//
//   * `comment` / `review` publish to a pull request other people read, so
//     they require `--gate user`.  A missing gate must fail *before* any
//     network call, not after a comment is already posted.
//   * A backend that does not implement an operation must report
//     `capability_unavailable`.  Returning an empty list instead would tell
//     a caller "this PR has no comments and no reviews" — a claim the
//     backend never verified.
//   * An invalid review event and a missing body must fail on their own
//     terms, so the caller learns which input was wrong.
//
// The fixture supplies a stub secrets skill: `vcs-pr` resolves its token
// through that skill, and the point of these cases is the CLI's own
// validation, not the secrets machinery.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { describe, test } = require("node:test");

const SCRIPT = path.resolve(
  __dirname,
  "../../templates/en/.agent/skills/vcs-pr/scripts/index.js"
);

const STUB_SECRETS = `"use strict";
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ ok: true, value: "stub-token" }) + "\\n");
`;

function makeProject(backend) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-vcspr-review-"));
  const configDir = path.join(root, ".agent", "config");
  const secretsDir = path.join(root, ".agent", "skills", "secrets", "scripts");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(secretsDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "vcs.yml"),
    `backend: ${backend}\nhost: "http://127.0.0.1:9"\ntoken_ref: gh-test\ndefault:\n  org: kucell\n  repo: cortex-agent\n`
  );
  fs.writeFileSync(path.join(secretsDir, "index.js"), STUB_SECRETS);
  return root;
}

function run(root, args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, payload: JSON.parse(stdout) };
  } catch (err) {
    const stdout = err.stdout || "";
    let payload = null;
    try { payload = JSON.parse(stdout); } catch (_) { /* keep null */ }
    return { code: err.status, payload };
  }
}

describe("vcs-pr review surface CLI", () => {
  test("comment requires --gate user and fails before touching the network", () => {
    const root = makeProject("github");
    const result = run(root, ["comment", "--pr-number", "42", "--body", "x"]);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, "workflow_gate_required");
    assert.match(result.payload.message, /comment requires --gate user/);
  });

  test("review requires --gate user", () => {
    const root = makeProject("github");
    const result = run(root, ["review", "--pr-number", "42", "--body", "x"]);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, "workflow_gate_required");
    assert.match(result.payload.message, /review requires --gate user/);
  });

  test("an unknown review event is rejected with its own error", () => {
    const root = makeProject("github");
    const result = run(root, [
      "review", "--pr-number", "42", "--body", "x", "--event", "BOGUS", "--gate", "user",
    ]);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, "invalid_review_event");
  });

  test("a missing review body is rejected with its own error", () => {
    const root = makeProject("github");
    const result = run(root, ["comment", "--pr-number", "42", "--gate", "user"]);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, "missing_review_body");
  });

  test("a backend without the operation reports capability_unavailable, not empty", () => {
    const root = makeProject("gitea");
    for (const command of ["diff", "comments", "reviews", "comment", "review"]) {
      const result = run(root, [command, "--pr-number", "42", "--body", "x", "--gate", "user"]);
      assert.equal(result.payload.ok, false, `${command} should not succeed`);
      assert.equal(result.payload.error, "capability_unavailable", `${command} should report the missing capability`);
      assert.match(result.payload.message, /gitea backend does not support/);
    }
  });

  test("read commands reach the network layer on any allowed gate", () => {
    const root = makeProject("github");
    // The host is a closed port, so a read command that got past its own
    // validation fails at connect time — which is exactly the proof we want:
    // it was not rejected by the gate.
    const result = run(root, ["diff", "--pr-number", "42", "--gate", "agent"]);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.error, "orchestrator_error");
    assert.match(result.payload.message, /ECONNREFUSED/);
  });
});
