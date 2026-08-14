#!/usr/bin/env node
/**
 * context-expand.js — P-002 Minimal Context: 增量展开
 *
 * 提供 minimal | standard | deep 三级增量展开。
 * 输入 trajectory_id 或 item 列表，输出 expanded 上下文。
 *
 * 设计约束（P-002 §2.2 & API）：
 * - 响应分为 minimal | standard | deep，所有列表有显式上限
 * - minimal: 约 100~300 Token 的路由摘要
 * - standard: L0 + 关键 L1
 * - deep: L0 + L1 + L2，按 token_budget 截断
 *
 * 用法：
 *   node context-expand.js --trajectory-id <id> --level minimal|standard|deep
 *   node context-expand.js --items '[{"uri":"..."}]' --level standard
 *   node context-expand.js --items '[{"uri":"..."}]' --level deep --token-budget 5000
 *
 * 输出包含 revision、estimated_tokens、truncated、reason_codes、fallback_used。
 */

"use strict";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const LEVELS = {
  MINIMAL: "minimal",
  STANDARD: "standard",
  DEEP: "deep",
};

const DEFAULT_TOKEN_BUDGETS = {
  [LEVELS.MINIMAL]: 300,
  [LEVELS.STANDARD]: 2000,
  [LEVELS.DEEP]: 10000,
};

const MAX_LIST_SIZE = 50; // 所有列表有显式上限

// ---------------------------------------------------------------------------
// 层级定义
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ExpandLevel
 * @property {number} maxTokens
 * @property {boolean} includeL0
 * @property {boolean} includeL1
 * @property {boolean} includeL2
 * @property {number} maxItems
 */

/** @type {Record<string, ExpandLevel>} */
const LEVEL_CONFIG = {
  [LEVELS.MINIMAL]: {
    maxTokens: 300,
    includeL0: true,
    includeL1: false,
    includeL2: false,
    maxItems: 10,
  },
  [LEVELS.STANDARD]: {
    maxTokens: 2000,
    includeL0: true,
    includeL1: true,
    includeL2: false,
    maxItems: 25,
  },
  [LEVELS.DEEP]: {
    maxTokens: 10000,
    includeL0: true,
    includeL1: true,
    includeL2: true,
    maxItems: MAX_LIST_SIZE,
  },
};

// ---------------------------------------------------------------------------
// Token 估算（与 select.js 一致）
// ---------------------------------------------------------------------------

/** @param {string} text @returns {number} */
function tokenize(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

/**
 * @typedef {Object} ExpandItem
 * @property {string} uri
 * @property {string} [module]
 * @property {string} [module_path]
 * @property {string} [summary]
 * @property {string} [l0]
 * @property {string} [l1]
 * @property {string} [l2]
 * @property {number} [l0_tokens]
 * @property {number} [l1_tokens]
 * @property {number} [l2_tokens]
 * @property {string} [tier]
 * @property {string[]} [reason_codes]
 */

// ---------------------------------------------------------------------------
// 展开引擎
// ---------------------------------------------------------------------------

/**
 * 加载 items 的详细内容（模拟从 context-index 加载）
 * 实际实现中会读取 .agent/context-index.json
 *
 * @param {ExpandItem[]} items
 * @param {ExpandLevel} config
 * @returns {{ expanded: object[], truncated: boolean, estimated_tokens: number }}
 */
function expandItems(items, config) {
  const expanded = [];
  let remaining = config.maxTokens;
  let truncated = false;

  // 按 tier 优先级排序
  const sorted = [...items].sort((a, b) => {
    const tierOrder = { L0: 0, L1: 1, L2: 2, unknown: 3 };
    const ta = tierOrder[a.tier || "unknown"] ?? 3;
    const tb = tierOrder[b.tier || "unknown"] ?? 3;
    return ta - tb;
  });

  for (const item of sorted) {
    if (expanded.length >= config.maxItems) {
      truncated = true;
      break;
    }

    // 确定要包含的层级
    const tier = item.tier || "L0";
    let content = "";
    let tokens = 0;

    if (config.includeL0 && (tier === "L0" || tier === "L1" || tier === "L2")) {
      content += item.l0 || item.summary || "";
      tokens += item.l0_tokens || tokenize(item.l0) || 80;
    }

    if (config.includeL1 && (tier === "L1" || tier === "L2")) {
      const l1Content = item.l1 || "";
      if (l1Content) {
        content += (content ? "\n\n" : "") + l1Content;
        tokens += item.l1_tokens || tokenize(l1Content);
      }
    }

    if (config.includeL2 && tier === "L2") {
      const l2Content = item.l2 || "";
      if (l2Content) {
        content += (content ? "\n\n" : "") + l2Content;
        tokens += item.l2_tokens || tokenize(l2Content);
      }
    }

    if (!content) {
      // 无详细内容时，使用摘要
      content = item.summary || `[${item.uri}]`;
      tokens = item.l0_tokens || item.l1_tokens || 80;
    }

    // 检查 budget
    if (tokens > remaining && !item.protected) {
      // 剩余 items 标记为 truncated
      truncated = true;
      continue;
    }

    expanded.push({
      uri: item.uri,
      module: item.module || item.module_path || item.uri.split("/").pop(),
      tier,
      summary: content.slice(0, 500), // 截断到合理长度
      estimated_tokens: tokens,
      reason_codes: item.reason_codes || [],
      protected: item.protected || false,
    });

    if (!item.protected) {
      remaining -= tokens;
    }
  }

  return {
    expanded,
    truncated,
    estimated_tokens: expanded.reduce((sum, e) => sum + e.estimated_tokens, 0),
  };
}

/**
 * 生成 minimal 摘要（路由摘要）
 *
 * @param {ExpandItem[]} items
 * @returns {{ summary: string, estimated_tokens: number }}
 */
function generateMinimalSummary(items) {
  if (!items || items.length === 0) {
    return { summary: "(no items)", estimated_tokens: 5 };
  }

  const lines = [
    `# Context Summary (${items.length} items)`,
    "",
  ];

  // 按 tier 分组
  const byTier = { L0: [], L1: [], L2: [], unknown: [] };
  for (const item of items) {
    const tier = item.tier || "unknown";
    if (!byTier[tier]) byTier[tier] = [];
    byTier[tier].push(item);
  }

  // minimal 只展示顶层摘要
  if (byTier.L0.length) {
    lines.push(`## High Priority (${byTier.L0.length})`);
    for (const item of byTier.L0.slice(0, 5)) {
      const label = item.module || item.uri.split("/").pop() || item.uri;
      lines.push(`- ${label}${item.reason_codes?.length ? ` [${item.reason_codes.join(",")}]` : ""}`);
    }
  }

  if (byTier.L1.length) {
    lines.push(`## Medium Priority (${byTier.L1.length})`);
    for (const item of byTier.L1.slice(0, 5)) {
      const label = item.module || item.uri.split("/").pop() || item.uri;
      lines.push(`- ${label}`);
    }
  }

  if (items.length > 10) {
    lines.push(`... and ${items.length - 10} more items`);
  }

  const summary = lines.join("\n");
  return {
    summary,
    estimated_tokens: tokenize(summary),
  };
}

/**
 * 主展开函数
 *
 * @param {object} opts
 * @param {string} opts.trajectoryId
 * @param {string} [opts.level='minimal']
 * @param {number} [opts.tokenBudget]
 * @param {ExpandItem[]} [opts.items]
 * @param {object[]} [opts.rawItems]  原始 items（未处理）
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function expand(opts) {
  const {
    trajectoryId,
    level = LEVELS.MINIMAL,
    tokenBudget,
    items = [],
    rawItems = [],
  } = opts;

  const level_ = level.toLowerCase();
  if (!LEVEL_CONFIG[level_]) {
    return {
      ok: false,
      error: `invalid level: ${level}, must be minimal|standard|deep`,
    };
  }

  const config = { ...LEVEL_CONFIG[level_] };
  if (typeof tokenBudget === "number" && tokenBudget > 0) {
    config.maxTokens = tokenBudget;
  }

  // 合并 items
  const allItems = [...items, ...rawItems].filter(Boolean);

  if (allItems.length === 0) {
    return {
      ok: false,
      error: "no items to expand (provide items or rawItems)",
    };
  }

  let result;

  if (level_ === LEVELS.MINIMAL) {
    // minimal: 只生成摘要路由
    const summaryResult = generateMinimalSummary(allItems);
    result = {
      level: LEVELS.MINIMAL,
      max_tokens: config.maxTokens,
      summary: summaryResult.summary,
      estimated_tokens: summaryResult.estimated_tokens,
      truncated: false,
      items_count: allItems.length,
      items_preview: allItems.slice(0, 10).map((i) => ({
        uri: i.uri,
        module: i.module || i.module_path || "",
        tier: i.tier || "L0",
      })),
    };
  } else {
    // standard / deep: 展开详细内容
    const expandResult = expandItems(allItems, config);
    result = {
      level: level_,
      max_tokens: config.maxTokens,
      items: expandResult.expanded,
      estimated_tokens: expandResult.estimated_tokens,
      truncated: expandResult.truncated,
      items_count: allItems.length,
      items_included: expandResult.expanded.length,
    };
  }

  return {
    ok: true,
    data: {
      schema_version: "1.0",
      trajectory_id: trajectoryId || null,
      level: result.level,
      max_tokens: result.max_tokens,
      estimated_tokens: result.estimated_tokens,
      truncated: result.truncated,
      reason_codes: ["context-expand", level_],
      revision: `sha256:${level_}:${Date.now()}`,
      fallback_used: false,
      // 根据层级包含不同字段
      ...(level_ === LEVELS.MINIMAL
        ? {
            summary: result.summary,
            items_preview: result.items_preview,
            items_count: result.items_count,
          }
        : {
            items: result.items,
            items_count: result.items_count,
            items_included: result.items_included,
          }),
    },
  };
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
    if (!next || next.startsWith("--")) { args[key] = true; i++; continue; }
    if (/^\d+$/.test(next)) { args[key] = Number(next); i++; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node context-expand.js --trajectory-id <id> --level minimal|standard|deep
  node context-expand.js --items '[{"uri":"..."}]' --level standard
  node context-expand.js --items '[{"uri":"..."}]' --level deep --token-budget 5000

Levels:
  minimal  - 约 100~300 Token 的路由摘要
  standard - L0 + 关键 L1，最大 2000 tokens
  deep     - L0 + L1 + L2，按 token-budget 截断

Output fields:
  revision, estimated_tokens, truncated, reason_codes, fallback_used
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.level) {
    usage();
    return;
  }

  let items = [];
  if (args.items) {
    try {
      items = JSON.parse(args.items);
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `invalid JSON in --items: ${e.message}` }, null, 2));
      return;
    }
  }

  const result = expand({
    trajectoryId: args["trajectory-id"],
    level: args.level,
    tokenBudget: args["token-budget"],
    items,
  });

  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  expand,
  expandItems,
  generateMinimalSummary,
  tokenize,
  LEVELS,
  LEVEL_CONFIG,
};

if (require.main === module) main();
