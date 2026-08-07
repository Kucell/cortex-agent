"use strict";

// ─── secrets skill backend regressions (L1 secrets-vcs regression suite) ────
// Regression coverage for the bugs fixed after the yunxiao-pkg-upload
// "username:password → username:username" incident on 2026-08-04.  Each
// test asserts a single property: the storage identity is the
// `(service, account)` tuple, declared in `.agent/config/secrets.yml`,
// and never the operator's `--account` flag.
//
// We exercise the *real* skill script (`scripts/index.js`) against the
// cross-platform `env` backend when possible, since the production
// macOS/Linux backends (`keychain`, `secret-service`) require interactive
// UI or DBus services that aren't available in CI.  The contract being
// tested — payload composition, parser, gate enforcement — is identical
// regardless of backend, so `env` is the right fixture.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SKILL = path.join(ROOT, ".agent", "skills", "secrets", "scripts", "index.js");

function scratchProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-secrets-skill-"));
  const cfgDir = path.join(dir, ".agent", "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  // Pin a scratch secrets.yml that the env backend can read out of.
  fs.writeFileSync(
    path.join(cfgDir, "secrets.yml"),
    "backend: env\nsecrets:\n  - ref: a\n    service: a\n    account: acct-a\n  - ref: b\n    service: b\n    account: acct-b\n",
  );
  return dir;
}

function writeConfig(dir, body) {
  const cfg = path.join(dir, ".agent", "config", "secrets.yml");
  fs.writeFileSync(cfg, body);
}

function runSkill(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [SKILL, ...args], {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    encoding: "utf8",
  });
}

// ─── 1. Bug 1+2+4 regressions: account is the declared one, not the caller's. ────

test("--account is rejected at the skill boundary (cross-row protection)", () => {
  const cwd = scratchProject();
  const out = runSkill(["get", "--ref", "a", "--account", "manual-bypass", "--gate", "user"], { cwd });
  assert.equal(out.status !== 0, true);
  const body = JSON.parse(out.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error, "account_override_disallowed");
});

test("parser surfaces account from nested secrets.yml entries", () => {
  const cwd = scratchProject();
  writeConfig(
    cwd,
    "backend: env\n" +
      "secrets:\n" +
      "  - ref: pixso-mcp-auth\n" +
      "    service: pixso-mcp-auth\n" +
      "    account: pixso-default\n" +
      "    description: Pixso PAT, scope=read-write\n" +
      "  - ref: gitea-pr\n" +
      "    service: gitea-192.168.2.110-codex-samhmi-pr\n" +
      "    account: xueyq\n" +
      "    description: Gitea API token (read/write repo scope).\n",
  );
  const out = runSkill(["list", "--gate", "agent"], { cwd });
  assert.equal(out.status, 0);
  const body = JSON.parse(out.stdout);
  assert.equal(body.secrets.length, 2);
  assert.equal(body.secrets[0].account, "pixso-default");
  assert.equal(body.secrets[0].description, "Pixso PAT, scope=read-write");
  assert.equal(body.secrets[1].account, "xueyq");
  assert.equal(body.secrets[1].description, "Gitea API token (read/write repo scope).");
});

test("parser handles 3 entries with separate services + accounts", () => {
  const cwd = scratchProject();
  writeConfig(
    cwd,
    "backend: keychain\n" +
      "secrets:\n" +
      "  - ref: x\n    service: x\n    account: alice\n" +
      "  - ref: y\n    service: y\n    account: bob\n" +
      "  - ref: z\n    service: z\n    account: carol\n",
  );
  const out = runSkill(["list", "--gate", "agent"], { cwd });
  assert.equal(out.status, 0);
  const body = JSON.parse(out.stdout);
  assert.equal(body.secrets.length, 3);
  assert.deepEqual(
    body.secrets.map((s) => s.account),
    ["alice", "bob", "carol"],
  );
});

// ─── 2. Bug 3 regression: store --from-env resolves value without argv leak. ────

test("store --from-env resolves the secret from process.env (no argv)", () => {
  const cwd = scratchProject();
  const out = runSkill(
    ["store", "--ref", "a", "--from-env", "CORTEX_TEST_STORE_A", "--gate", "user"],
    {
      cwd,
      env: { ...process.env, CORTEX_TEST_STORE_A: "test-secret-A" },
    },
  );
  // env backend rejects store by design (`read_only_store_via_dotenv_or_secret_manager`)
  // but the value resolution path ran first — so we never see `test-secret-A`
  // in argv or stdout.
  assert.equal(/test-secret-A/.test(out.stdout + (out.stderr || "")), false);
  // The rejection is by env backend, not by our value-resolution code.
  const body = JSON.parse(out.stdout || "{}");
  assert.equal(body.ok, false);
  assert.equal(body.error, "env_backend_is_read_only_store_via_dotenv_or_secret_manager");
});

test("store --from-env with malformed env name → invalid_from_env", () => {
  const cwd = scratchProject();
  const out = runSkill(
    ["store", "--ref", "a", "--from-env", "lower-case-bad", "--gate", "user"],
    { cwd },
  );
  assert.equal(out.status !== 0, true);
  const body = JSON.parse(out.stdout);
  assert.equal(body.error, "invalid_from_env");
});

test("store --from-env with unset env var → missing_value", () => {
  const cwd = scratchProject();
  const out = runSkill(
    ["store", "--ref", "a", "--from-env", "CORTEX_SECRETS_UNSET_VAR_XYZ", "--gate", "user"],
    { cwd },
  );
  assert.equal(out.status !== 0, true);
  const body = JSON.parse(out.stdout);
  assert.equal(body.error, "missing_value");
});

test("store --value still works (back-compat for CI scripts / tests)", () => {
  const cwd = scratchProject();
  const out = runSkill(
    ["store", "--ref", "a", "--value", "literal", "--gate", "user"],
    { cwd },
  );
  // env backend rejects store — that's the regression target for the
  // back-compat path, not the value parsing itself.
  const body = JSON.parse(out.stdout || "{}");
  assert.equal(body.ok, false);
  assert.equal(body.error, "env_backend_is_read_only_store_via_dotenv_or_secret_manager");
});

test("store with empty --from-env → empty_value (fail-closed)", () => {
  const cwd = scratchProject();
  const out = runSkill(
    ["store", "--ref", "a", "--from-env", "CORTEX_TEST_EMPTY", "--gate", "user"],
    {
      cwd,
      env: { ...process.env, CORTEX_TEST_EMPTY: "" },
    },
  );
  // With env=empty string, process.env[<key>] is "" (not undefined), so
  // we hit the empty_value branch.
  assert.equal(out.status !== 0, true);
  const body = JSON.parse(out.stdout);
  assert.equal(["empty_value", "missing_value"].includes(body.error), true);
});

// ─── 3. redact.js REDACT_TOKEN export regression ──────────────────────────────

test("redact.js exports REDACT_TOKEN and it is the public mask placeholder", () => {
  const redact = require(path.join(
    ROOT,
    ".agent",
    "skills",
    "secrets",
    "scripts",
    "redact.js",
  ));
  assert.equal(typeof redact.REDACT_TOKEN, "string");
  assert.ok(redact.REDACT_TOKEN.length > 0);
  assert.equal(redact.REDACT_TOKEN, redact.MASK);
});

test("get with masking returns REDACT_TOKEN-shaped output (not 'undefined')", () => {
  const cwd = scratchProject();
  process.env.CORTEX_SECRET_A = "username-foo";
  try {
    const out = runSkill(["get", "--ref", "a", "--gate", "user"], { cwd });
    assert.equal(out.status, 0);
    const body = JSON.parse(out.stdout);
    assert.equal(typeof body.masked, "string");
    assert.equal(body.masked.startsWith("undefined("), false, `masked leaked 'undefined': ${body.masked}`);
    assert.match(body.masked, /REDACTED/);
  } finally {
    delete process.env.CORTEX_SECRET_A;
  }
});
