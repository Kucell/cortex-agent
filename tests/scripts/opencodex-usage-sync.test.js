"use strict";

// ─── opencodex-usage-sync tests (M-025/MS-003 Phase B backfill) ─────────────
// Focused tests for the opencodex proxy → token-attempt-ledger mapping.
// Validates:
//   1. Field mapping (inputTokens → input_tokens etc.)
//   2. Sanitization (status / null usage → skipped, not written)
//   3. Time + host filters (--since / --until / --host-filter)
//   4. Dry-run vs apply behavior
//   5. Idempotency (apply twice → identical ledger)
//   6. --limit caps writes
//   7. --json output capture
//   8. Missing source file → graceful error
//
// Each test uses a temp source file + a temp project root + temp ledger dir
// to keep the working tree's real ledger untouched.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "opencodex-usage-sync.js");

function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-opencodex-sync-"));
  fs.mkdirSync(path.join(root, ".agent"), { recursive: true });
  return root;
}

function writeFixture(root, name, lines) {
  const fixturePath = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(fixturePath, lines.join("\n") + "\n", "utf8");
  return fixturePath;
}

function runSync(extraArgs, sourcePath, projectRoot) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, HOME: projectRoot, USERPROFILE: projectRoot },
    encoding: "utf8",
  });
}

function makeRecord(overrides = {}) {
  return {
    requestId: "ocx-test-001",
    timestamp: 1_700_000_000_000, // 2023-11-14T22:13:20Z
    provider: "openai",
    model: "gpt-5.6-sol",
    conversationId: "9a27cf2cfa4a8340dbfdff0fcac3a04d",
    resolvedModel: "gpt-5.6-sol",
    requestedModel: "gpt-5.6-sol",
    status: 200,
    durationMs: 4048,
    usageStatus: "reported",
    usage: {
      inputTokens: 15886,
      outputTokens: 116,
      cachedInputTokens: 6912,
      cacheReadInputTokens: 6912,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 68,
      totalTokens: 16002,
    },
    totalTokens: 16002,
    ...overrides,
  };
}

function recordLine(...args) { return JSON.stringify(makeRecord(...args)); }

// ─── TC-001: --help prints usage ────────────────────────────────────────────
test("TC-001: --help prints usage and exits 0", () => {
  const result = runSync(["--help"], "/nonexistent", "/tmp");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: opencodex-usage-sync/);
  assert.match(result.stdout, /--apply/);
});

// ─── TC-002: dry-run reports counts without writing ─────────────────────────
test("TC-002: dry-run reports parsed/submitted counts but writes no ledger", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({ requestId: "ocx-a" }),
    recordLine({ requestId: "ocx-b", provider: "minimax-cn", resolvedModel: "minimax-cn/MiniMax-M3" }),
    recordLine({ requestId: "ocx-c", usageStatus: "unreported", usage: null }),
  ]);
  const result = runSync(["--source", source, "--project-root", root, "--dry-run"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.mode, "dry-run");
  assert.equal(out.counters.parsed, 3);
  assert.equal(out.counters.submitted, 2);
  assert.equal(out.counters.skipped, 1);
  assert.equal(out.counters.written, 0);
  assert.equal(out.counters.skipped_by_reason.usage_unreported, 1);
  assert.equal(out.by_provider.openai, 1);
  assert.equal(out.by_provider["minimax-cn"], 1);
  // Ledger must not be created on dry-run
  assert.equal(fs.existsSync(path.join(root, ".agent", "token-attempts", "ledger-index.json")), false);
});

// ─── TC-003: --apply writes to ledger with correct field mapping ────────────
test("TC-003: --apply writes canonical fields and respects field mapping", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({ requestId: "ocx-apply-1" }),
  ]);
  const result = runSync(["--source", source, "--project-root", root, "--apply"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.mode, "apply");
  assert.equal(out.counters.written, 1);
  assert.equal(out.counters.duplicates, 0);

  // Inspect the persisted receipt
  const ledgerDir = path.join(root, ".agent", "token-attempts");
  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.entries.length, 1);
  const r = index.entries[0];
  assert.equal(r.attempt_id, "ocx-apply-1");
  assert.equal(r.host, "openai");
  assert.equal(r.model, "gpt-5.6-sol");
  assert.equal(r.run_id, "9a27cf2cfa4a8340dbfdff0fcac3a04d");
  assert.equal(r.status, "host_reported");
  assert.equal(r.usage.input_tokens, 15886);
  assert.equal(r.usage.output_tokens, 116);
  assert.equal(r.usage.cache_read_input_tokens, 6912); // both cachedInputTokens + cacheReadInputTokens contributed
  assert.equal(r.usage.cache_creation_input_tokens, 0);
  // MS-001 contract requires host_reported_input_tokens mirror
  assert.equal(r.usage.host_reported_input_tokens, 15886);
  assert.equal(r.usage.host_reported_output_tokens, 116);
});

// ─── TC-004: replay is idempotent ────────────────────────────────────────────
test("TC-004: applying the same fixture twice is idempotent (no duplicate receipts)", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({ requestId: "ocx-idemp-1" }),
    recordLine({ requestId: "ocx-idemp-2" }),
  ]);
  const first = runSync(["--source", source, "--project-root", root, "--apply"], source, root);
  const second = runSync(["--source", source, "--project-root", root, "--apply"], source, root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const out1 = JSON.parse(first.stdout);
  const out2 = JSON.parse(second.stdout);
  assert.equal(out1.counters.written, 2);
  assert.equal(out2.counters.written, 0);
  assert.equal(out2.counters.duplicates, 2);
  // Ledger index should still have exactly 2 entries
  const index = JSON.parse(fs.readFileSync(path.join(root, ".agent", "token-attempts", "ledger-index.json"), "utf8"));
  assert.equal(index.entries.length, 2);
});

// ─── TC-005: --host-filter restricts providers ──────────────────────────────
test("TC-005: --host-filter restricts which providers are submitted", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({ requestId: "ocx-h1", provider: "openai" }),
    recordLine({ requestId: "ocx-h2", provider: "minimax-cn" }),
    recordLine({ requestId: "ocx-h3", provider: "deepseek" }),
  ]);
  const result = runSync(["--source", source, "--project-root", root, "--apply", "--host-filter", "openai,minimax-cn"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.written, 2);
  assert.equal(out.counters.skipped_by_reason.host_filtered, 1);
});

// ─── TC-006: --since and --until filter by time window ─────────────────────
test("TC-006: --since and --until restrict by recorded_at", () => {
  const root = tempProject();
  const records = [
    recordLine({ requestId: "ocx-t1", timestamp: 1_700_000_000_000 }), // 2023-11-14T22:13:20Z
    recordLine({ requestId: "ocx-t2", timestamp: 1_800_000_000_000 }), // 2027-07-15T02:33:20Z
    recordLine({ requestId: "ocx-t3", timestamp: 1_900_000_000_000 }), // 2030-05-22T07:13:20Z
  ];
  const source = writeFixture(root, "usage", records);
  const result = runSync([
    "--source", source,
    "--project-root", root,
    "--apply",
    "--since", "2024-01-01T00:00:00.000Z",
    "--until", "2029-01-01T00:00:00.000Z",
  ], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.written, 1);
  assert.equal(out.counters.skipped_by_reason.before_since, 1);
  assert.equal(out.counters.skipped_by_reason.after_until, 1);
});

// ─── TC-007: --limit caps writes ────────────────────────────────────────────
test("TC-007: --limit stops after N writes", () => {
  const root = tempProject();
  const records = [];
  for (let i = 0; i < 10; i += 1) {
    records.push(recordLine({ requestId: `ocx-l-${i}` }));
  }
  const source = writeFixture(root, "usage", records);
  const result = runSync(["--source", source, "--project-root", root, "--apply", "--limit", "3"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.written, 3);
  // Note: parsed counters still include the rest because the stream is destroyed
  // mid-read; we only assert the write cap.
  const index = JSON.parse(fs.readFileSync(path.join(root, ".agent", "token-attempts", "ledger-index.json"), "utf8"));
  assert.equal(index.entries.length, 3);
});

// ─── TC-008: missing source file fails closed ──────────────────────────────
test("TC-008: missing source file returns error and exits 2", () => {
  const root = tempProject();
  const result = runSync(["--source", "/nope/does-not-exist.jsonl", "--project-root", root, "--dry-run"], "/nope", root);
  assert.equal(result.status, 2);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, "source_not_found");
});

// ─── TC-009: null usage rows are skipped with empty_usage reason ────────────
test("TC-009: null usage rows are skipped (empty_usage) regardless of usageStatus", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({ requestId: "ocx-null-1", usage: null, usageStatus: "reported" }),
    recordLine({ requestId: "ocx-null-2", usage: null, usageStatus: "unreported" }),
  ]);
  const result = runSync(["--source", source, "--project-root", root, "--dry-run"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.parsed, 2);
  assert.equal(out.counters.skipped, 2);
  // First one is empty_usage (reported but no numbers), second is usage_unreported
  assert.equal(out.counters.skipped_by_reason.empty_usage, 1);
  assert.equal(out.counters.skipped_by_reason.usage_unreported, 1);
});

// ─── TC-010: malformed JSON lines are counted as parse errors ──────────────
test("TC-010: malformed JSON lines are skipped with parse_error reason", () => {
  const root = tempProject();
  const lines = [
    "{not-json",
    JSON.stringify(makeRecord({ requestId: "ocx-good" })),
    "{also-bad",
  ];
  const source = writeFixture(root, "usage", lines);
  const result = runSync(["--source", source, "--project-root", root, "--dry-run"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.counters.parsed, 1);
  assert.equal(out.counters.parse_errors, 2);
  assert.equal(out.counters.skipped_by_reason.parse_error, 2);
  assert.equal(out.counters.submitted, 1);
});

// ─── TC-011: --json writes the summary to disk ─────────────────────────────
test("TC-011: --json writes the run summary to disk and matches stdout", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [recordLine({ requestId: "ocx-json-1" })]);
  const summaryPath = path.join(root, "summary.json");
  const result = runSync(["--source", source, "--project-root", root, "--dry-run", "--json", summaryPath], source, root);
  assert.equal(result.status, 0, result.stderr);
  const onDisk = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const out = JSON.parse(result.stdout);
  assert.deepEqual(onDisk.counters, out.counters);
  assert.equal(onDisk.ok, true);
});

// ─── TC-012: security — sanitization strips non-allowlisted usage fields ───
test("TC-012: sanitization drops reasoning_output_tokens and other non-canonical fields", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({
      requestId: "ocx-extra-1",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 10,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 0,
        reasoningOutputTokens: 999, // not mapped
        totalTokens: 150,
        somePrivateField: "secret", // not mapped
      },
    }),
  ]);
  const result = runSync(["--source", source, "--project-root", root, "--apply"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(root, ".agent", "token-attempts", "ledger-index.json"), "utf8"));
  const receipt = index.entries[0];
  // Allowed canonical fields only
  assert.equal(receipt.usage.input_tokens, 100);
  assert.equal(receipt.usage.output_tokens, 50);
  assert.equal(receipt.usage.cache_read_input_tokens, 10);
  assert.equal(receipt.usage.cache_creation_input_tokens, 0);
  // No leakage of totalTokens/somePrivateField (those are sanitized away by MS-001)
  assert.equal(receipt.usage.total_tokens, undefined);
  assert.equal(receipt.usage.somePrivateField, undefined);
});

// ─── TC-013: recorded_at is preserved from the proxy timestamp ──────────────
test("TC-013: recorded_at preserves the original proxy timestamp, not the sync time", () => {
  const root = tempProject();
  const source = writeFixture(root, "usage", [
    recordLine({
      requestId: "ocx-backfill-1",
      timestamp: 1_700_000_000_000, // 2023-11-14T22:13:20Z
    }),
  ]);
  const before = Date.now();
  const result = runSync(["--source", source, "--project-root", root, "--apply"], source, root);
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(fs.readFileSync(path.join(root, ".agent", "token-attempts", "ledger-index.json"), "utf8"));
  const receipt = index.entries[0];
  // Should be the proxy timestamp, NOT the current sync time
  assert.equal(receipt.recorded_at, "2023-11-14T22:13:20.000Z");
  // And definitely not the sync time
  assert.notEqual(receipt.recorded_at, new Date(before).toISOString());
});

// ─── TC-014: parse_errors are also counted in skipped_by_reason ────────────
test("TC-014: parse_errors on the tail line (no trailing newline) are counted", () => {
  const root = tempProject();
  // Build the source manually so the LAST line has no trailing newline,
  // forcing the tail handler to run.
  const fixturePath = path.join(root, "tail.jsonl");
  const lines = [
    "{bad",
    JSON.stringify(makeRecord({ requestId: "ocx-good-1" })),
  ];
  fs.writeFileSync(fixturePath, lines.join("\n"), "utf8"); // no final \n
  const result = runSync(["--source", fixturePath, "--project-root", root, "--dry-run"], fixturePath, root);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  // First line: parse error in data handler.
  // Second line: valid record, processed in tail handler.
  assert.equal(out.counters.parse_errors, 1);
  assert.equal(out.counters.skipped_by_reason.parse_error, 1);
  assert.equal(out.counters.parsed, 1);
});