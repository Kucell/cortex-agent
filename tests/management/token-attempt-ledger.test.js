"use strict";

// ─── token-attempt-ledger.test.js (VC-001～VC-006) ────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────
// Focused tests for M-025/MS-001 token-attempt ledger implementation.
// Tests cover:
//   VC-001: Versioned receipt distinguishes estimated/render/host-reported states
//   VC-002: Ledger is append-only with idempotent attempt_id + receipt_id
//   VC-003: Missing, partial, dirty, oversized, out-of-order receipts handled
//   VC-004: Schema and persistence reject private fields
//   VC-005: Legacy runs tokens compatibility
//   VC-006: Focused queries without receipt body scanning

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Resolve from _shared template (mirrors real runtime resolution)
const SHARED_SCRIPTS = path.resolve(__dirname, "../../templates/_shared/.agent/skills/management-api/scripts");
const receiptModule = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
const ledgerModule = require(path.join(SHARED_SCRIPTS, "token-attempt-ledger.js"));
const queryModule = require(path.join(SHARED_SCRIPTS, "query-token-attempts.js"));

// ─── Test fixtures ────────────────────────────────────────────────────────────
function makeTempLedger() {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tok-ledger-"));
  return ledgerDir;
}

function receiptFixture(overrides = {}) {
  return {
    schema_version: "1.0",
    receipt_id: "r-test-001",
    attempt_id: "a-test-001",
    run_id: "R-test-001",
    task_id: "T-test-001",
    session_id: "S-test-001",
    host: "claude-code",
    model: "claude-sonnet-4-5",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    measurement_source: "claude-code",
    recorded_at: new Date().toISOString(),
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 150,
      samples: 1,
      host_reported_input_tokens: 100,
      host_reported_output_tokens: 50,
      host_reported_cache_creation_input_tokens: 200,
      host_reported_cache_read_input_tokens: 150,
      host_reported_cache_tokens: 350,
    },
    ...overrides,
  };
}

// ─── VC-001: Versioned receipt distinguishes states ───────────────────────────

test("VC-001: receipt distinguishes estimated vs rendered vs host_reported status", () => {
  // Estimated status
  const estimatedReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-001",
    receipt_id: "r-001",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.ESTIMATED,
    raw_usage: { input_tokens: 100, output_tokens: 50 },
  });
  assert.equal(estimatedReceipt.status, "estimated");
  assert.equal(estimatedReceipt.usage.host_reported_input_tokens, "unknown");

  // Rendered status
  const renderedReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-002",
    receipt_id: "r-002",
    host: "cursor",
    status: receiptModule.USAGE_STATUS.RENDERED,
    raw_usage: { input_tokens: 200, output_tokens: 100 },
  });
  assert.equal(renderedReceipt.status, "rendered");

  // Host-reported status
  const hostReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-003",
    receipt_id: "r-003",
    host: "codex",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 300, output_tokens: 150 },
  });
  assert.equal(hostReceipt.status, "host_reported");
  assert.equal(hostReceipt.usage.host_reported_input_tokens, 300);
});

test("VC-001: unknown/unavailable status is preserved without inference", () => {
  // Unknown status
  const unknownReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-004",
    receipt_id: "r-004",
    host: "unknown",
    status: receiptModule.USAGE_STATUS.UNKNOWN,
    raw_usage: {},
  });
  assert.equal(unknownReceipt.status, "unknown");
  assert.equal(unknownReceipt.usage.input_tokens, 0);
  assert.equal(unknownReceipt.usage.host_reported_input_tokens, "unknown");
  assert.equal(unknownReceipt.usage.host_reported_cache_tokens, "unknown");

  // Unavailable status
  const unavailableReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-005",
    receipt_id: "r-005",
    host: "unknown",
    status: receiptModule.USAGE_STATUS.UNAVAILABLE,
    raw_usage: null,
  });
  assert.equal(unavailableReceipt.status, "unavailable");
  assert.equal(unavailableReceipt.usage.input_tokens, 0);
  assert.equal(unavailableReceipt.usage.host_reported_input_tokens, "unknown");
  assert.equal(unavailableReceipt.usage.host_reported_cache_tokens, "unknown");
});

test("VC-001: partial host report preserves each missing field as unknown", () => {
  const receipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-partial-host",
    receipt_id: "r-partial-host",
    host: "codex",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 42 },
  });
  assert.equal(receipt.usage.host_reported_input_tokens, 42);
  assert.equal(receipt.usage.host_reported_output_tokens, "unknown");
  assert.equal(receipt.usage.host_reported_cache_creation_input_tokens, "unknown");
  assert.equal(receipt.usage.host_reported_cache_read_input_tokens, "unknown");
  assert.equal(receipt.usage.host_reported_cache_tokens, "unknown");
});

// ─── VC-002: Append-only ledger with idempotency ─────────────────────────────

test("VC-002: ledger appends receipt and persists", () => {
  const ledgerDir = makeTempLedger();
  const receipt = receiptFixture({ attempt_id: "a-002-1", receipt_id: "r-002-1" });

  const result = ledgerModule.appendReceipt(ledgerDir, receipt);
  assert.equal(result.ok, true);
  assert.equal(result.isDuplicate, false);
  assert.ok(result.entry);

  // Verify persisted
  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].attempt_id, "a-002-1");
  const immutableDir = path.join(ledgerDir, ledgerModule.RECEIPTS_DIR);
  const immutableFiles = fs.readdirSync(immutableDir);
  assert.equal(immutableFiles.length, 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(immutableDir, immutableFiles[0]), "utf8"));
  assert.equal(persisted.receipt.attempt_id, "a-002-1");
});

test("VC-002: duplicate attempt_id + receipt_id is idempotent (no double count)", () => {
  const ledgerDir = makeTempLedger();
  const receipt = receiptFixture({ attempt_id: "a-002-2", receipt_id: "r-002-2" });

  // First append
  const result1 = ledgerModule.appendReceipt(ledgerDir, receipt);
  assert.equal(result1.ok, true);
  assert.equal(result1.isDuplicate, false);

  // Second append (should be rejected as duplicate)
  const result2 = ledgerModule.appendReceipt(ledgerDir, receipt);
  assert.equal(result2.ok, false);
  assert.equal(result2.error, "duplicate_receipt");
  assert.equal(result2.isDuplicate, true);

  // Verify only one entry
  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.entries.length, 1, "Only one entry should exist");
});

test("VC-002: duplicate id with different body fails as idempotency conflict", () => {
  const ledgerDir = makeTempLedger();
  const receipt = receiptFixture({ attempt_id: "a-body-conflict", receipt_id: "r-body-conflict" });
  assert.equal(ledgerModule.appendReceipt(ledgerDir, receipt).ok, true);
  const changed = {
    ...receipt,
    usage: { ...receipt.usage, input_tokens: 999, host_reported_input_tokens: 999 },
  };
  const result = ledgerModule.appendReceipt(ledgerDir, changed);
  assert.equal(result.ok, false);
  assert.equal(result.error, "idempotency_conflict");
  const index = JSON.parse(fs.readFileSync(path.join(ledgerDir, ledgerModule.LEDGER_INDEX), "utf8"));
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].usage.input_tokens, 100);
});

test("VC-002: different receipt_id allows append (same attempt_id)", () => {
  const ledgerDir = makeTempLedger();
  const receipt1 = receiptFixture({ attempt_id: "a-002-3", receipt_id: "r-002-3a" });
  const receipt2 = receiptFixture({ attempt_id: "a-002-3", receipt_id: "r-002-3b" });

  const result1 = ledgerModule.appendReceipt(ledgerDir, receipt1);
  assert.equal(result1.ok, true);

  const result2 = ledgerModule.appendReceipt(ledgerDir, receipt2);
  assert.equal(result2.ok, true);

  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.entries.length, 2);
});

test("VC-002: same receipt_id with different attempt_id allows append", () => {
  const ledgerDir = makeTempLedger();
  const receipt1 = receiptFixture({ attempt_id: "a-002-4a", receipt_id: "r-002-4" });
  const receipt2 = receiptFixture({ attempt_id: "a-002-4b", receipt_id: "r-002-4" });

  ledgerModule.appendReceipt(ledgerDir, receipt1);
  const result2 = ledgerModule.appendReceipt(ledgerDir, receipt2);
  assert.equal(result2.ok, true);

  const indexPath = path.join(ledgerDir, "ledger-index.json");
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(index.entries.length, 2);
});

test("VC-002: existing writer lock fails closed without unsafe takeover", () => {
  const ledgerDir = makeTempLedger();
  const owner = JSON.stringify({ pid: process.pid, token: "live-owner", acquired_at: new Date().toISOString() });
  fs.writeFileSync(path.join(ledgerDir, ledgerModule.LEDGER_LOCK), owner, "utf8");
  const result = ledgerModule.appendReceipt(ledgerDir, receiptFixture({
    attempt_id: "a-held-lock",
    receipt_id: "r-held-lock",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "ledger_write_failed");
  assert.match(result.reason, /lock_timeout/);
  assert.equal(fs.readFileSync(path.join(ledgerDir, ledgerModule.LEDGER_LOCK), "utf8"), owner);
});

test("VC-002: explicit recovery removes dead lock and writes audit event", () => {
  const ledgerDir = makeTempLedger();
  const lockPath = path.join(ledgerDir, ledgerModule.LEDGER_LOCK);
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 99999999,
    token: "dead-owner",
    acquired_at: "2026-08-13T00:00:00.000Z",
  }), "utf8");
  const recovered = ledgerModule.recoverLedgerLock(ledgerDir, { recoveredBy: "mission" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true);
  assert.equal(fs.existsSync(lockPath), false);
  const audit = fs.readFileSync(path.join(ledgerDir, ledgerModule.RECOVERY_LOG), "utf8");
  const events = audit.trim().split("\n").map(JSON.parse);
  assert.deepEqual(events.map((event) => event.event), [
    "ledger_lock_recovery_intent",
    "ledger_lock_recovered",
  ]);
  assert.equal(events[0].recovery_id, events[1].recovery_id);
  assert.equal(ledgerModule.appendReceipt(ledgerDir, receiptFixture({
    attempt_id: "a-after-recovery",
    receipt_id: "r-after-recovery",
  })).ok, true);
});

test("VC-002: orphan immutable receipt is indexed on retry", () => {
  const crypto = require("node:crypto");
  const ledgerDir = makeTempLedger();
  const receipt = receiptFixture({ attempt_id: "a-orphan", receipt_id: "r-orphan" });
  const digest = crypto.createHash("sha256")
    .update(ledgerModule.computeIdempotencyKey(receipt)).digest("hex");
  const immutable = path.join(ledgerDir, ledgerModule.RECEIPTS_DIR, `${digest}.json`);
  fs.mkdirSync(path.dirname(immutable), { recursive: true });
  fs.writeFileSync(immutable, `${JSON.stringify(ledgerModule.createLedgerEntry(receipt))}\n`, "utf8");

  const result = ledgerModule.appendReceipt(ledgerDir, receipt);
  assert.equal(result.ok, true);
  const index = JSON.parse(fs.readFileSync(path.join(ledgerDir, ledgerModule.LEDGER_INDEX), "utf8"));
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].attempt_id, "a-orphan");
});

test("VC-002: orphan immutable receipt with conflicting body fails closed", () => {
  const crypto = require("node:crypto");
  const ledgerDir = makeTempLedger();
  const receipt = receiptFixture({ attempt_id: "a-conflict", receipt_id: "r-conflict", host: "pi" });
  const conflicting = { ...receipt, host: "codex" };
  const digest = crypto.createHash("sha256")
    .update(ledgerModule.computeIdempotencyKey(receipt)).digest("hex");
  const immutable = path.join(ledgerDir, ledgerModule.RECEIPTS_DIR, `${digest}.json`);
  fs.mkdirSync(path.dirname(immutable), { recursive: true });
  fs.writeFileSync(immutable, `${JSON.stringify(ledgerModule.createLedgerEntry(conflicting))}\n`, "utf8");

  const result = ledgerModule.appendReceipt(ledgerDir, receipt);
  assert.equal(result.ok, false);
  assert.equal(result.error, "idempotency_conflict");
  assert.equal(fs.existsSync(path.join(ledgerDir, ledgerModule.LEDGER_INDEX)), false);
});

test("VC-002: corrupt index fails closed without overwrite", () => {
  const ledgerDir = makeTempLedger();
  const indexPath = path.join(ledgerDir, ledgerModule.LEDGER_INDEX);
  fs.writeFileSync(indexPath, "{not-json", "utf8");
  const result = ledgerModule.appendReceipt(ledgerDir, receiptFixture({
    attempt_id: "a-corrupt-index",
    receipt_id: "r-corrupt-index",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, "ledger_write_failed");
  assert.equal(fs.readFileSync(indexPath, "utf8"), "{not-json");
});

test("VC-002: ledger stats count distinct attempts from focused index", () => {
  const ledgerDir = makeTempLedger();
  ledgerModule.appendReceipt(ledgerDir, receiptFixture({ attempt_id: "a-stats-1", receipt_id: "r-stats-1" }));
  ledgerModule.appendReceipt(ledgerDir, receiptFixture({ attempt_id: "a-stats-2", receipt_id: "r-stats-2" }));
  assert.equal(ledgerModule.getLedgerStats(ledgerDir).unique_attempts, 2);
});

// ─── VC-003: Missing, partial, dirty, oversized, out-of-order handling ───────

test("VC-003: missing receipt fields default to unknown", () => {
  // Create properly normalized receipt with createTokenAttemptReceipt
  const minimalReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-003-1",
    receipt_id: "r-003-1",
    // host defaults to "unknown" when not provided
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), minimalReceipt);
  assert.equal(result.ok, true);
  const entry = result.entry.receipt;
  assert.equal(entry.host, "unknown");
  assert.equal(entry.run_id, undefined);
  assert.equal(entry.usage.input_tokens, 0);
});

test("VC-003: partial receipt is accepted", () => {
  // Create receipt via createTokenAttemptReceipt with partial raw_usage
  const partialReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-003-2",
    receipt_id: "r-003-2",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 100 }, // Only input_tokens provided
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), partialReceipt);
  assert.equal(result.ok, true);
  const entry = result.entry.receipt;
  assert.equal(entry.usage.input_tokens, 100);
  assert.equal(entry.usage.output_tokens, 0);
});

test("VC-003: dirty string input is normalized", () => {
  // Create receipt with dirty values via createTokenAttemptReceipt
  const dirtyReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-003-3",
    receipt_id: "r-003-3",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {
      input_tokens: "7,29000000", // dirty concatenated string
      output_tokens: "1,234",     // clean thousand-separated
      cache_creation_input_tokens: "true,false", // boolean string
      cache_read_input_tokens: "garbage",
    },
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), dirtyReceipt);
  assert.equal(result.ok, true);
  const entry = result.entry.receipt;
  assert.equal(entry.usage.input_tokens, 0);      // dirty rejected
  assert.equal(entry.usage.output_tokens, 1234);  // clean honored
  assert.equal(entry.usage.cache_creation_input_tokens, 0);
  assert.equal(entry.usage.cache_read_input_tokens, 0);
});

test("VC-003: oversized receipt is rejected", () => {
  const oversizedReceipt = receiptFixture({
    attempt_id: "a-003-4",
    receipt_id: "r-003-4",
  });
  oversizedReceipt.status_reason = "x".repeat(100000);

  const result = ledgerModule.appendReceipt(makeTempLedger(), oversizedReceipt, {
    maxSizeBytes: 65536,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "oversized_receipt");
});

test("VC-003: out-of-order receipt is rejected by default", () => {
  const ledgerDir = makeTempLedger();

  // First receipt with later timestamp
  const laterReceipt = receiptFixture({
    attempt_id: "a-003-5",
    receipt_id: "r-003-5",
    recorded_at: "2026-08-15T12:00:00.000Z",
  });
  ledgerModule.appendReceipt(ledgerDir, laterReceipt);

  // Second receipt with earlier timestamp (should be rejected)
  const earlierReceipt = receiptFixture({
    attempt_id: "a-003-5",
    receipt_id: "r-003-5b",
    recorded_at: "2026-08-15T11:00:00.000Z", // Earlier
  });
  const result = ledgerModule.appendReceipt(ledgerDir, earlierReceipt);
  assert.equal(result.ok, false);
  assert.equal(result.error, "out_of_order_receipt");
});

test("VC-003: out-of-order receipt allowed with flag", () => {
  const ledgerDir = makeTempLedger();

  const laterReceipt = receiptFixture({
    attempt_id: "a-003-6",
    receipt_id: "r-003-6",
    recorded_at: "2026-08-15T12:00:00.000Z",
  });
  ledgerModule.appendReceipt(ledgerDir, laterReceipt);

  const earlierReceipt = receiptFixture({
    attempt_id: "a-003-6",
    receipt_id: "r-003-6b",
    recorded_at: "2026-08-15T11:00:00.000Z",
  });
  const result = ledgerModule.appendReceipt(ledgerDir, earlierReceipt, {
    allowOutOfOrder: true,
  });
  assert.equal(result.ok, true);
});

// ─── VC-004: Security boundary ───────────────────────────────────────────────

test("VC-004: receipt with blocked field is rejected", () => {
  const badReceipt = receiptFixture({
    attempt_id: "a-004-1",
    receipt_id: "r-004-1",
    prompt: "This should not be here",
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), badReceipt);
  assert.equal(result.ok, false);
  assert.equal(result.error, "security_violation");
  assert.ok(result.reason.includes("prompt"));
});

test("VC-004: receipt with credential pattern is rejected", () => {
  const badReceipt = receiptFixture({
    attempt_id: "a-004-2",
    receipt_id: "r-004-2",
    status_reason: "API key: sk-1234567890abcdefghijklmnopqrstuvwxyz",
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), badReceipt);
  assert.equal(result.ok, false);
  assert.equal(result.error, "security_violation");
});

test("VC-004: receipt with private absolute path is rejected", () => {
  const badReceipt = receiptFixture({
    attempt_id: "a-004-3",
    receipt_id: "r-004-3",
    status_reason: "File: /Users/johndoe/project/secret.txt",
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), badReceipt);
  assert.equal(result.ok, false);
  assert.equal(result.error, "security_violation");
});

test("VC-004: receipt with transcript field is rejected", () => {
  const badReceipt = receiptFixture({
    attempt_id: "a-004-4",
    receipt_id: "r-004-4",
    transcript: "This is a private transcript that should not be persisted",
  });

  const result = ledgerModule.appendReceipt(makeTempLedger(), badReceipt);
  assert.equal(result.ok, false);
  assert.equal(result.error, "security_violation");
});

test("VC-004: unknown top-level and usage fields fail closed", () => {
  const unknownTop = ledgerModule.appendReceipt(makeTempLedger(), receiptFixture({
    attempt_id: "a-004-5",
    receipt_id: "r-004-5",
    surprise: "value",
  }));
  assert.equal(unknownTop.error, "security_violation");

  const unknownUsageReceipt = receiptFixture({
    attempt_id: "a-004-6",
    receipt_id: "r-004-6",
  });
  unknownUsageReceipt.usage.magic_tokens = 12;
  const unknownUsage = ledgerModule.appendReceipt(makeTempLedger(), unknownUsageReceipt);
  assert.equal(unknownUsage.error, "security_violation");
});

test("VC-004: persistence rejects malformed versioned receipt fields", () => {
  const ledgerDir = makeTempLedger();
  const malformed = receiptFixture({
    schema_version: "2.0",
    recorded_at: "not-a-time",
    usage: { input_tokens: "100" },
  });
  const result = ledgerModule.appendReceipt(ledgerDir, malformed);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_receipt");
  assert.equal(fs.existsSync(path.join(ledgerDir, ledgerModule.LEDGER_INDEX)), false);
});

test("VC-004: status_reason accepts short codes and rejects body text", () => {
  const ledgerDir = makeTempLedger();
  const codeReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-reason-code",
    receipt_id: "r-reason-code",
    status_reason: "host_usage_unavailable",
  });
  assert.equal(ledgerModule.appendReceipt(ledgerDir, codeReceipt).ok, true);

  const bodyReceipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-reason-body",
    receipt_id: "r-reason-body",
    status_reason: "Here is the original prompt body with private source text",
  });
  const rejected = ledgerModule.appendReceipt(makeTempLedger(), bodyReceipt);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "invalid_receipt");
  assert.match(rejected.reason, /short reason code/);
});

test("VC-004: non-reported status cannot carry reported token values", () => {
  const forged = receiptFixture({ status: receiptModule.USAGE_STATUS.UNKNOWN });
  const result = ledgerModule.appendReceipt(makeTempLedger(), forged);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_receipt");
  assert.match(result.reason, /cannot carry host-reported usage/);
});

test("VC-004: host-reported mirrors must match generic token values", () => {
  const forged = receiptFixture({
    usage: {
      ...receiptFixture().usage,
      input_tokens: 999,
      host_reported_input_tokens: "unknown",
    },
  });
  const result = ledgerModule.appendReceipt(makeTempLedger(), forged);
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_receipt");
  assert.match(result.reason, /must mirror/);
});

// ─── VC-005: Legacy runs tokens compatibility ──────────────────────────────────

test("VC-005: submitTokenUsage is compatible with legacy runs tokens", () => {
  const ledgerDir = makeTempLedger();
  const raw_usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 150,
  };

  const result = ledgerModule.submitTokenUsage(
    ledgerDir,
    "a-005-1",
    "claude-code",
    raw_usage,
    { run_id: "R-005-1", task_id: "T-005-1" }
  );

  assert.equal(result.ok, true);
  assert.equal(result.entry.receipt.host, "claude-code");
  assert.equal(result.entry.receipt.status, "host_reported");
  assert.equal(result.entry.receipt.usage.input_tokens, 100);
});

test("VC-005: dirty legacy input is normalized", () => {
  const ledgerDir = makeTempLedger();
  const dirty_usage = {
    input_tokens: "7,29000000",
    output_tokens: "1,234",
    cache_creation_input_tokens: "0",
    cache_read_input_tokens: "0",
  };

  const result = ledgerModule.submitTokenUsage(
    ledgerDir,
    "a-005-2",
    "cursor",
    dirty_usage
  );

  assert.equal(result.ok, true);
  assert.equal(result.entry.receipt.usage.input_tokens, 0);
  assert.equal(result.entry.receipt.usage.output_tokens, 1234);
});

// ─── VC-006: Focused queries ───────────────────────────────────────────────────

test("VC-006: query returns focused projection without receipt bodies", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  // Append a properly normalized receipt
  const receipt = receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-1",
    receipt_id: "r-006-1",
    run_id: "R-006-1",
    task_id: "T-006-1",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 100, output_tokens: 50 },
  });
  ledgerModule.appendReceipt(ledgerDir, receipt);

  // Query using projectRoot as root (queryTokenAttempts will resolve ledger path)
  const result = queryModule.queryTokenAttempts(projectRoot, {});
  assert.equal(result.ok, true);
  assert.equal(result.receipts.length, 1);
  assert.ok(result.receipts[0].receipt_id);
  assert.ok(result.receipts[0].attempt_id);
  // Verify no body fields (should only have usage_summary, not full usage)
  assert.equal(result.receipts[0].usage_summary, undefined);
});

test("VC-006: query filters by task_id without scanning bodies", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-2a",
    receipt_id: "r-006-2a",
    task_id: "T-006-2",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-2b",
    receipt_id: "r-006-2b",
    task_id: "T-006-2",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-2c",
    receipt_id: "r-006-2c",
    task_id: "T-OTHER",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));

  const result = queryModule.queryTokenAttempts(projectRoot, { task_id: "T-006-2" });
  assert.equal(result.receipts.length, 2);
  assert.equal(result.summary.unique_tasks, 1);
});

test("VC-006: query filters by host", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-3a",
    receipt_id: "r-006-3a",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-3b",
    receipt_id: "r-006-3b",
    host: "cursor",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));

  const result = queryModule.queryTokenAttempts(projectRoot, { host: "claude-code" });
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].host, "claude-code");
});

test("VC-006: query filters by status", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-4a",
    receipt_id: "r-006-4a",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-4b",
    receipt_id: "r-006-4b",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.ESTIMATED,
    raw_usage: {},
  }));

  const result = queryModule.queryTokenAttempts(projectRoot, {
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
  });
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].status, "host_reported");
});

test("VC-006: query returns pagination info", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  for (let i = 0; i < 5; i++) {
    ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
      attempt_id: `a-006-5-${i}`,
      receipt_id: `r-006-5-${i}`,
      host: "claude-code",
      status: receiptModule.USAGE_STATUS.HOST_REPORTED,
      raw_usage: {},
    }));
  }

  const result = queryModule.queryTokenAttempts(projectRoot, {}, { limit: 2, offset: 0 });
  assert.equal(result.receipts.length, 2);
  assert.equal(result.pagination.total, 5);
  assert.equal(result.pagination.has_more, true);
});

test("VC-006: stats aggregation works", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-6a",
    receipt_id: "r-006-6a",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 150 },
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-006-6b",
    receipt_id: "r-006-6b",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 300, cache_read_input_tokens: 250 },
  }));

  const result = queryModule.queryTokenAttemptStats(projectRoot, {});
  assert.equal(result.totals.input_tokens, 300);
  assert.equal(result.totals.output_tokens, 150);
  assert.equal(result.totals.cache_creation_input_tokens, 500);
  assert.equal(result.totals.cache_read_input_tokens, 400);
});

test("VC-006: stats keep estimated usage out of host-reported totals", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-estimated",
    receipt_id: "r-estimated",
    host: "codex",
    model: "model-a",
    status: receiptModule.USAGE_STATUS.ESTIMATED,
    raw_usage: { input_tokens: 100, output_tokens: 50 },
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-measured",
    receipt_id: "r-measured",
    host: "codex",
    model: "model-a",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 30, output_tokens: 10 },
  }));
  const result = queryModule.queryTokenAttemptStats(projectRoot);
  assert.equal(result.totals_status, "host_reported");
  assert.equal(result.totals.input_tokens, 30);
  assert.equal(result.totals.output_tokens, 10);
  assert.equal(result.stats.receipt_count, 2);
  assert.equal(result.stats.measured_receipt_count, 1);
});

test("VC-006: stats apply model, session and time filters", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");
  const append = (attempt_id, model, session_id, recorded_at, input_tokens) => {
    ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
      attempt_id,
      receipt_id: `r-${attempt_id}`,
      host: "codex",
      model,
      session_id,
      recorded_at,
      status: receiptModule.USAGE_STATUS.HOST_REPORTED,
      raw_usage: { input_tokens },
    }));
  };
  append("a-filter-1", "model-a", "S-1", "2026-08-10T00:00:00.000Z", 10);
  append("a-filter-2", "model-b", "S-1", "2026-08-11T00:00:00.000Z", 20);
  append("a-filter-3", "model-a", "S-2", "2026-08-12T00:00:00.000Z", 30);

  const result = queryModule.queryTokenAttemptStats(projectRoot, {
    model: "model-a",
    session_id: "S-2",
    since: "2026-08-11T12:00:00.000Z",
    until: "2026-08-12T12:00:00.000Z",
  });
  assert.equal(result.stats.receipt_count, 1);
  assert.equal(result.totals.input_tokens, 30);
});

// ─── Additional edge cases ───────────────────────────────────────────────────

test("receipt_id generation is deterministic for same inputs", () => {
  const id1 = receiptModule.generateReceiptId("a-test", "claude-code", 0);
  const id2 = receiptModule.generateReceiptId("a-test", "claude-code", 0);
  assert.equal(id1.split("-")[0], id2.split("-")[0]); // Same hash prefix
});

test("receipt validation rejects invalid status", () => {
  assert.throws(() => {
    receiptModule.createTokenAttemptReceipt({
      attempt_id: "a-test",
      receipt_id: "r-test",
      status: "invalid_status",
    });
  }, /Invalid status/);
});

test("receipt validation requires attempt_id", () => {
  assert.throws(() => {
    receiptModule.createTokenAttemptReceipt({
      receipt_id: "r-test",
    });
  }, /attempt_id is required/);
});

test("receipt validation requires receipt_id", () => {
  assert.throws(() => {
    receiptModule.createTokenAttemptReceipt({
      attempt_id: "a-test",
    });
  }, /receipt_id is required/);
});

test("clearLedger removes ledger for testing", () => {
  const ledgerDir = makeTempLedger();
  ledgerModule.appendReceipt(ledgerDir, receiptFixture({
    attempt_id: "a-clear",
    receipt_id: "r-clear",
  }));

  ledgerModule.clearLedger(ledgerDir);
  assert.equal(queryModule.hasReceipts(ledgerDir), false);
});

test("hasReceipts returns false for empty/missing ledger", () => {
  const ledgerDir = makeTempLedger();
  assert.equal(queryModule.hasReceipts(ledgerDir), false);
});

test("hasReceipts returns true for populated ledger", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-has",
    receipt_id: "r-has",
    host: "claude-code",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  assert.equal(queryModule.hasReceipts(projectRoot), true);
});

test("queryDistinctField returns unique values", () => {
  const projectRoot = makeTempLedger();
  const ledgerDir = path.join(projectRoot, ".agent/token-attempts");

  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-dist-1",
    receipt_id: "r-dist-1",
    host: "claude-code",
    model: "sonnet",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-dist-2",
    receipt_id: "r-dist-2",
    host: "cursor",
    model: "sonnet",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));
  ledgerModule.appendReceipt(ledgerDir, receiptModule.createTokenAttemptReceipt({
    attempt_id: "a-dist-3",
    receipt_id: "r-dist-3",
    host: "claude-code",
    model: "opus",
    status: receiptModule.USAGE_STATUS.HOST_REPORTED,
    raw_usage: {},
  }));

  const hosts = queryModule.queryDistinctField(projectRoot, "host");
  assert.deepEqual(hosts.values.sort(), ["claude-code", "cursor"]);

  const models = queryModule.queryDistinctField(projectRoot, "model");
  assert.deepEqual(models.values.sort(), ["opus", "sonnet"]);
});
