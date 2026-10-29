#!/usr/bin/env node
/**
 * budget-ledger.js — P-004 Budget Policy: 幂等预算账本
 *
 * 提供 reserve/commit/release/expire 操作，attempt_id 幂等，防超卖。
 * 零依赖 node:fs / node:path / node:crypto。
 *
 * 设计约束（P-004 §2）：
 * - 调用前 reserve(estimated upper bound)，成功后 commit(actual)，失败/取消 release，超时 expire
 * - 幂等键为 attempt_id；重试创建新 attempt，不覆盖原账
 * - hard budget 不能只靠最终异步聚合判断，避免并发超卖
 * - cost 与 token 分开；模型价格漂移不改写历史原始 usage
 *
 * 用法：
 *   node budget-ledger.js reserve --attempt-id <id> --estimated-input <tokens> [--policy-revision <sha>]
 *   node budget-ledger.js commit --attempt-id <id> --receipt-ref <ref> --actual-input <tokens> [--actual-output <tokens>]
 *   node budget-ledger.js release --attempt-id <id> --reason <string>
 *   node budget-ledger.js expire --attempt-id <id> --reason <string>
 *   node budget-ledger.js query --attempt-id <id>
 *   node budget-ledger.js status --task-id <id>
 *
 * 输出：JSON 到 stdout，ok + data 或 ok: false + error
 */

"use strict";

// ---------------------------------------------------------------------------
// 内部状态（内存中，非持久化；调用方负责持久化到 .agent/skills/context-budget/state/）
// ---------------------------------------------------------------------------

/** @type {Map<string, Attempt>} */
const _attempts = new Map();

/** @type {Map<string, Map<string, Attempt>>} taskAttempts 按 task_id 分组 */
const _taskIndex = new Map();

/**
 * @typedef {Object} TokenUsage
 * @property {number|null} estimated_input
 * @property {number|null} estimated_output
 * @property {number|null} actual_input
 * @property {number|null} actual_output
 */

/**
 * @typedef {Object} Attempt
 * @property {string} attempt_id
 * @property {string} task_id
 * @property {string} status  'reserved' | 'committed' | 'released' | 'expired'
 * @property {string|null} policy_revision
 * @property {TokenUsage} usage
 * @property {string|null} receipt_ref
 * @property {string|null} release_reason
 * @property {string} created_at
 * @property {string|null} updated_at
 */

// ---------------------------------------------------------------------------
// 核心操作
// ---------------------------------------------------------------------------

/**
 * reserve — 预留预算
 * 幂等：同一 attempt_id 再次 reserve 返回已有记录（不覆盖）
 *
 * @param {Object} opts
 * @param {string} opts.attempt_id
 * @param {string} opts.task_id
 * @param {number} opts.estimated_input  估算输入 token 上界
 * @param {number} [opts.estimated_output]
 * @param {string} [opts.policy_revision]
 * @returns {{ ok: boolean, data?: Attempt, error?: string, idempotent?: boolean }}
 */
function reserve(opts) {
  const { attempt_id, task_id, estimated_input, estimated_output, policy_revision } = opts;

  if (!attempt_id) return { ok: false, error: "missing attempt_id" };
  if (!task_id) return { ok: false, error: "missing task_id" };
  if (typeof estimated_input !== "number" || estimated_input < 0) {
    return { ok: false, error: "estimated_input must be a non-negative number" };
  }

  // 幂等检查
  if (_attempts.has(attempt_id)) {
    const existing = _attempts.get(attempt_id);
    return { ok: true, data: existing, idempotent: true };
  }

  const now = new Date().toISOString();
  /** @type {Attempt} */
  const attempt = {
    attempt_id,
    task_id,
    status: "reserved",
    policy_revision: policy_revision || null,
    usage: {
      estimated_input: estimated_input,
      estimated_output: estimated_output || null,
      actual_input: null,
      actual_output: null,
    },
    receipt_ref: null,
    release_reason: null,
    created_at: now,
    updated_at: null,
  };

  _attempts.set(attempt_id, attempt);

  if (!_taskIndex.has(task_id)) _taskIndex.set(task_id, new Map());
  _taskIndex.get(task_id).set(attempt_id, attempt);

  return { ok: true, data: attempt, idempotent: false };
}

/**
 * commit — 确认实际使用量
 * 幂等：同一 attempt_id 再次 commit 更新现有记录
 *
 * @param {Object} opts
 * @param {string} opts.attempt_id
 * @param {string} [opts.receipt_ref]
 * @param {number} [opts.actual_input]
 * @param {number} [opts.actual_output]
 * @returns {{ ok: boolean, data?: Attempt, error?: string }}
 */
function commit(opts) {
  const { attempt_id, receipt_ref, actual_input, actual_output } = opts;

  if (!attempt_id) return { ok: false, error: "missing attempt_id" };

  const attempt = _attempts.get(attempt_id);
  if (!attempt) return { ok: false, error: `attempt ${attempt_id} not found` };

  if (attempt.status === "released" || attempt.status === "expired") {
    return { ok: false, error: `cannot commit ${attempt.status} attempt` };
  }

  attempt.status = "committed";
  attempt.updated_at = new Date().toISOString();

  if (typeof actual_input === "number" && actual_input >= 0) {
    attempt.usage.actual_input = actual_input;
  }
  if (typeof actual_output === "number" && actual_output >= 0) {
    attempt.usage.actual_output = actual_output;
  }
  if (receipt_ref) {
    attempt.receipt_ref = receipt_ref;
  }

  return { ok: true, data: attempt };
}

/**
 * release — 释放未使用的预留
 *
 * @param {Object} opts
 * @param {string} opts.attempt_id
 * @param {string} opts.reason
 * @returns {{ ok: boolean, data?: Attempt, error?: string }}
 */
function release(opts) {
  const { attempt_id, reason } = opts;

  if (!attempt_id) return { ok: false, error: "missing attempt_id" };
  if (!reason) return { ok: false, error: "missing reason" };

  const attempt = _attempts.get(attempt_id);
  if (!attempt) return { ok: false, error: `attempt ${attempt_id} not found` };

  if (attempt.status === "released" || attempt.status === "expired") {
    // 幂等
    return { ok: true, data: attempt, idempotent: true };
  }

  attempt.status = "released";
  attempt.release_reason = reason;
  attempt.updated_at = new Date().toISOString();

  return { ok: true, data: attempt };
}

/**
 * expire — 超时自动失效
 *
 * @param {Object} opts
 * @param {string} opts.attempt_id
 * @param {string} [opts.reason]
 * @returns {{ ok: boolean, data?: Attempt, error?: string }}
 */
function expire(opts) {
  const { attempt_id, reason } = opts;

  if (!attempt_id) return { ok: false, error: "missing attempt_id" };

  const attempt = _attempts.get(attempt_id);
  if (!attempt) return { ok: false, error: `attempt ${attempt_id} not found` };

  if (attempt.status === "released" || attempt.status === "expired") {
    return { ok: true, data: attempt, idempotent: true };
  }

  attempt.status = "expired";
  attempt.release_reason = reason || "timeout";
  attempt.updated_at = new Date().toISOString();

  return { ok: true, data: attempt };
}

/**
 * query — 查询单个 attempt
 *
 * @param {string} attempt_id
 * @returns {{ ok: boolean, data?: Attempt, error?: string }}
 */
function query(attempt_id) {
  if (!attempt_id) return { ok: false, error: "missing attempt_id" };
  const attempt = _attempts.get(attempt_id);
  if (!attempt) return { ok: false, error: `attempt ${attempt_id} not found` };
  return { ok: true, data: attempt };
}

/**
 * status — 按 task_id 查询所有 attempt 汇总
 *
 * @param {string} task_id
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function status(task_id) {
  if (!task_id) return { ok: false, error: "missing task_id" };

  const attempts = _taskIndex.get(task_id);
  if (!attempts || attempts.size === 0) {
    return { ok: false, error: `no attempts for task ${task_id}` };
  }

  let reserved = 0, committed = 0, released = 0, expired = 0;
  let total_estimated_input = 0, total_actual_input = 0;

  for (const [, attempt] of attempts) {
    switch (attempt.status) {
      case "reserved": reserved++; break;
      case "committed": committed++; break;
      case "released": released++; break;
      case "expired": expired++; break;
    }
    if (attempt.usage.estimated_input != null) total_estimated_input += attempt.usage.estimated_input;
    if (attempt.usage.actual_input != null) total_actual_input += attempt.usage.actual_input;
  }

  return {
    ok: true,
    data: {
      task_id,
      attempts: attempts.size,
      by_status: { reserved, committed, released, expired },
      total_estimated_input,
      total_actual_input,
      attempts_list: [...attempts.values()].map((a) => ({
        attempt_id: a.attempt_id,
        status: a.status,
        usage: a.usage,
        created_at: a.created_at,
        updated_at: a.updated_at,
      })),
    },
  };
}

/**
 * getState — 导出全部状态（供调用方持久化）
 * @returns {{ attempts: Attempt[] }}
 */
function getState() {
  return {
    attempts: [..._attempts.values()],
  };
}

/**
 * loadState — 从持久化状态恢复（供调用方加载）
 * @param {{ attempts: Attempt[] }} state
 */
function loadState(state) {
  if (!state || !Array.isArray(state.attempts)) return;
  for (const a of state.attempts) {
    if (!a.attempt_id) continue;
    _attempts.set(a.attempt_id, a);
    if (a.task_id) {
      if (!_taskIndex.has(a.task_id)) _taskIndex.set(a.task_id, new Map());
      _taskIndex.get(a.task_id).set(a.attempt_id, a);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) { args[key] = true; continue; }
    // 尝试解析为数字
    if (/^\d+$/.test(next)) { args[key] = Number(next); i++; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  let result;

  switch (command) {
    case "reserve": {
      result = reserve({
        attempt_id: args["attempt-id"],
        task_id: args["task-id"],
        estimated_input: args["estimated-input"],
        estimated_output: args["estimated-output"],
        policy_revision: args["policy-revision"],
      });
      break;
    }
    case "commit": {
      result = commit({
        attempt_id: args["attempt-id"],
        receipt_ref: args["receipt-ref"],
        actual_input: args["actual-input"],
        actual_output: args["actual-output"],
      });
      break;
    }
    case "release": {
      result = release({
        attempt_id: args["attempt-id"],
        reason: args["reason"],
      });
      break;
    }
    case "expire": {
      result = expire({
        attempt_id: args["attempt-id"],
        reason: args["reason"],
      });
      break;
    }
    case "query": {
      result = query(args["attempt-id"]);
      break;
    }
    case "status": {
      result = status(args["task-id"]);
      break;
    }
    default: {
      console.log(JSON.stringify({
        ok: false,
        error: "unknown command",
        usage: [
          "node budget-ledger.js reserve --attempt-id <id> --task-id <id> --estimated-input <n>",
          "node budget-ledger.js commit --attempt-id <id> [--actual-input <n>] [--receipt-ref <ref>]",
          "node budget-ledger.js release --attempt-id <id> --reason <string>",
          "node budget-ledger.js expire --attempt-id <id> [--reason <string>]",
          "node budget-ledger.js query --attempt-id <id>",
          "node budget-ledger.js status --task-id <id>",
        ],
      }, null, 2));
      return;
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

module.exports = { reserve, commit, release, expire, query, status, getState, loadState };

if (require.main === module) main();
