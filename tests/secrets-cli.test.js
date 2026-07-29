"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runSecrets } = require("../lib/secrets-cli");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-secrets-cli-"));
  const script = path.join(root, ".agent", "skills", "secrets", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  return root;
}

test("store requires an environment reference and never accepts --value", () => {
  const response = runSecrets({
    cwd: project(),
    args: ["secrets", "store", "--ref", "npm-publish", "--value", "forbidden"],
  });
  assert.equal(response.ok, false);
  assert.equal(response.error, "secure_input_required");
});

test("store delegates the secret without returning it", () => {
  const root = project();
  process.env.CORTEX_TEST_NPM_TOKEN = "private-test-value";
  let observed;
  const response = runSecrets({
    cwd: root,
    args: ["secrets", "store", "--ref", "npm-publish", "--from-env", "CORTEX_TEST_NPM_TOKEN"],
  }, {
    spawnSync(command, args) {
      observed = { command, args };
      return { status: 0, stdout: JSON.stringify({ ok: true }) };
    },
  });
  delete process.env.CORTEX_TEST_NPM_TOKEN;
  assert.equal(response.ok, true);
  assert.equal(response.secret_uri, "secret://npm-publish");
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
  assert.equal(observed.args.includes("private-test-value"), true);
});

test("npm verify injects the resolved secret and returns identity only", () => {
  const root = project();
  const calls = [];
  const response = runSecrets({
    cwd: root,
    args: ["secrets", "verify", "--ref", "npm-publish", "--provider", "npm"],
  }, {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      if (command === process.execPath) {
        return { status: 0, stdout: JSON.stringify({ ok: true, value: "private-test-value" }) };
      }
      return { status: 0, stdout: "kucelleric\n" };
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.identity, "kucelleric");
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
  assert.equal(calls[1].options.env["npm_config_//registry.npmjs.org/:_authToken"], "private-test-value");
});

test("provider verification failure is fail-closed and redacted", () => {
  const response = runSecrets({
    cwd: project(),
    args: ["secrets", "verify", "--ref", "npm-publish"],
  }, {
    spawnSync(command) {
      if (command === process.execPath) {
        return { status: 0, stdout: JSON.stringify({ ok: true, value: "private-test-value" }) };
      }
      return { status: 1, stdout: "", stderr: "authentication failed" };
    },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error, "provider_verification_failed");
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
});
