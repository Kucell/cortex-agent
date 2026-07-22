"use strict";

// End-to-end coverage for `management-api runs tokens` (Phase 1 of the
// token-usage contract — see proposal §3.4 and §3.3). Tests run against the
// EN L1 template copy of management-api so the dual-template parity is
// exercised (if the template lags the main repo, this fails fast).

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const MANAGEMENT = path.join(ROOT, "templates", "_shared", ".agent", "skills", "management-api", "scripts", "index.js");

function project() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tokens-"));
  fs.mkdirSync(path.join(cwd, ".agent", "runs"), { recursive: true });
  return cwd;
}
function run(cwd, args) {
  return spawnSync(process.execPath, [MANAGEMENT, ...args], { cwd, encoding: "utf8" });
}
function readRun(cwd, runId) {
  const file = path.join(cwd, ".agent", "runs", `${runId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function okPayload(result) {
  assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
  return JSON.parse(result.stdout);
}

// ─── gate + source validation ─────────────────────────────────────────────────

test("runs tokens: missing --source fails with invalid_source", () => {
  const cwd = project();
  const r1 = run(cwd, ["runs", "upsert", "--gate", "agent", "--run-id", "R-tok-1", "--kind", "implement", "--status", "running"]);
  assert.equal(r1.status, 0, JSON.parse(r1.stdout));
  const r2 = run(cwd, ["runs", "tokens", "--gate", "agent", "--run-id", "R-tok-1", "--input", "100", "--output", "10", "--cache-create", "0", "--cache-read", "0"]);
  assert.notEqual(r2.status, 0);
  const body = JSON.parse(r2.stdout);
  assert.equal(body.error, "invalid_source");
});

test("runs tokens: missing --run-id fails with run_id_required (Phase 1 guard)", () => {
  const cwd = project();
  const r = run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--input", "1", "--output", "1", "--cache-create", "0", "--cache-read", "0"]);
  assert.notEqual(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.error, "run_id_required");
});

test("runs tokens: missing --gate is rejected", () => {
  const cwd = project();
  const r1 = run(cwd, ["runs", "upsert", "--gate", "agent", "--run-id", "R-tok-gate", "--kind", "implement", "--status", "running"]);
  assert.equal(r1.status, 0);
  const r2 = run(cwd, ["runs", "tokens", "--source", "claude-code", "--run-id", "R-tok-gate", "--input", "1", "--output", "1", "--cache-create", "0", "--cache-read", "0"]);
  assert.notEqual(r2.status, 0);
});

// ─── aggregation across calls + sources ───────────────────────────────────────

test("runs tokens: aggregates by host source and computes totals", () => {
  const cwd = project();
  run(cwd, ["runs", "upsert", "--gate", "agent", "--run-id", "R-tok-agg", "--kind", "implement", "--status", "running"]);

  // First call from claude-code
  const r1 = run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--run-id", "R-tok-agg",
    "--input", "3", "--output", "573", "--cache-create", "20099", "--cache-read", "10659"]);
  const body1 = okPayload(r1);
  assert.equal(body1.action, "runs tokens");
  assert.equal(body1.source, "claude-code");
  assert.equal(body1.token_usage.input_tokens, 3);
  assert.equal(body1.totals_run.input_tokens, 3);

  // Second call from same source — should accumulate samples
  const r2 = run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--run-id", "R-tok-agg",
    "--input", "10", "--output", "20", "--cache-create", "0", "--cache-read", "1234"]);
  okPayload(r2);

  // Third call from a different source
  const r3 = run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "cursor", "--run-id", "R-tok-agg",
    "--input", "480000", "--output", "18000", "--cache-create", "90000", "--cache-read", "1200000"]);
  okPayload(r3);

  const stored = readRun(cwd, "R-tok-agg");
  // claude-code accumulated
  assert.equal(stored.token_usage.by_source["claude-code"].input_tokens, 13);  // 3 + 10
  assert.equal(stored.token_usage.by_source["claude-code"].output_tokens, 593); // 573 + 20
  assert.equal(stored.token_usage.by_source["claude-code"].cache_read_input_tokens, 11893); // 10659 + 1234
  assert.equal(stored.token_usage.by_source["claude-code"].samples, 2);
  // cursor independent
  assert.equal(stored.token_usage.by_source["cursor"].input_tokens, 480000);
  assert.equal(stored.token_usage.by_source["cursor"].samples, 1);
  // totals are sum of all hosts
  assert.equal(stored.token_usage.totals.input_tokens, 480013);
  assert.equal(stored.token_usage.totals.output_tokens, 18593);
  // events: only token_usage_reported are appended (no run_updated because upsert was earlier)
  const tokenEvents = (stored.events || []).filter((e) => e.type === "token_usage_reported");
  assert.equal(tokenEvents.length, 3);
  // source recorded in each event
  for (const ev of tokenEvents) assert.ok(ev.source, "event.source present");
});

test("runs tokens: dirty string input is normalized to integer (sink helper)", () => {
  const cwd = project();
  run(cwd, ["runs", "upsert", "--gate", "agent", "--run-id", "R-tok-dirty", "--kind", "implement", "--status", "running"]);
  // The exact shape from incident 2026-07-07 — array.toString() / concatenated fields.
  // "7,29000000" rejected by normalizer (NOT a thousand-sep) → 0.
  // "1,234" IS a clean thousand-sep → 1234.
  // "true,false" rejected by parseNumericString → 0.
  // "garbage" rejected → 0.
  const r = run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--run-id", "R-tok-dirty",
    "--input", "7,29000000", "--output", "1,234", "--cache-create", "true,false", "--cache-read", "garbage"]);
  const body = okPayload(r);
  assert.equal(body.token_usage.input_tokens, 0);          // concatenated rejected
  assert.equal(body.token_usage.output_tokens, 1234);     // clean thousand-sep honored
  assert.equal(body.token_usage.cache_creation_input_tokens, 0);  // bool string rejected
  assert.equal(body.token_usage.cache_read_input_tokens, 0);       // garbage rejected
  const stored = readRun(cwd, "R-tok-dirty");
  assert.equal(stored.token_usage.by_source["claude-code"].input_tokens, 0);
  assert.equal(stored.token_usage.by_source["claude-code"].output_tokens, 1234);
});

// ─── relations populated from --session-id / --task-id ────────────────────────

test("runs tokens: relations accumulate session_ids + task_ids idempotently", () => {
  const cwd = project();
  run(cwd, ["runs", "upsert", "--gate", "agent", "--run-id", "R-tok-rel", "--kind", "implement", "--status", "running"]);
  run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--run-id", "R-tok-rel",
    "--input", "1", "--output", "1", "--cache-create", "0", "--cache-read", "0", "--session-id", "S-1", "--task-id", "T-x"]);
  run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--run-id", "R-tok-rel",
    "--input", "2", "--output", "1", "--cache-create", "0", "--cache-read", "0", "--session-id", "S-1", "--task-id", "T-x"]);
  run(cwd, ["runs", "tokens", "--gate", "agent", "--source", "claude-code", "--run-id", "R-tok-rel",
    "--input", "3", "--output", "1", "--cache-create", "0", "--cache-read", "0", "--session-id", "S-2", "--task-id", "T-y"]);
  const stored = readRun(cwd, "R-tok-rel");
  assert.deepEqual(stored.relations.session_ids, ["S-1", "S-2"]);
  assert.deepEqual(stored.relations.task_ids, ["T-x", "T-y"]);
  // last event reflects most recent report
  assert.equal(stored.last_event.source, "claude-code");
});
