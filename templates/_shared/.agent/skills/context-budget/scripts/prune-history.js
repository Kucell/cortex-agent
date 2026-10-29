"use strict";

/**
 * prune-history.js — 对话历史裁剪策略脚本
 *
 * 功能：
 * - Full 模式: 总 token < 50% budget
 * - Compact 模式: 总 token > 50% budget，保留最近 N 轮 + 关键决策点
 * - Minimal 模式: 总 token > 80% budget，只保留最后1轮 + 任务摘要
 *
 * 使用：
 *   node prune-history.js <history.json> --budget <token_budget> [--mode auto|full|compact|minimal]
 *   或通过 stdin:
 *   cat history.json | node prune-history.js --budget 100000
 *
 * 约束：
 * - 零依赖: node:fs, node:path, node:crypto
 */

const fs = require("node:fs");

// ---------------------------------------------------------------------------
// 配置常量
// ---------------------------------------------------------------------------

const CONFIG = {
  // 模式切换阈值 (相对于 budget 的百分比)
  thresholds: {
    full: 0.5,      // > 50% 时切换到 compact
    compact: 0.8,   // > 80% 时切换到 minimal
  },
  // 各模式保留的轮数
  rounds: {
    compact: 10,    // 保留最近 10 轮
    minimal: 1,     // 只保留最后 1 轮
  },
  // 最小摘要 token 上限
  summaryMaxTokens: 200,
  // 关键消息类型 (始终保留)
  keyMessageTypes: [
    "decision",
    "conclusion",
    "error",
    "critical",
    "checkpoint",
    "milestone",
  ],
};

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

/**
 * 估算文本 token 数 (简化版)
 * @param {string} text - 文本
 * @returns {number} 估算 token 数
 */
function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== "string") {
    text = JSON.stringify(text);
  }
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = text.length - cjk;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

/**
 * 估算消息 token 数
 * @param {object} msg - 消息对象
 * @returns {number} 估算 token 数
 */
function estimateMessageTokens(msg) {
  if (!msg) return 0;

  let tokens = 0;

  // 角色名称
  if (msg.role) {
    tokens += estimateTokens(msg.role) + 2; // +2 for ": "
  }

  // 内容
  if (msg.content) {
    if (typeof msg.content === "string") {
      tokens += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      // 多模态内容
      for (const item of msg.content) {
        if (item.text) {
          tokens += estimateTokens(item.text);
        }
      }
    }
  }

  // 工具调用
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      tokens += estimateTokens(call.function?.name || "");
      tokens += estimateTokens(call.function?.arguments || "");
    }
  }

  // 工具响应
  if (msg.tool_call_id || msg.name) {
    tokens += estimateTokens(msg.content || "");
  }

  return tokens;
}

/**
 * 计算历史总 token 数
 * @param {array} history - 消息历史
 * @returns {number} 总 token 数
 */
function calculateHistoryTokens(history) {
  if (!Array.isArray(history)) return 0;
  return history.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

// ---------------------------------------------------------------------------
// 关键决策检测
// ---------------------------------------------------------------------------

/**
 * 检测是否为关键消息
 * @param {object} msg - 消息对象
 * @returns {boolean}
 */
function isKeyMessage(msg) {
  if (!msg) return false;

  // 检查关键类型标记
  if (msg.type && CONFIG.keyMessageTypes.includes(msg.type)) {
    return true;
  }

  // 检查关键标记字段
  if (msg.key || msg.important || msg.decision || msg.critical) {
    return true;
  }

  // 检查内容中的关键标记词
  const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  if (content) {
    const keyPatterns = [
      /\b(decision|decisions|decided|结论|决策)\b/i,
      /\b(conclusion|summary|总结)\b/i,
      /\b(error|failed|failure|错误|失败)\b/i,
      /\b(critical|important|重要)\b/i,
      /\b(checkpoint|milestone|里程碑)\b/i,
    ];
    if (keyPatterns.some((p) => p.test(content))) {
      return true;
    }
  }

  return false;
}

/**
 * 提取任务摘要
 * @param {array} history - 消息历史
 * @returns {object} 任务摘要
 */
function extractTaskSummary(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return { task: "", completed: [], decisions: [] };
  }

  const task = {
    task: "",
    completed: [],
    decisions: [],
  };

  // 从第一条用户消息提取任务
  for (const msg of history) {
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.length > 10 && content.length < 500) {
        task.task = content.substring(0, 200);
        break;
      }
    }
  }

  // 收集已完成的操作
  for (const msg of history) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        const name = call.function?.name || "";
        if (name) {
          task.completed.push(name);
        }
      }
    }
  }

  // 收集关键决策
  for (const msg of history) {
    if (isKeyMessage(msg)) {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content) {
        task.decisions.push(content.substring(0, 100));
      }
    }
  }

  return task;
}

// ---------------------------------------------------------------------------
// 裁剪策略
// ---------------------------------------------------------------------------

/**
 * Full 模式: 保持原始历史
 * @param {array} history - 消息历史
 * @param {number} budget - token budget
 * @returns {object} 裁剪结果
 */
function pruneFull(history, budget) {
  return {
    ok: true,
    mode: "full",
    history: [...history],
    pruned: 0,
    tokens_used: calculateHistoryTokens(history),
    tokens_budget: budget,
    summary: null,
  };
}

/**
 * Compact 模式: 保留最近 N 轮 + 关键决策点
 * @param {array} history - 消息历史
 * @param {number} budget - token budget
 * @returns {object} 裁剪结果
 */
function pruneCompact(history, budget) {
  if (!Array.isArray(history) || history.length === 0) {
    return pruneFull(history, budget);
  }

  const result = [];
  let pruned = 0;

  // 1. 收集关键消息
  const keyMessages = [];
  const nonKeyMessages = [];

  for (const msg of history) {
    if (isKeyMessage(msg)) {
      keyMessages.push(msg);
    } else {
      nonKeyMessages.push(msg);
    }
  }

  // 2. 保留最近 N 轮非关键消息
  const keepRounds = CONFIG.rounds.compact;
  const recentNonKey = nonKeyMessages.slice(-keepRounds);

  // 3. 构建结果
  result.push(...keyMessages);
  result.push(...recentNonKey);

  // 按原始顺序排序
  result.sort((a, b) => {
    const idxA = history.indexOf(a);
    const idxB = history.indexOf(b);
    return idxA - idxB;
  });

  pruned = history.length - result.length;

  return {
    ok: true,
    mode: "compact",
    history: result,
    pruned,
    tokens_used: calculateHistoryTokens(result),
    tokens_budget: budget,
    summary: extractTaskSummary(history),
    stats: {
      key_messages: keyMessages.length,
      recent_rounds: recentNonKey.length,
    },
  };
}

/**
 * Minimal 模式: 只保留最后1轮 + 任务摘要
 * @param {array} history - 消息历史
 * @param {number} budget - token budget
 * @returns {object} 裁剪结果
 */
function pruneMinimal(history, budget) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      ok: true,
      mode: "minimal",
      history: [],
      pruned: 0,
      tokens_used: 0,
      tokens_budget: budget,
      summary: { task: "", completed: [], decisions: [] },
    };
  }

  // 1. 提取摘要
  const summary = extractTaskSummary(history);

  // 2. 保留最后一条助手消息和相关的用户消息
  const lastMessages = [];

  // 找最后一条用户消息
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      lastMessages.push(history[i]);
      break;
    }
  }

  // 找最后一条助手消息
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastMessages.push(history[i]);
      break;
    }
  }

  // 3. 添加关键决策作为摘要的一部分
  const summaryTokens = estimateTokens(JSON.stringify(summary));
  const summaryText = `任务: ${summary.task}\n已完成: ${summary.completed.slice(-5).join(", ") || "无"}\n关键决策: ${summary.decisions.slice(-3).join(" | ") || "无"}`;

  const pruned = history.length - lastMessages.length;

  return {
    ok: true,
    mode: "minimal",
    history: lastMessages.reverse(), // 按时间顺序
    pruned,
    tokens_used: calculateHistoryTokens(lastMessages) + summaryTokens,
    tokens_budget: budget,
    summary: summaryText,
    full_summary: summary,
  };
}

// ---------------------------------------------------------------------------
// 主裁剪函数
// ---------------------------------------------------------------------------

/**
 * 裁剪对话历史
 * @param {array} history - 消息历史
 * @param {number} budget - token budget
 * @param {string} mode - 模式: "auto", "full", "compact", "minimal"
 * @returns {object} 裁剪结果
 */
function pruneHistory(history, budget, mode = "auto") {
  // 验证输入
  if (!Array.isArray(history)) {
    return { ok: false, error: "history must be an array" };
  }

  if (typeof budget !== "number" || budget <= 0) {
    return { ok: false, error: "budget must be a positive number" };
  }

  // 计算当前 token 使用量
  const tokensUsed = calculateHistoryTokens(history);
  const usageRatio = tokensUsed / budget;

  // 确定模式
  let actualMode = mode;
  if (mode === "auto") {
    if (usageRatio < CONFIG.thresholds.full) {
      actualMode = "full";
    } else if (usageRatio < CONFIG.thresholds.compact) {
      actualMode = "compact";
    } else {
      actualMode = "minimal";
    }
  }

  // 根据模式裁剪
  switch (actualMode) {
    case "full":
      return pruneFull(history, budget);
    case "compact":
      return pruneCompact(history, budget);
    case "minimal":
      return pruneMinimal(history, budget);
    default:
      return { ok: false, error: `invalid mode: ${mode}` };
  }
}

/**
 * 获取裁剪建议 (不执行裁剪)
 * @param {array} history - 消息历史
 * @param {number} budget - token budget
 * @returns {object} 建议
 */
function getPruneAdvice(history, budget) {
  const tokensUsed = calculateHistoryTokens(history);
  const usageRatio = tokensUsed / budget;

  const advice = {
    tokens_used: tokensUsed,
    tokens_budget: budget,
    usage_ratio: Math.round(usageRatio * 100) + "%",
    recommended_mode: "full",
    thresholds: CONFIG.thresholds,
  };

  if (usageRatio >= CONFIG.thresholds.compact) {
    advice.recommended_mode = "minimal";
    advice.reason = `Usage (${advice.usage_ratio}) >= ${CONFIG.thresholds.compact * 100}%, requires minimal mode`;
  } else if (usageRatio >= CONFIG.thresholds.full) {
    advice.recommended_mode = "compact";
    advice.reason = `Usage (${advice.usage_ratio}) >= ${CONFIG.thresholds.full * 100}%, compact mode recommended`;
  } else {
    advice.reason = `Usage (${advice.usage_ratio}) < ${CONFIG.thresholds.full * 100}%, full mode acceptable`;
  }

  return advice;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  let budget = null;
  let mode = "auto";
  let inputPath = null;
  let outputPath = null;

  // 解析参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--budget" && i + 1 < args.length) {
      budget = parseInt(args[++i], 10);
    } else if (arg === "--mode" && i + 1 < args.length) {
      mode = args[++i];
    } else if (arg === "--output" && i + 1 < args.length) {
      outputPath = args[++i];
    } else if (arg === "--help") {
      console.log(`
Usage: node prune-history.js [input.json] [options]

Options:
  --budget <n>        Token budget (required)
  --mode <mode>       Prune mode: auto, full, compact, minimal (default: auto)
  --output <file>     Write output to file instead of stdout

Examples:
  cat history.json | node prune-history.js --budget 100000
  node prune-history.js history.json --budget 100000 --mode compact
      `);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      inputPath = arg;
    }
  }

  if (budget === null) {
    console.error("Error: --budget is required");
    process.exit(1);
  }

  // 读取输入
  let history;
  if (inputPath) {
    try {
      const content = fs.readFileSync(inputPath, "utf8");
      history = JSON.parse(content);
    } catch (e) {
      console.error(`Error reading file ${inputPath}:`, e.message);
      process.exit(1);
    }
  } else {
    // 从 stdin 读取
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        history = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        execute(history);
      } catch (e) {
        console.error("Error parsing stdin:", e.message);
        process.exit(1);
      }
    });
    return;
  }

  execute(history);

  function execute(h) {
    const result = pruneHistory(h, budget, mode);

    if (outputPath) {
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
      console.error(`Saved to ${outputPath}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
}

// 导出模块
module.exports = {
  pruneHistory,
  getPruneAdvice,
  calculateHistoryTokens,
  estimateTokens,
  isKeyMessage,
  extractTaskSummary,
  CONFIG,
};

// CLI 入口
if (require.main === module) {
  main();
}
