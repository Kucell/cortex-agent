"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runSecrets } = require("../../lib/secrets/cli.js");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-secrets-cli-"));
  const script = path.join(root, ".agent", "skills", "secrets", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  return root;
}

test("store requires an environment reference and never accepts --value", async () => {
  const response = await runSecrets({
    cwd: project(),
    args: ["secrets", "store", "--ref", "npm-publish", "--value", "forbidden"],
  });
  assert.equal(response.ok, false);
  assert.equal(response.error, "secure_input_required");
});

test("store delegates the secret through env, never through argv", async () => {
  // After Bug 3 (--from-env at the skill level), the public CLI
  // forwards the env-var NAME to the child skill.  The actual secret
  // value lives in the child's process environment, which it inherits
  // from this parent via `spawn(... , { env: process.env })` by default.
  // This is what guarantees the value never enters shell history or
  // `ps` output.
  const root = project();
  const npmTestValue = "private-test-value";
  process.env.CORTEX_TEST_NPM_TOKEN = npmTestValue;
  let observed;
  console.log("[test-debug] before runSecrets");
  const response = await runSecrets({
    cwd: root,
    args: ["secrets", "store", "--ref", "npm-publish", "--from-env", "CORTEX_TEST_NPM_TOKEN"],
  }, {
    spawnSync(command, args, options) {
      console.log("[test-debug] stub called", { command, args, options: Object.keys(options || {}) });
      observed = { command, args, options };
      return { status: 0, stdout: JSON.stringify({ ok: true }) };
    },
  });
  delete process.env.CORTEX_TEST_NPM_TOKEN;
  assert.equal(response.ok, true);
  assert.equal(response.secret_uri, "secret://npm-publish");
  // The response envelope never carries the secret value.
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
  // The child argv NEVER carries the secret value (key contract).
  assert.equal(observed.args.includes("private-test-value"), false);
  // The child receives the env-var name and reads the value via env.
  // We assert the env-var NAME was forwarded, not the value itself.
  const nameIndex = observed.args.indexOf("--from-env");
  assert.equal(nameIndex >= 0, true, "--from-env must be forwarded to child");
  assert.equal(observed.args[nameIndex + 1], "CORTEX_TEST_NPM_TOKEN");
  // The child env must include the secret value under that key.
  assert.equal(observed.options.env.CORTEX_TEST_NPM_TOKEN, "private-test-value");
});

test("npm verify injects the resolved secret and returns identity only", async () => {
  const root = project();
  const calls = [];
  const response = await runSecrets({
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

test("provider verification failure is fail-closed and redacted", async () => {
  const response = await runSecrets({
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
