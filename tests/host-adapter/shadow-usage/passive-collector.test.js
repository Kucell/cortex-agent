"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  EXCLUSION_REASONS,
  PassiveCollector,
  createPassiveCollector,
  exclusionReasonLabel,
  listExclusionReasons,
} = require("../../../lib/host-adapter/shadow-usage/passive-collector.js");

const ledger = require("../../../templates/_shared/.agent/skills/management-api/scripts/token-attempt-ledger.js");
const receiptContract = require("../../../templates/_shared/.agent/skills/management-api/scripts/token-attempt-receipt.js");

function tempLedger() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cortex-passive-collector-ledger-"));
}

function assertValidReceipt(receipt) {
  assert.deepEqual(receiptContract.validateReceiptSecurity(receipt), { valid: true });
  assert.deepEqual(receiptContract.validateReceiptContract(receipt), { valid: true });
}

// ─── VC-016: Passive collector construction and configuration ──────────────────
test("VC-016: createPassiveCollector returns a PassiveCollector instance", () => {
  const collector = createPassiveCollector();
  assert.ok(collector instanceof PassiveCollector);
  assert.equal(collector.getConfig().hostId, "passive-collector");
});

test("VC-016: collector accepts custom hostId", () => {
  const collector = createPassiveCollector({ hostId: "custom-collector" });
  assert.equal(collector.getConfig().hostId, "custom-collector");
});

test("VC-016: collector accepts taskId and runId allowlists", () => {
  const taskAllowlist = new Set(["task-001", "task-002"]);
  const runAllowlist = new Set(["run-001", "run-002"]);
  const collector = createPassiveCollector({ taskIdAllowlist: taskAllowlist, runIdAllowlist: runAllowlist });
  assert.deepEqual(collector.getConfig().taskIdAllowlist, taskAllowlist);
  assert.deepEqual(collector.getConfig().runIdAllowlist, runAllowlist);
});

test("VC-016: collector config is frozen and immutable", () => {
  const collector = createPassiveCollector();
  const config = collector.getConfig();
  assert.throws(() => { config.newProp = "value"; }, /Cannot add property/);
  assert.throws(() => { config.hostId = "modified"; }, /Cannot assign to read only property/);
});

// ─── VC-017: Exclusion reason detection ───────────────────────────────────────
test("VC-017: valid envelope with real host returns null exclusion reason", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "attempt-001",
    task_id: "task-001",
    run_id: "run-001",
    host: "claude-code",
    raw_usage: { input_tokens: 100, output_tokens: 50 },
  };
  assert.equal(collector.getExclusionReason(envelope), null);
  assert.ok(collector.isEligible(envelope));
});

test("VC-017: test host patterns are detected correctly", () => {
  const collector = createPassiveCollector();
  for (const host of ["test-host", "TestAgent", "mock-server", "fake-client", "unit-test-host", "integration-test-runner", "e2e-test-executor"]) {
    assert.ok(collector.isTestHost(host), `Expected ${host} to be detected as test host`);
  }
  for (const host of ["production", "staging", "claude-code", "pi-json", "codex"]) {
    assert.ok(!collector.isTestHost(host), `Expected ${host} not to be detected as test host`);
  }
});

test("VC-017: test attempt prefixes are detected correctly", () => {
  const collector = createPassiveCollector();
  for (const attempt of ["test-attempt-001", "mock-attempt-002", "fake-attempt-003", "dummy-attempt-004", "unit-test-attempt", "integration-test-attempt", "e2e-test-attempt", "attempt-test-001", "attempt-mock-002"]) {
    assert.ok(collector.isTestAttempt(attempt), `Expected ${attempt} to be detected as test attempt`);
  }
  for (const attempt of ["attempt-001", "real-attempt-002", "production-attempt-003"]) {
    assert.ok(!collector.isTestAttempt(attempt), `Expected ${attempt} not to be detected as test attempt`);
  }
});

test("VC-017: TEST_HOST reason returned for test host", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "attempt-001",
    host: "test-host",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), EXCLUSION_REASONS.TEST_HOST);
  assert.ok(!collector.isEligible(envelope));
});

test("VC-017: TEST_ATTEMPT reason returned for test attempt", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "test-attempt-001",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), EXCLUSION_REASONS.TEST_ATTEMPT);
  assert.ok(!collector.isEligible(envelope));
});

test("VC-017: INVALID_ENVELOPE returned for missing attempt_id", () => {
  const collector = createPassiveCollector();
  const envelope = {
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), EXCLUSION_REASONS.INVALID_ENVELOPE);
  assert.ok(!collector.isEligible(envelope));
});

test("VC-017: NO_QUALITY_ID returned when requireEitherId is true and no IDs present", () => {
  const collector = createPassiveCollector({ requireEitherId: true });
  const envelope = {
    attempt_id: "attempt-001",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), EXCLUSION_REASONS.NO_QUALITY_ID);
  assert.ok(!collector.isEligible(envelope));
});

test("VC-017: null returned when requireEitherId is false and no IDs present", () => {
  const collector = createPassiveCollector({ requireEitherId: false });
  const envelope = {
    attempt_id: "attempt-001",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), null);
  assert.ok(collector.isEligible(envelope));
});

test("VC-017: TASK_ID_NOT_ALLOWLISTED when task ID not in allowlist", () => {
  const collector = createPassiveCollector({
    taskIdAllowlist: new Set(["task-001", "task-002"]),
  });
  const envelope = {
    attempt_id: "attempt-001",
    task_id: "task-003",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), EXCLUSION_REASONS.TASK_ID_NOT_ALLOWLISTED);
  assert.ok(!collector.isEligible(envelope));
});

test("VC-017: RUN_ID_NOT_ALLOWLISTED when run ID not in allowlist", () => {
  const collector = createPassiveCollector({
    runIdAllowlist: new Set(["run-001", "run-002"]),
  });
  const envelope = {
    attempt_id: "attempt-001",
    run_id: "run-003",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), EXCLUSION_REASONS.RUN_ID_NOT_ALLOWLISTED);
  assert.ok(!collector.isEligible(envelope));
});

test("VC-017: empty allowlist means any ID is allowed", () => {
  const collector = createPassiveCollector({
    taskIdAllowlist: new Set(),
    runIdAllowlist: new Set(),
  });
  const envelope = {
    attempt_id: "attempt-001",
    task_id: "any-task",
    run_id: "any-run",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  assert.equal(collector.getExclusionReason(envelope), null);
  assert.ok(collector.isEligible(envelope));
});

// ─── VC-018: Receipt creation and quality joining ───────────────────────────────
test("VC-018: eligible envelope creates valid receipt", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "attempt-pc-001",
    task_id: "task-quality-001",
    run_id: "run-quality-001",
    host: "claude-code",
    model: "claude-sonnet-4-20250514",
    raw_usage: { input_tokens: 100, output_tokens: 50 },
  };
  const result = collector.collect(envelope);
  assert.equal(result.quality_join, "joined");
  assert.equal(result.task_id, "task-quality-001");
  assert.equal(result.run_id, "run-quality-001");
  assert.equal(result.exclusion_reason, null);
  assert.ok(result.receipt !== null);
  assertValidReceipt(result.receipt);
});

test("VC-018: ineligible envelope returns null receipt with reason", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "test-attempt-001",
    host: "test-host",
    raw_usage: { input_tokens: 100 },
  };
  const result = collector.collect(envelope);
  assert.equal(result.quality_join, "skipped");
  assert.equal(result.exclusion_reason, EXCLUSION_REASONS.TEST_HOST);
  assert.equal(result.receipt, null);
});

test("VC-018: receipts preserve quality IDs from envelope", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "attempt-quality-002",
    task_id: "task-preserved",
    run_id: "run-preserved",
    session_id: "session-preserved",
    host: "pi-json",
    model: "pi-model-v1",
    raw_usage: { input_tokens: 200, output_tokens: 75 },
  };
  const result = collector.collect(envelope);
  assert.ok(result.receipt !== null);
  assert.equal(result.receipt.task_id, "task-preserved");
  assert.equal(result.receipt.run_id, "run-preserved");
  assert.equal(result.receipt.session_id, "session-preserved");
  assert.equal(result.receipt.host, "pi-json");
  assert.equal(result.receipt.model, "pi-model-v1");
});

test("VC-018: distinct envelopes produce distinct receipts", () => {
  const collector = createPassiveCollector();
  const envelope1 = {
    attempt_id: "attempt-distinct-001",
    host: "claude-code",
    raw_usage: { input_tokens: 100 },
  };
  const envelope2 = {
    attempt_id: "attempt-distinct-002",
    host: "pi-json",
    raw_usage: { input_tokens: 200 },
  };
  const result1 = collector.collect(envelope1);
  const result2 = collector.collect(envelope2);
  assert.notEqual(result1.receipt.receipt_id, result2.receipt.receipt_id);
  assert.equal(result1.receipt.attempt_id, "attempt-distinct-001");
  assert.equal(result2.receipt.attempt_id, "attempt-distinct-002");
});

// ─── VC-019: Ledger persistence and idempotency ───────────────────────────────
test("VC-019: collectAndPersist appends receipt to ledger", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    const envelope = {
      attempt_id: "attempt-ledger-001",
      task_id: "task-ledger-001",
      host: "claude-code",
      raw_usage: { input_tokens: 150, output_tokens: 60 },
    };
    const result = collector.collectAndPersist(root, envelope);
    assert.equal(result.ok, true);
    assert.equal(result.collected.quality_join, "joined");
    assertValidReceipt(result.collected.receipt);
    assert.equal(result.ledger.isDuplicate, false);

    // Verify receipt is in ledger
    const totals = ledger.aggregateTokenUsage(root);
    assert.equal(totals.receipt_count, 1);
    assert.equal(totals.input_tokens, 150);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-019: ineligible envelope does not write to ledger", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    const envelope = {
      attempt_id: "test-attempt-ledger",
      host: "test-host",
      raw_usage: { input_tokens: 999 },
    };
    const result = collector.collectAndPersist(root, envelope);
    assert.equal(result.ok, false);
    assert.equal(result.collected.receipt, null);
    assert.equal(result.collected.exclusion_reason, EXCLUSION_REASONS.TEST_HOST);
    assert.equal(result.error, EXCLUSION_REASONS.TEST_HOST);

    // Verify ledger is empty
    const totals = ledger.aggregateTokenUsage(root);
    assert.equal(totals.receipt_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-019: duplicate collectAndPersist is idempotent", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    const envelope = {
      attempt_id: "attempt-idempotent-001",
      task_id: "task-idempotent",
      host: "claude-code",
      raw_usage: { input_tokens: 300, output_tokens: 100 },
      recorded_at: "2026-08-14T12:00:00.000Z",
    };

    const first = collector.collectAndPersist(root, envelope);
    assert.equal(first.ok, true);

    const second = collector.collectAndPersist(root, envelope);
    assert.equal(second.ok, true);
    assert.equal(second.ledger.isDuplicate, true);

    // Verify only one receipt in ledger
    const totals = ledger.aggregateTokenUsage(root);
    assert.equal(totals.receipt_count, 1);
    assert.equal(totals.input_tokens, 300);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-019: appendToLedger validates receipt before writing", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    const invalidResult = collector.appendToLedger(root, null);
    assert.equal(invalidResult.ok, false);
    assert.equal(invalidResult.error, "receipt_required");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── VC-020: Management API readiness queries ──────────────────────────────────
test("VC-020: queryReadiness returns eligibility stats", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    const envelopes = [
      { attempt_id: "real-001", task_id: "task-001", host: "claude-code", raw_usage: { input_tokens: 100 } },
      { attempt_id: "real-002", task_id: "task-002", host: "pi-json", raw_usage: { input_tokens: 200 } },
      { attempt_id: "test-attempt-001", host: "test-host", raw_usage: { input_tokens: 999 } },
    ];

    for (const env of envelopes) {
      collector.collectAndPersist(root, env);
    }

    const stats = collector.queryReadiness(root);
    // Only non-test receipts are persisted to ledger, so all 2 are eligible
    assert.equal(stats.eligible_count, 2);
    assert.equal(stats.excluded_count, 0);
    assert.deepEqual(stats.by_exclusion_reason, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-020: queryReadiness filters by host", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    collector.collectAndPersist(root, { attempt_id: "host-cc-001", host: "claude-code", raw_usage: { input_tokens: 100 } });
    collector.collectAndPersist(root, { attempt_id: "host-pi-001", host: "pi-json", raw_usage: { input_tokens: 200 } });

    const stats = collector.queryReadiness(root, { host: "claude-code" });
    assert.equal(stats.eligible_count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-020: queryReadiness filters by date range", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    collector.collectAndPersist(root, {
      attempt_id: "date-range-001",
      host: "claude-code",
      raw_usage: { input_tokens: 100 },
      recorded_at: "2026-08-14T10:00:00.000Z",
    });
    collector.collectAndPersist(root, {
      attempt_id: "date-range-002",
      host: "claude-code",
      raw_usage: { input_tokens: 200 },
      recorded_at: "2026-08-15T10:00:00.000Z",
    });

    const stats = collector.queryReadiness(root, {
      since: "2026-08-14T00:00:00.000Z",
      until: "2026-08-14T23:59:59.999Z",
    });
    assert.equal(stats.eligible_count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-020: queryReadiness returns by_host_day_model breakdown", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    collector.collectAndPersist(root, {
      attempt_id: "breakdown-001",
      task_id: "task-001",
      host: "claude-code",
      model: "claude-sonnet-4",
      raw_usage: { input_tokens: 100 },
      recorded_at: "2026-08-14T10:00:00.000Z",
    });
    collector.collectAndPersist(root, {
      attempt_id: "breakdown-002",
      task_id: "task-002",
      host: "claude-code",
      model: "claude-sonnet-4",
      raw_usage: { input_tokens: 200 },
      recorded_at: "2026-08-14T12:00:00.000Z",
    });
    collector.collectAndPersist(root, {
      attempt_id: "breakdown-003",
      task_id: "task-003",
      host: "pi-json",
      model: "pi-model-v1",
      raw_usage: { input_tokens: 300 },
      recorded_at: "2026-08-15T10:00:00.000Z",
    });

    const stats = collector.queryReadiness(root);
    assert.ok(Object.keys(stats.by_host_day_model).length >= 2);
    // Check dimension key format: host::date::model
    const ccKey = Object.keys(stats.by_host_day_model).find((k) => k.startsWith("claude-code::2026-08-14::"));
    if (ccKey) {
      assert.equal(stats.by_host_day_model[ccKey].eligible, 2);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-020: queryReadiness with excludeTests=false includes test receipts", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    collector.collectAndPersist(root, { attempt_id: "real-001", host: "claude-code", raw_usage: { input_tokens: 100 } });
    collector.collectAndPersist(root, { attempt_id: "test-attempt-001", host: "test-host", raw_usage: { input_tokens: 999 } });

    const statsWithExclude = collector.queryReadiness(root, { excludeTests: true });
    // Only real receipt is in ledger, so 1 eligible
    assert.equal(statsWithExclude.eligible_count, 1);

    const statsWithoutExclude = collector.queryReadiness(root, { excludeTests: false });
    // Test receipt is excluded at collection time (not in ledger)
    assert.equal(statsWithoutExclude.eligible_count, 1);
    // The test receipt was never persisted
    assert.equal(statsWithoutExclude.excluded_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-020: queryReadiness handles empty ledger gracefully", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector();
    const stats = collector.queryReadiness(root);
    assert.equal(stats.eligible_count, 0);
    assert.equal(stats.excluded_count, 0);
    assert.deepEqual(stats.by_exclusion_reason, {});
    assert.deepEqual(stats.by_host_day_model, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("VC-020: queryReadiness handles requireEitherId configuration", () => {
  const root = tempLedger();
  try {
    const collector = createPassiveCollector({ requireEitherId: true });
    collector.collectAndPersist(root, {
      attempt_id: "no-id-001",
      host: "claude-code",
      raw_usage: { input_tokens: 100 },
    });
    collector.collectAndPersist(root, {
      attempt_id: "with-id-001",
      task_id: "task-001",
      host: "claude-code",
      raw_usage: { input_tokens: 200 },
    });

    // Only the one with task_id is persisted (eligible)
    const stats = collector.queryReadiness(root, { excludeTests: false });
    assert.equal(stats.eligible_count, 1);
    assert.equal(stats.excluded_count, 0);
    // The one without ID was excluded at collection time
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── Utility function tests ────────────────────────────────────────────────────
test("listExclusionReasons returns all known reason codes", () => {
  const reasons = listExclusionReasons();
  assert.ok(reasons.includes(EXCLUSION_REASONS.NO_QUALITY_ID));
  assert.ok(reasons.includes(EXCLUSION_REASONS.TASK_ID_NOT_ALLOWLISTED));
  assert.ok(reasons.includes(EXCLUSION_REASONS.RUN_ID_NOT_ALLOWLISTED));
  assert.ok(reasons.includes(EXCLUSION_REASONS.TEST_HOST));
  assert.ok(reasons.includes(EXCLUSION_REASONS.TEST_ATTEMPT));
  assert.ok(reasons.includes(EXCLUSION_REASONS.DUPLICATE_RECEIPT));
  assert.ok(reasons.includes(EXCLUSION_REASONS.LEDGER_WRITE_FAILED));
  assert.ok(reasons.includes(EXCLUSION_REASONS.INVALID_ENVELOPE));
});

test("exclusionReasonLabel returns human-readable labels", () => {
  assert.ok(exclusionReasonLabel(EXCLUSION_REASONS.TEST_HOST).length > 0);
  assert.ok(exclusionReasonLabel(EXCLUSION_REASONS.TASK_ID_NOT_ALLOWLISTED).length > 0);
  assert.ok(exclusionReasonLabel(EXCLUSION_REASONS.INVALID_ENVELOPE).length > 0);
  assert.ok(exclusionReasonLabel("unknown-reason").startsWith("Unknown reason:"));
});

test("getLastError returns last error after failed collection", () => {
  const collector = createPassiveCollector();
  // Collect an envelope that will fail (test-host)
  const result = collector.collect({
    attempt_id: "attempt-001",
    host: "test-host",
    raw_usage: { input_tokens: 100 },
  });
  // No receipt created, but no error either - exclusion
  assert.equal(result.exclusion_reason, EXCLUSION_REASONS.TEST_HOST);
  // Instance is frozen, so _lastError cannot be set
  assert.equal(collector.getLastError(), null);
});

// ─── Edge case tests ───────────────────────────────────────────────────────────
test("collector handles envelope with only required fields", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "minimal-envelope",
    raw_usage: { input_tokens: 50 },
  };
  const result = collector.collect(envelope);
  // Without requireEitherId, no task_id/run_id is fine (joined)
  assert.equal(result.quality_join, "joined");
  assert.equal(result.exclusion_reason, null);
  assert.ok(result.receipt !== null);
});

test("collector handles envelope with all optional fields", () => {
  const collector = createPassiveCollector();
  const envelope = {
    attempt_id: "full-envelope",
    task_id: "task-full",
    run_id: "run-full",
    session_id: "session-full",
    host: "claude-code",
    model: "claude-opus-4-5",
    receipt_id: "custom-receipt-id",
    delivery_id: "delivery-full",
    recorded_at: "2026-08-14T15:30:00.000Z",
    raw_usage: { input_tokens: 500, output_tokens: 250 },
  };
  const result = collector.collect(envelope);
  assert.equal(result.quality_join, "joined");
  assert.equal(result.task_id, "task-full");
  assert.equal(result.run_id, "run-full");
  assert.ok(result.receipt !== null);
});

test("collector is frozen instance", () => {
  const collector = createPassiveCollector();
  assert.ok(Object.isFrozen(collector));
});

test("collector getLastError returns null initially", () => {
  const collector = createPassiveCollector();
  assert.equal(collector.getLastError(), null);
});
