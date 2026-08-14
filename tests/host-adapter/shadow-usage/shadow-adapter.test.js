"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const shadow = require("../../../lib/host-adapter/shadow-usage.js");
const ledger = require("../../../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");
const receiptContract = require("../../../templates/_shared/.agent/skills/management-api/scripts/token-attempt-receipt.js");

function tempLedger() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-shadow-ledger-"));
}

function assertValidReceipt(receipt) {
  assert.deepEqual(receiptContract.validateReceiptSecurity(receipt), { valid: true });
  assert.deepEqual(receiptContract.validateReceiptContract(receipt), { valid: true });
}

test("VC-011: public entry loads and registers two distinct governed Host adapters", () => {
  assert.deepEqual(shadow.listAdapters(), ["claude-code", "codex", "pi-json"]);
  assert.equal(shadow.getAdapter("pi-json").getHostId(), "pi-json");
  assert.equal(shadow.getAdapter("codex").getHostId(), "codex");
  assert.equal(shadow.getAdapter("missing"), null);
});

test("VC-011: Pi and Codex public usage envelopes emit schema-valid receipts", () => {
  const pi = shadow.createPiJsonShadowAdapter({ usageCapability: "available" });
  const codex = shadow.createCodexShadowAdapter({ usageCapability: "available" });
  assert.equal(pi.detectUsage().status, "available");
  assert.equal(codex.detectUsage().status, "available");

  const piReceipt = pi.createShadowReceipt({
    attempt_id: "attempt-pi-real",
    delivery_id: "delivery-1",
    raw_usage: {
      type: "turn_end",
      usage: { input: 100, output: 25, cacheRead: 7, cacheWrite: 3, totalTokens: 135 },
    },
  });
  const codexReceipt = codex.createShadowReceipt({
    attempt_id: "attempt-codex-real",
    delivery_id: "delivery-1",
    raw_usage: {
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cached_input_tokens: 9,
        cache_write_input_tokens: 4,
        reasoning_output_tokens: 2,
      },
    },
  });

  assertValidReceipt(piReceipt);
  assertValidReceipt(codexReceipt);
  assert.equal(piReceipt.host, "pi-json");
  assert.equal(codexReceipt.host, "codex");
  assert.notEqual(piReceipt.receipt_id, codexReceipt.receipt_id);
  assert.equal(piReceipt.usage.host_reported_cache_read_input_tokens, 7);
  assert.equal(codexReceipt.usage.host_reported_cache_creation_input_tokens, 4);
});

test("VC-011: real Host field names are mapped without deriving unsupported totals", () => {
  const pi = shadow.createPiJsonShadowAdapter().normalizeUsage({
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  });
  const codex = shadow.createCodexShadowAdapter().normalizeUsage({
    usage: {
      input_tokens: 20076,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0,
    },
  });
  assert.deepEqual(pi.unsupportedFields, ["totalTokens"]);
  assert.equal(pi.usage.input_tokens, 0);
  assert.equal(pi.usage.cache_read_input_tokens, 0);
  assert.deepEqual(codex.unsupportedFields, ["reasoning_output_tokens"]);
  assert.equal(codex.usage.input_tokens, 20076);
  assert.equal(codex.usage.output_tokens, 5);
});

test("VC-011: both Host receipts persist through the MS-001 ledger", () => {
  const root = tempLedger();
  try {
    const piReceipt = shadow.createPiJsonShadowAdapter().createShadowReceipt({
      attempt_id: "attempt-pi-ledger",
      delivery_id: "delivery-1",
      raw_usage: { usage: { input_tokens: 11, output_tokens: 3 } },
    });
    const codexReceipt = shadow.createCodexShadowAdapter().createShadowReceipt({
      attempt_id: "attempt-codex-ledger",
      delivery_id: "delivery-1",
      raw_usage: { usage: { input_tokens: 17, output_tokens: 5 } },
    });
    const piAppend = ledger.appendReceipt(root, piReceipt);
    const codexAppend = ledger.appendReceipt(root, codexReceipt);
    assert.equal(piAppend.ok, true);
    assert.equal(piAppend.isDuplicate, false);
    assert.equal(codexAppend.ok, true);
    assert.equal(codexAppend.isDuplicate, false);
    const totals = ledger.aggregateTokenUsage(root);
    assert.equal(totals.receipt_count, 2);
    assert.equal(totals.input_tokens, 28);
    assert.equal(totals.output_tokens, 8);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-012: nested unknown/private fields fail closed", () => {
  const adapter = shadow.createCodexShadowAdapter();
  assert.throws(
    () => adapter.normalizeUsage({ usage: { input_tokens: 1, prompt: "private body" } }),
    (error) => error.code === "shadow_input_rejected" && error.fields.includes("usage.prompt"),
  );
  assert.throws(
    () => adapter.normalizeUsage({ usage: { input_tokens: 1, password: "plain-value" } }),
    (error) => error.code === "shadow_input_rejected" && error.fields.includes("root.usage.password"),
  );
});

test("VC-012: credential patterns and private absolute paths fail closed", () => {
  const adapter = shadow.createPiJsonShadowAdapter();
  for (const model of [
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "/Users/private-user/project/model",
    "https://user:pass@example.test/model",
  ]) {
    assert.throws(
      () => adapter.normalizeUsage({ model, input_tokens: 1 }),
      (error) => error.code === "shadow_input_rejected",
    );
  }
});

test("VC-012: normalized results and receipts never retain the raw payload", () => {
  const adapter = shadow.createCodexShadowAdapter();
  const raw = { usage: { input_tokens: 10 }, model: "safe-model" };
  const result = adapter.normalizeUsage(raw);
  const receipt = adapter.createShadowReceipt({ attempt_id: "attempt-no-raw", raw_usage: raw });
  assert.equal(Object.hasOwn(result, "raw"), false);
  assert.equal(Object.hasOwn(receipt, "raw"), false);
  assert.equal(JSON.stringify(result).includes("safe-model"), false);
  assertValidReceipt(receipt);
});

test("VC-012: rejected input cannot be converted into a receipt", () => {
  const adapter = shadow.createCodexShadowAdapter();
  assert.throws(
    () => adapter.createShadowReceipt({
      attempt_id: "attempt-rejected",
      raw_usage: { api_key: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" },
    }),
    (error) => error.code === "shadow_input_rejected",
  );
});

test("VC-013: unsupported total_tokens remains unavailable and is never split or inferred", () => {
  const adapter = shadow.createCodexShadowAdapter();
  const result = adapter.normalizeUsage({ total_tokens: 1000 });
  const receipt = adapter.createShadowReceipt({
    attempt_id: "attempt-total-only",
    raw_usage: { total_tokens: 1000 },
  });
  assert.deepEqual(result.unsupportedFields, ["total_tokens"]);
  assert.equal(result.usage.input_tokens, 0);
  assert.equal(result.usage.output_tokens, 0);
  assert.equal(receipt.status, "unavailable");
  assert.equal(receipt.usage.host_reported_input_tokens, "unknown");
  assert.equal(receipt.usage.host_reported_output_tokens, "unknown");
  assertValidReceipt(receipt);
});

test("VC-013: partial reports preserve each unsupported field as unknown", () => {
  const receipt = shadow.createPiJsonShadowAdapter().createShadowReceipt({
    attempt_id: "attempt-partial",
    raw_usage: { input_tokens: 0 },
  });
  assert.equal(receipt.status, "host_reported");
  assert.equal(receipt.usage.host_reported_input_tokens, 0);
  assert.equal(receipt.usage.host_reported_output_tokens, "unknown");
  assert.equal(receipt.usage.host_reported_cache_tokens, "unknown");
  assertValidReceipt(receipt);
});

test("VC-013: invalid or dirty counts fail closed instead of becoming zero", () => {
  const adapter = shadow.createPiJsonShadowAdapter();
  for (const value of [-1, 1.5, "1,000", "7,29000000", true]) {
    assert.throws(
      () => adapter.normalizeUsage({ input_tokens: value }),
      (error) => error.code === "invalid_usage_count",
    );
  }
});

test("VC-014: retry and process restart derive the same receipt id and ledger does not double count", () => {
  const root = tempLedger();
  try {
    const input = {
      attempt_id: "attempt-restart",
      delivery_id: "host-delivery-42",
      raw_usage: { usage: { input_tokens: 30, output_tokens: 7 } },
      recorded_at: "2026-08-14T02:00:00.000Z",
    };
    const first = shadow.createCodexShadowAdapter().createShadowReceipt(input);
    const afterRestart = shadow.createCodexShadowAdapter().createShadowReceipt(input);
    assert.equal(first.receipt_id, afterRestart.receipt_id);
    const firstAppend = ledger.appendReceipt(root, first);
    const replayAppend = ledger.appendReceipt(root, afterRestart);
    assert.equal(firstAppend.ok, true);
    assert.equal(firstAppend.isDuplicate, false);
    assert.equal(replayAppend.ok, false);
    assert.equal(replayAppend.error, "duplicate_receipt");
    assert.equal(replayAppend.isDuplicate, true);
    const totals = ledger.aggregateTokenUsage(root);
    assert.equal(totals.receipt_count, 1);
    assert.equal(totals.input_tokens, 30);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-014: distinct host delivery ids remain distinct receipts", () => {
  const adapter = shadow.createCodexShadowAdapter();
  const common = { attempt_id: "attempt-many", raw_usage: { input_tokens: 2 } };
  const first = adapter.createShadowReceipt({ ...common, delivery_id: "delivery-1" });
  const second = adapter.createShadowReceipt({ ...common, delivery_id: "delivery-2" });
  assert.notEqual(first.receipt_id, second.receipt_id);
});

test("VC-015: capability discovery is explicit and never inferred from a binary or private store", () => {
  const unavailable = shadow.createPiJsonShadowAdapter().detectUsage();
  const available = shadow.createPiJsonShadowAdapter({ usageCapability: "available" }).detectUsage();
  assert.equal(unavailable.status, "unavailable");
  assert.equal(available.status, "available");
});

test("VC-015: adapters do not mutate input or constructor options", () => {
  const options = { usageCapability: "available" };
  const raw = { usage: { input_tokens: 4 } };
  const copy = JSON.parse(JSON.stringify(raw));
  const adapter = shadow.createPiJsonShadowAdapter(options);
  options.usageCapability = "unavailable";
  adapter.normalizeUsage(raw);
  assert.deepEqual(raw, copy);
  assert.equal(adapter.detectUsage().status, "available");
});

test("VC-015: shadow adapter implementation contains no execution-policy or Host storage primitives", () => {
  const sourceRoot = path.join(__dirname, "../../../lib/host-adapter/shadow-usage");
  const source = [
    fs.readFileSync(path.join(__dirname, "../../../lib/host-adapter/shadow-usage.js"), "utf8"),
    ...fs.readdirSync(sourceRoot).map((name) => fs.readFileSync(path.join(sourceRoot, name), "utf8")),
  ].join("\n");
  for (const forbidden of [
    /child_process/, /spawn(?:Sync)?\s*\(/, /exec(?:File|Sync)?\s*\(/,
    /\.pi\/agent\/sessions/, /\.claude\/projects/, /\.codex\//,
    /context[_-](?:select|compact)/, /fan[_-]?out/, /stop[_-]?behavior/,
  ]) {
    assert.equal(forbidden.test(source), false, `forbidden primitive: ${forbidden}`);
  }
});
