"use strict";

// ─── token-attempt-template-parity.test.js (VC-007) ──────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────
// Verifies that _shared, zh, and en Management API projections are semantically
// identical (VC-007).
//
// This test compares:
//   1. File existence parity
//   2. Schema exports parity
//   3. Function behavior parity
//   4. Security exports parity

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const test = require("node:test");

const TEMPLATES_ROOT = path.resolve(__dirname, "../../templates");
const SHARED_SCRIPTS = path.join(TEMPLATES_ROOT, "_shared/.agent/skills/management-api/scripts");
const ZH_SCRIPTS = path.join(TEMPLATES_ROOT, "zh/.agent/skills/management-api/scripts");
const EN_SCRIPTS = path.join(TEMPLATES_ROOT, "en/.agent/skills/management-api/scripts");

// Files that must exist in all three locations
const REQUIRED_FILES = [
  "token-attempt-receipt.js",
  "token-attempt-ledger.js",
  "query-token-attempts.js",
  "normalize-token-usage.js",
];

// ─── VC-007: File existence parity ───────────────────────────────────────────

test("VC-007: all required files exist in _shared", () => {
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(SHARED_SCRIPTS, file);
    assert.ok(fs.existsSync(filePath), `${file} must exist in _shared`);
  }
});

test("VC-007: all required files exist in zh", () => {
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(ZH_SCRIPTS, file);
    assert.ok(fs.existsSync(filePath), `${file} must exist in zh`);
  }
});

test("VC-007: all required files exist in en", () => {
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(EN_SCRIPTS, file);
    assert.ok(fs.existsSync(filePath), `${file} must exist in en`);
  }
});

// ─── VC-007: Schema exports parity ────────────────────────────────────────────

test("VC-007: token-attempt-receipt exports same schema version across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  assert.equal(shared.SCHEMA_VERSION, "1.0");
  assert.equal(zh.SCHEMA_VERSION, "1.0");
  assert.equal(en.SCHEMA_VERSION, "1.0");
  assert.equal(shared.SCHEMA_VERSION, zh.SCHEMA_VERSION);
  assert.equal(shared.SCHEMA_VERSION, en.SCHEMA_VERSION);
});

test("VC-007: USAGE_STATUS enum is identical across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  assert.deepEqual(shared.USAGE_STATUS, zh.USAGE_STATUS);
  assert.deepEqual(shared.USAGE_STATUS, en.USAGE_STATUS);
  assert.deepEqual(shared.USAGE_STATUS, {
    ESTIMATED: "estimated",
    RENDERED: "rendered",
    HOST_REPORTED: "host_reported",
    UNKNOWN: "unknown",
    UNAVAILABLE: "unavailable",
  });
});

// ─── VC-007: Function exports parity ──────────────────────────────────────────

test("VC-007: token-attempt-receipt exports same functions across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  const sharedExports = Object.keys(shared).sort();
  const zhExports = Object.keys(zh).sort();
  const enExports = Object.keys(en).sort();

  assert.deepEqual(sharedExports, zhExports, "zh must export same functions as _shared");
  assert.deepEqual(sharedExports, enExports, "en must export same functions as _shared");
});

test("VC-007: token-attempt-ledger exports same functions across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-ledger.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-ledger.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-ledger.js"));

  const sharedExports = Object.keys(shared).sort();
  const zhExports = Object.keys(zh).sort();
  const enExports = Object.keys(en).sort();

  assert.deepEqual(sharedExports, zhExports, "zh must export same functions as _shared");
  assert.deepEqual(sharedExports, enExports, "en must export same functions as _shared");
});

test("VC-007: query-token-attempts exports same functions across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "query-token-attempts.js"));
  const zh = require(path.join(ZH_SCRIPTS, "query-token-attempts.js"));
  const en = require(path.join(EN_SCRIPTS, "query-token-attempts.js"));

  const sharedExports = Object.keys(shared).sort();
  const zhExports = Object.keys(zh).sort();
  const enExports = Object.keys(en).sort();

  assert.deepEqual(sharedExports, zhExports, "zh must export same functions as _shared");
  assert.deepEqual(sharedExports, enExports, "en must export same functions as _shared");
});

// ─── VC-007: Function behavior parity ────────────────────────────────────────

test("VC-007: createTokenAttemptReceipt produces identical receipts across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  const sharedTimestamp = "2026-08-13T00:00:00.000Z";
  const options = {
    attempt_id: "a-parity-001",
    receipt_id: "r-parity-001",
    host: "claude-code",
    status: shared.USAGE_STATUS.HOST_REPORTED,
    raw_usage: { input_tokens: 100, output_tokens: 50 },
    recorded_at: sharedTimestamp, // Use fixed timestamp for deterministic comparison
  };

  const sharedReceipt = shared.createTokenAttemptReceipt(options);
  const zhReceipt = zh.createTokenAttemptReceipt(options);
  const enReceipt = en.createTokenAttemptReceipt(options);

  assert.deepEqual(sharedReceipt, zhReceipt);
  assert.deepEqual(sharedReceipt, enReceipt);
});

test("VC-007: validateReceiptSecurity produces identical results across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  // Good receipt
  const goodReceipt = {
    schema_version: "1.0",
    receipt_id: "r-test",
    attempt_id: "a-test",
    status: "host_reported",
    usage: { input_tokens: 100 },
  };

  assert.deepEqual(shared.validateReceiptSecurity(goodReceipt), zh.validateReceiptSecurity(goodReceipt));
  assert.deepEqual(shared.validateReceiptSecurity(goodReceipt), en.validateReceiptSecurity(goodReceipt));

  // Bad receipt with blocked field
  const badReceipt = { ...goodReceipt, prompt: "secret" };
  assert.deepEqual(shared.validateReceiptSecurity(badReceipt), zh.validateReceiptSecurity(badReceipt));
  assert.deepEqual(shared.validateReceiptSecurity(badReceipt), en.validateReceiptSecurity(badReceipt));
});

test("VC-007: normalizeTokenUsage produces identical results across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  const dirtyInput = {
    input_tokens: "7,29000000",
    output_tokens: "1,234",
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  assert.deepEqual(shared.normalizeTokenUsage(dirtyInput), zh.normalizeTokenUsage(dirtyInput));
  assert.deepEqual(shared.normalizeTokenUsage(dirtyInput), en.normalizeTokenUsage(dirtyInput));
});

// ─── VC-007: Security exports parity ──────────────────────────────────────────

test("VC-007: BLOCKED_RECEIPT_FIELDS is identical across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  assert.deepEqual(shared.BLOCKED_RECEIPT_FIELDS, zh.BLOCKED_RECEIPT_FIELDS);
  assert.deepEqual(shared.BLOCKED_RECEIPT_FIELDS, en.BLOCKED_RECEIPT_FIELDS);
});

test("VC-007: ALLOWED_RECEIPT_FIELDS is identical across templates", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-receipt.js"));

  assert.deepEqual(shared.ALLOWED_RECEIPT_FIELDS, zh.ALLOWED_RECEIPT_FIELDS);
  assert.deepEqual(shared.ALLOWED_RECEIPT_FIELDS, en.ALLOWED_RECEIPT_FIELDS);
});

// ─── VC-007: Ledger constants parity ─────────────────────────────────────────

test("VC-007: ledger LEDGER_DIR and LEDGER_INDEX constants are identical", () => {
  const shared = require(path.join(SHARED_SCRIPTS, "token-attempt-ledger.js"));
  const zh = require(path.join(ZH_SCRIPTS, "token-attempt-ledger.js"));
  const en = require(path.join(EN_SCRIPTS, "token-attempt-ledger.js"));

  assert.equal(shared.LEDGER_DIR, ".agent/token-attempts");
  assert.equal(zh.LEDGER_DIR, shared.LEDGER_DIR);
  assert.equal(en.LEDGER_DIR, shared.LEDGER_DIR);

  assert.equal(shared.LEDGER_INDEX, "ledger-index.json");
  assert.equal(zh.LEDGER_INDEX, shared.LEDGER_INDEX);
  assert.equal(en.LEDGER_INDEX, shared.LEDGER_INDEX);
  assert.equal(shared.LEDGER_LOCK, ".ledger-write.lock");
  assert.equal(zh.LEDGER_LOCK, shared.LEDGER_LOCK);
  assert.equal(en.LEDGER_LOCK, shared.LEDGER_LOCK);
  assert.equal(shared.RECOVERY_LOCK, ".ledger-recovery.lock");
  assert.equal(zh.RECOVERY_LOCK, shared.RECOVERY_LOCK);
  assert.equal(en.RECOVERY_LOCK, shared.RECOVERY_LOCK);
});

// ─── VC-007: Content hash verification ────────────────────────────────────────

test("VC-007: token-attempt-receipt content hash matches across templates", () => {
  const shared = fs.readFileSync(path.join(SHARED_SCRIPTS, "token-attempt-receipt.js"), "utf8");
  const zh = fs.readFileSync(path.join(ZH_SCRIPTS, "token-attempt-receipt.js"), "utf8");
  const en = fs.readFileSync(path.join(EN_SCRIPTS, "token-attempt-receipt.js"), "utf8");

  const crypto = require("node:crypto");
  const sharedHash = crypto.createHash("sha256").update(shared).digest("hex");
  const zhHash = crypto.createHash("sha256").update(zh).digest("hex");
  const enHash = crypto.createHash("sha256").update(en).digest("hex");

  assert.equal(zhHash, sharedHash, "zh must have same content as _shared");
  assert.equal(enHash, sharedHash, "en must have same content as _shared");
});

test("VC-007: token-attempt-ledger content hash matches across templates", () => {
  const shared = fs.readFileSync(path.join(SHARED_SCRIPTS, "token-attempt-ledger.js"), "utf8");
  const zh = fs.readFileSync(path.join(ZH_SCRIPTS, "token-attempt-ledger.js"), "utf8");
  const en = fs.readFileSync(path.join(EN_SCRIPTS, "token-attempt-ledger.js"), "utf8");

  const crypto = require("node:crypto");
  const sharedHash = crypto.createHash("sha256").update(shared).digest("hex");
  const zhHash = crypto.createHash("sha256").update(zh).digest("hex");
  const enHash = crypto.createHash("sha256").update(en).digest("hex");

  assert.equal(zhHash, sharedHash, "zh must have same content as _shared");
  assert.equal(enHash, sharedHash, "en must have same content as _shared");
});

test("VC-007: query-token-attempts content hash matches across templates", () => {
  const shared = fs.readFileSync(path.join(SHARED_SCRIPTS, "query-token-attempts.js"), "utf8");
  const zh = fs.readFileSync(path.join(ZH_SCRIPTS, "query-token-attempts.js"), "utf8");
  const en = fs.readFileSync(path.join(EN_SCRIPTS, "query-token-attempts.js"), "utf8");

  const crypto = require("node:crypto");
  const sharedHash = crypto.createHash("sha256").update(shared).digest("hex");
  const zhHash = crypto.createHash("sha256").update(zh).digest("hex");
  const enHash = crypto.createHash("sha256").update(en).digest("hex");

  assert.equal(zhHash, sharedHash, "zh must have same content as _shared");
  assert.equal(enHash, sharedHash, "en must have same content as _shared");
});
