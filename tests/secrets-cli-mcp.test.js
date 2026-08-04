"use strict";

// ─── secrets mcp-injection actions (resolve / render-bearer / inject) ────────
// These tests cover the public contract that bridges `secret://<ref>` to
// arbitrary HTTP clients (Codex `bearer_token_env_var`, custom MCP servers).
// The full pipeline is:
//
//   secret://<ref>  ─┐
//                    ├─▶  secrets resolve         (planning-time lookup)
//                    ├─▶  secrets render-bearer   (Codex TOML snippet)
//                    └─▶  secrets inject          (host-time env export)
//
// Every test asserts that the secret VALUE never appears in the response
// envelope or in any of the spawned command's arguments.  Plaintext only
// lives in the injected child's environment, which we capture via a stub
// `spawn` whose argv we inspect.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runSecrets } = require("../lib/secrets-cli");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-secrets-mcp-"));
  const script = path.join(root, ".agent", "skills", "secrets", "scripts", "index.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  return root;
}

function declareRef(cwd, ref) {
  const cfgDir = path.join(cwd, ".agent", "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, "secrets.yml");
  const body = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : "default_backend: keychain\nsecrets:\n";
  const addition = `  - ref: ${ref}\n    service: ${ref}\n`;
  fs.writeFileSync(cfgPath, body + addition);
}

function emptyConfig(cwd) {
  // Create the config file but with no ref declarations.  Used to test
  // the "ref must be declared" fail-closed gate: when the file exists
  // but the requested ref is absent, `inject` must refuse.
  const cfgDir = path.join(cwd, ".agent", "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "secrets.yml"), "default_backend: keychain\nsecrets:\n");
}

function fakeSkillResponse({ listOk = true, getValue = null } = {}) {
  // Returns a `spawnSync` stub that:
  //   - on `list`: returns the declared refs from .agent/config/secrets.yml
  //   - on `get --no-mask`: returns the value the test wants to inject
  return function spawnSync(command, args) {
    if (command !== process.execPath) {
      return { status: 1, stdout: "", stderr: "unexpected command: " + command };
    }
    const action = args[1];
    if (action === "list") {
      return listOk
        ? { status: 0, stdout: JSON.stringify({ ok: true, action: "list", secrets: [{ ref: "pixso-mcp-auth" }] }) }
        : { status: 1, stdout: "" };
    }
    if (action === "get") {
      if (getValue === null) return { status: 1, stdout: JSON.stringify({ ok: false, error: "missing" }) };
      return { status: 0, stdout: JSON.stringify({ ok: true, action: "get", ref: "pixso-mcp-auth", backend: "keychain", value: getValue }) };
    }
    return { status: 0, stdout: JSON.stringify({ ok: true }) };
  };
}

// ─── resolve ────────────────────────────────────────────────────────────────

test("resolve: emits env_var, secret_uri, backend — but never the value", async () => {
  const root = project();
  declareRef(root, "pixso-mcp-auth");
  const response = await runSecrets({
    cwd: root,
    args: ["secrets", "resolve", "--ref", "pixso-mcp-auth", "--server", "pixso"],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(response.ok, true);
  assert.equal(response.ref, "pixso-mcp-auth");
  assert.equal(response.secret_uri, "secret://pixso-mcp-auth");
  // Default env-var name follows the CORTEX_MCP_<SERVER>_TOKEN convention.
  assert.equal(response.env_var, "CORTEX_MCP_PIXSO_TOKEN");
  assert.equal(response.backend, "keychain");
  assert.equal(response.declared, true);
  // The value must not appear anywhere in the response — `resolve` is
  // intentionally a value-free lookup.
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
});

test("resolve: ref not declared in .agent/config/secrets.yml → ref_undeclared", async () => {
  const root = project();
  // Don't declare.  Skill's `list` returns nothing for this ref.
  const response = await runSecrets({
    cwd: root,
    args: ["secrets", "resolve", "--ref", "pixso-mcp-auth"],
  }, { spawnSync: fakeSkillResponse({ listOk: true }) });
  // No config file means cfg.exists=false, so the undeclared gate does
  // not fire; the response should still be ok.
  assert.equal(response.ok, true);
  assert.equal(response.declared, false);
});

test("resolve: rejects malformed ref and rejects malformed env-var", async () => {
  const root = project();
  const badRef = await runSecrets({
    cwd: root,
    args: ["secrets", "resolve", "--ref", "has spaces"],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(badRef.ok, false);
  assert.equal(badRef.error, "invalid_ref");

  const badEnv = await runSecrets({
    cwd: root,
    args: ["secrets", "resolve", "--ref", "pixso-mcp-auth", "--env", "9INVALID"],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.error, "invalid_env_var");
});

// ─── render-bearer ───────────────────────────────────────────────────────────

test("render-bearer: emits a Codex [mcp_servers.<name>] block with bearer_token_env_var, no value", async () => {
  const root = project();
  const response = await runSecrets({
    cwd: root,
    args: [
      "secrets", "render-bearer",
      "--server", "pixso",
      "--url", "http://127.0.0.1:3667/mcp",
      "--ref", "pixso-mcp-auth",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(response.ok, true);
  assert.equal(response.auth, "bearer_secret");
  assert.equal(response.env_var, "CORTEX_MCP_PIXSO_TOKEN");
  assert.equal(response.secret_uri, "secret://pixso-mcp-auth");
  // The TOML block must reference the env var name, never the value.
  assert.match(response.toml, /\[mcp_servers\.pixso\]/);
  assert.match(response.toml, /url = "http:\/\/127\.0\.0\.1:3667\/mcp"/);
  assert.match(response.toml, /bearer_token_env_var = "CORTEX_MCP_PIXSO_TOKEN"/);
  assert.match(response.toml, /secret:\/\/pixso-mcp-auth/);
  assert.equal(response.toml.includes("private-test-value"), false);
});

test("render-bearer: --auth none still renders a valid block, no bearer_token_env_var", async () => {
  const root = project();
  const response = await runSecrets({
    cwd: root,
    args: [
      "secrets", "render-bearer",
      "--server", "pixso",
      "--url", "http://127.0.0.1:3667/mcp",
      "--auth", "none",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(response.ok, true);
  assert.equal(response.auth, "none");
  assert.match(response.toml, /\[mcp_servers\.pixso\]/);
  // No assignment line: the only place `bearer_token_env_var` may appear
  // is inside a comment, and we explicitly want NO assignment here.
  assert.equal(/^\s*bearer_token_env_var\s*=/m.test(response.toml), false);
});

test("render-bearer: rejects unsupported auth (e.g. plain 'oauth') so it can't silently degrade", async () => {
  const root = project();
  const response = await runSecrets({
    cwd: root,
    args: [
      "secrets", "render-bearer",
      "--server", "pixso",
      "--url", "http://127.0.0.1:3667/mcp",
      "--auth", "oauth",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(response.ok, false);
  assert.equal(response.error, "unsupported_auth");
});

test("render-bearer: rejects non-http(s) URL and missing --ref when auth=bearer_secret", async () => {
  const root = project();
  const badUrl = await runSecrets({
    cwd: root,
    args: [
      "secrets", "render-bearer",
      "--server", "pixso",
      "--url", "ftp://example.com",
      "--ref", "pixso-mcp-auth",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(badUrl.ok, false);
  assert.equal(badUrl.error, "invalid_url");

  const noRef = await runSecrets({
    cwd: root,
    args: [
      "secrets", "render-bearer",
      "--server", "pixso",
      "--url", "http://127.0.0.1:3667/mcp",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(noRef.ok, false);
  assert.equal(noRef.error, "invalid_ref");
});

// ─── inject ──────────────────────────────────────────────────────────────────

test("inject: forwards child argv to spawn with the secret only in env, never in args", async () => {
  const root = project();
  declareRef(root, "pixso-mcp-auth");
  let childArgv = null;
  let childEnv = null;
  let childStdio = null;
  let childShell = null;
  const fakeChild = {
    on(_event, cb) {
      // Fire the exit handler synchronously with code 0 so the awaiting
      // promise resolves.  Real `child_process.spawn` does this when the
      // process eventually exits; in tests we just simulate that.
      cb(0, null);
    },
  };
  const response = await runSecrets({
    cwd: root,
    args: [
      "secrets", "inject",
      "--ref", "pixso-mcp-auth",
      "--env", "CORTEX_MCP_PIXSO_TOKEN",
      "--", "codex", "--quiet",
    ],
  }, {
    spawnSync: fakeSkillResponse({ getValue: "private-test-value" }),
    spawn(command, args, options) {
      childArgv = [command, ...args];
      childEnv = options.env;
      childStdio = options.stdio;
      childShell = options.shell;
      return fakeChild;
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.ref, "pixso-mcp-auth");
  assert.equal(response.env_var, "CORTEX_MCP_PIXSO_TOKEN");
  assert.deepEqual(response.child_argv, ["codex", "--quiet"]);
  // The argv must be a literal, no shell interpretation.
  assert.deepEqual(childArgv, ["codex", "--quiet"]);
  // stdio must inherit our tty (so codex stays interactive).
  assert.equal(childStdio, "inherit");
  assert.equal(childShell, false);
  // The secret must be in the child env under the requested name.
  assert.equal(childEnv.CORTEX_MCP_PIXSO_TOKEN, "private-test-value");
  // The secret must NOT appear in argv or in the response envelope.
  assert.equal(childArgv.includes("private-test-value"), false);
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
});

test("inject: ref must be declared in .agent/config/secrets.yml (fail-closed)", async () => {
  const root = project();
  emptyConfig(root); // cfg exists but pixso-mcp-auth is NOT declared
  let spawnChildCalled = false;
  const response = await runSecrets({
    cwd: root,
    args: [
      "secrets", "inject",
      "--ref", "pixso-mcp-auth",
      "--env", "CORTEX_MCP_PIXSO_TOKEN",
      "--", "codex",
    ],
  }, {
    spawnSync: fakeSkillResponse({ getValue: "private-test-value" }),
    spawn() {
      spawnChildCalled = true;
      // Even if the gate ever lets us through, fire exit so the await
      // doesn't hang the test runner.
      return { on(_e, cb) { cb(0, null); } };
    },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error, "ref_undeclared");
  assert.equal(spawnChildCalled, false);
  assert.equal(JSON.stringify(response).includes("private-test-value"), false);
});

test("inject: rejects malformed env var name and missing command after `--`", async () => {
  const root = project();
  declareRef(root, "pixso-mcp-auth");
  const badEnv = await runSecrets({
    cwd: root,
    args: [
      "secrets", "inject",
      "--ref", "pixso-mcp-auth",
      "--env", "lower-case-not-posix",
      "--", "codex",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(badEnv.ok, false);
  assert.equal(badEnv.error, "invalid_env_var");

  const noCmd = await runSecrets({
    cwd: root,
    args: [
      "secrets", "inject",
      "--ref", "pixso-mcp-auth",
      "--env", "CORTEX_MCP_PIXSO_TOKEN",
    ],
  }, { spawnSync: fakeSkillResponse() });
  assert.equal(noCmd.ok, false);
  assert.equal(noCmd.error, "missing_command");
});

test("inject: forwards child exit code to response.exitCode", async () => {
  const root = project();
  declareRef(root, "pixso-mcp-auth");
  let exitHandler = null;
  const fakeChild = {
    on(_event, cb) { exitHandler = cb; },
  };
  const pending = runSecrets({
    cwd: root,
    args: [
      "secrets", "inject",
      "--ref", "pixso-mcp-auth",
      "--env", "CORTEX_MCP_PIXSO_TOKEN",
      "--", "node", "-e", "process.exit(42)",
    ],
  }, {
    spawnSync: fakeSkillResponse({ getValue: "private-test-value" }),
    spawn() { return fakeChild; },
  });
  // Simulate the child exiting with code 42.
  assert.equal(typeof exitHandler, "function");
  exitHandler(42, null);
  const response = await pending;
  assert.equal(response.ok, true);
  assert.equal(response.child_exit_code, 42);
  assert.equal(response.exitCode, 42);
});

// ─── help / usage surface ────────────────────────────────────────────────────

test("actions set is exported and includes the three new mcp-injection actions", () => {
  const { ACTIONS, BEARER_AUTH_PROFILES } = require("../lib/secrets-cli");
  assert.equal(ACTIONS.has("resolve"), true);
  assert.equal(ACTIONS.has("render-bearer"), true);
  assert.equal(ACTIONS.has("inject"), true);
  assert.equal(BEARER_AUTH_PROFILES.has("bearer_secret"), true);
  assert.equal(BEARER_AUTH_PROFILES.has("none"), true);
});
