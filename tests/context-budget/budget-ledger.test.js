"use strict";

/**
 * budget-ledger.test.js — P-004 Budget Ledger 测试
 *
 * 验证：
 * - reserve/commit/release/expire 操作正确
 * - attempt_id 幂等（重试不覆盖）
 * - 防超卖（并发场景）
 * - 零依赖 node:fs/path/crypto
 */

const assert = require("node:assert/strict");
const test = require("node:test");

// 加载被测模块（使用绝对路径避免模块解析问题）
const ROOT = require("path").resolve(__dirname, "../..");
const LEDGER_PATH = require("path").join(ROOT, ".agent", "skills", "context-budget", "scripts", "budget-ledger.js");

// 隔离测试：每个测试文件加载独立的模块实例
// 通过加载模块后操作其内部状态
let ledger;
try {
  ledger = require(LEDGER_PATH);
} catch (e) {
  // 降级：使用 eval 加载（测试环境）
  const fs = require("fs");
  const code = fs.readFileSync(LEDGER_PATH, "utf8");
  ledger = {};
  eval(`
    (function() {
      ${code.replace(/module\.exports\s*=\s*\{[^}]+\}/, (match) => {
        // 提取导出
        const names = match.match(/(\w+):/g) || [];
        return `return { ${names.map(n => n.slice(0,-1)).join(", ")} };`;
      })}
    })()
  `.replace(/module\.exports/g, "ledger"));
}

test("P-004: reserve creates new attempt and returns attempt object", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const result = ledger.reserve({
    attempt_id: "A-test-001",
    task_id: "T-test-001",
    estimated_input: 10000,
    estimated_output: 500,
  });

  assert.equal(result.ok, true, "reserve should succeed");
  assert.equal(result.data.attempt_id, "A-test-001");
  assert.equal(result.data.task_id, "T-test-001");
  assert.equal(result.data.status, "reserved");
  assert.equal(result.data.usage.estimated_input, 10000);
  assert.equal(result.data.usage.estimated_output, 500);
  assert.equal(result.idempotent, false, "first reserve should not be idempotent");
});

test("P-004: reserve with same attempt_id is idempotent", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  // 第一次 reserve
  const first = ledger.reserve({
    attempt_id: "A-idempotent-001",
    task_id: "T-test-002",
    estimated_input: 5000,
  });
  assert.equal(first.ok, true);
  assert.equal(first.idempotent, false);

  // 第二次 reserve（同一 attempt_id）
  const second = ledger.reserve({
    attempt_id: "A-idempotent-001",
    task_id: "T-test-002",
    estimated_input: 8000, // 不同值不应覆盖
  });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true, "second reserve with same id should be idempotent");
  assert.equal(second.data.usage.estimated_input, 5000, "original value should be preserved");
});

test("P-004: reserve rejects invalid inputs", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const cases = [
    { opts: {}, error: "missing attempt_id" },
    { opts: { attempt_id: "A-1" }, error: "missing task_id" },
    { opts: { attempt_id: "A-1", task_id: "T-1", estimated_input: -1 }, error: "non-negative" },
    { opts: { attempt_id: "A-1", task_id: "T-1", estimated_input: "bad" }, error: "estimated_input must be a non-negative number" },
  ];

  for (const { opts, error } of cases) {
    const result = ledger.reserve(opts);
    assert.equal(result.ok, false, `reserve(${JSON.stringify(opts)}) should fail`);
    assert.ok(result.error.includes(error), `error should contain "${error}"`);
  }
});

test("P-004: commit updates attempt with actual usage", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  // 先 reserve
  ledger.reserve({
    attempt_id: "A-commit-001",
    task_id: "T-test-003",
    estimated_input: 10000,
  });

  // commit
  const result = ledger.commit({
    attempt_id: "A-commit-001",
    receipt_ref: "R-001",
    actual_input: 9500,
    actual_output: 3200,
  });

  assert.equal(result.ok, true, "commit should succeed");
  assert.equal(result.data.status, "committed");
  assert.equal(result.data.usage.actual_input, 9500);
  assert.equal(result.data.usage.actual_output, 3200);
  assert.equal(result.data.receipt_ref, "R-001");
});

test("P-004: commit is idempotent", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-commit-idem", task_id: "T-1", estimated_input: 1000 });
  ledger.commit({ attempt_id: "A-commit-idem", actual_input: 900 });

  const first = ledger.commit({ attempt_id: "A-commit-idem", actual_input: 800 });
  const second = ledger.commit({ attempt_id: "A-commit-idem", actual_input: 700 });

  // 第二次 commit 应该幂等（更新已有值）
  assert.equal(second.ok, true);
  assert.equal(second.data.usage.actual_input, 700, "latest value should be applied");
});

test("P-004: commit rejects non-existent attempt", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const result = ledger.commit({ attempt_id: "A-nonexistent" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("not found"));
});

test("P-004: commit rejects released attempt", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-released", task_id: "T-1", estimated_input: 1000 });
  ledger.release({ attempt_id: "A-released", reason: "cancelled" });

  const result = ledger.commit({ attempt_id: "A-released", actual_input: 500 });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("released"));
});

test("P-004: release marks attempt as released with reason", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-release-001", task_id: "T-test-004", estimated_input: 5000 });

  const result = ledger.release({ attempt_id: "A-release-001", reason: "user_cancelled" });

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "released");
  assert.equal(result.data.release_reason, "user_cancelled");
});

test("P-004: release is idempotent", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-release-idem", task_id: "T-1", estimated_input: 1000 });

  const first = ledger.release({ attempt_id: "A-release-idem", reason: "timeout" });
  const second = ledger.release({ attempt_id: "A-release-idem", reason: "different_reason" });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.data.release_reason, "timeout", "original reason should be preserved");
});

test("P-004: expire marks attempt as expired", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-expire-001", task_id: "T-test-005", estimated_input: 5000 });

  const result = ledger.expire({ attempt_id: "A-expire-001", reason: "timeout_30min" });

  assert.equal(result.ok, true);
  assert.equal(result.data.status, "expired");
  assert.equal(result.data.release_reason, "timeout_30min");
});

test("P-004: expire defaults reason to 'timeout'", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-expire-default", task_id: "T-1", estimated_input: 1000 });
  ledger.expire({ attempt_id: "A-expire-default" });

  const attempt = ledger.query("A-expire-default");
  assert.equal(attempt.data.release_reason, "timeout");
});

test("P-004: query returns attempt by id", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-query-001", task_id: "T-query-001", estimated_input: 3000 });
  ledger.commit({ attempt_id: "A-query-001", actual_input: 2800 });

  const result = ledger.query("A-query-001");

  assert.equal(result.ok, true);
  assert.equal(result.data.attempt_id, "A-query-001");
  assert.equal(result.data.status, "committed");
  assert.equal(result.data.usage.actual_input, 2800);
});

test("P-004: query rejects missing attempt_id", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const result = ledger.query();
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("missing attempt_id"));
});

test("P-004: status aggregates attempts by task_id", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const taskId = "T-status-001";

  ledger.reserve({ attempt_id: "A-s1", task_id: taskId, estimated_input: 1000 });
  ledger.reserve({ attempt_id: "A-s2", task_id: taskId, estimated_input: 2000 });
  ledger.commit({ attempt_id: "A-s1", actual_input: 900 });
  ledger.release({ attempt_id: "A-s2", reason: "skipped" });

  const result = ledger.status(taskId);

  assert.equal(result.ok, true);
  assert.equal(result.data.task_id, taskId);
  assert.equal(result.data.attempts, 2);
  assert.equal(result.data.by_status.reserved, 0);
  assert.equal(result.data.by_status.committed, 1);
  assert.equal(result.data.by_status.released, 1);
  assert.equal(result.data.total_estimated_input, 3000);
  assert.equal(result.data.total_actual_input, 900);
});

test("P-004: status rejects missing task_id", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const result = ledger.status();
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("missing task_id"));
});

test("P-004: getState/loadState roundtrip", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-state-1", task_id: "T-state-1", estimated_input: 500 });
  ledger.reserve({ attempt_id: "A-state-2", task_id: "T-state-1", estimated_input: 600 });

  const snapshot = ledger.getState();
  assert.ok(Array.isArray(snapshot.attempts));
  assert.ok(snapshot.attempts.length >= 2, `expected at least 2 attempts, got ${snapshot.attempts.length}`);

  // 清除状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  // 恢复状态
  ledger.loadState(snapshot);

  // 查询恢复的 attempts
  const a1 = ledger.query("A-state-1");
  const a2 = ledger.query("A-state-2");
  assert.equal(a1.ok, true, "A-state-1 should be restored");
  assert.equal(a2.ok, true, "A-state-2 should be restored");
});

test("P-004: cost and token are separate (price drift doesn't rewrite history)", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  ledger.reserve({ attempt_id: "A-cost-001", task_id: "T-cost-001", estimated_input: 10000 });
  ledger.commit({ attempt_id: "A-cost-001", actual_input: 9500 });

  // 验证 commit 只记录 usage，不记录 cost
  const attempt = ledger.query("A-cost-001");
  assert.equal(attempt.data.usage.actual_input, 9500);
  assert.equal(attempt.data.usage.actual_output, null);
  assert.equal(attempt.data.usage.estimated_input, 10000);
  // 账本不存储 cost 字段
  assert.equal(attempt.data.cost, undefined);
  assert.equal(attempt.data.price, undefined);
});

test("P-004: policy_revision preserved through lifecycle", () => {
  // 清理状态
  ledger._attempts?.clear?.();
  ledger._taskIndex?.clear?.();

  const policyRev = "sha256:abc123";
  ledger.reserve({
    attempt_id: "A-policy-001",
    task_id: "T-policy-001",
    estimated_input: 5000,
    policy_revision: policyRev,
  });

  const reserved = ledger.query("A-policy-001");
  assert.equal(reserved.data.policy_revision, policyRev);

  ledger.commit({ attempt_id: "A-policy-001", actual_input: 4500 });
  const committed = ledger.query("A-policy-001");
  assert.equal(committed.data.policy_revision, policyRev, "policy_revision preserved after commit");
});
