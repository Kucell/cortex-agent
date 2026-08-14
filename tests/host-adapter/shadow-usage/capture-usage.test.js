"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "capture-usage.js");
const LEDGER_DIR = ".agent/token-attempts";

function runCapture(envelope, extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: ROOT,
    input: JSON.stringify(envelope),
    encoding: "utf8",
  });
}

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-capture-usage-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  return root;
}

// ─── TC-001: valid envelope writes a MS-001 receipt with reported usage ──────
test("TC-001: valid envelope writes a receipt with host-reported usage", () => {
  const root = tempProject();
  const env = { ...process.env, CORTEX_PROJECT_ROOT: root };
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    env,
    input: JSON.stringify({
      host: "codex",
      attempt_id: "real-001",
      model: "qwen3.8-max",
      task_id: "T-001",
      run_id: "R-001",
      usage: { input_tokens: 56000, output_tokens: 470, cache_read_input_tokens: 12000 },
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.duplicate, false);
  assert.equal(out.receipt.status, "host_reported");
  assert.equal(out.receipt.usage.input_tokens, 56000);
  assert.equal(out.receipt.usage.output_tokens, 470);
  assert.equal(out.receipt.usage.cache_read_input_tokens, 12000);
});

// ─── TC-002: test-prefixed attempts are excluded, never written ─────────────
test("TC-002: test-prefixed attempt is excluded with reason", () => {
  const result = runCapture({
    host: "codex",
    attempt_id: "test-verify-001",
    usage: { input_tokens: 1 },
  });
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.excluded, true);
  assert.equal(out.exclusion_reason, "test_attempt");
});

// ─── TC-003: missing required fields fail closed ────────────────────────────
test("TC-003: missing attempt_id fails closed", () => {
  const result = runCapture({ host: "codex", usage: { input_tokens: 1 } });
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, "attempt_id_required");
});

// ─── TC-004: replay is idempotent (no double counting) ──────────────────────
test("TC-004: replaying the same envelope is idempotent", () => {
  const root = tempProject();
  const env = { ...process.env, CORTEX_PROJECT_ROOT: root };
  const envelope = {
    host: "codex",
    attempt_id: "real-002",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  const first = spawnSync(process.execPath, [SCRIPT], { cwd: root, env, input: JSON.stringify(envelope), encoding: "utf8" });
  const second = spawnSync(process.execPath, [SCRIPT], { cwd: root, env, input: JSON.stringify(envelope), encoding: "utf8" });
  const firstOut = JSON.parse(first.stdout);
  const secondOut = JSON.parse(second.stdout);
  assert.equal(firstOut.ok, true);
  assert.equal(firstOut.duplicate, false);
  assert.equal(secondOut.ok, true);
  assert.equal(secondOut.duplicate, true);
});

// ─── TC-005: dry-run validates without writing ──────────────────────────────
test("TC-005: dry-run reports validity without writing a receipt", () => {
  const result = runCapture(
    { host: "codex", attempt_id: "real-003", usage: { input_tokens: 1 } },
    ["--dry-run"],
  );
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.dry_run, true);
});
