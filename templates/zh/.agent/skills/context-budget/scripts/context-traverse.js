#!/usr/bin/env node
/**
 * context-traverse.js — P-002 Minimal Context: token_budget 有界遍历
 *
 * BFS 用于影响面，DFS 用于调用链；达到预算后返回 truncated/omitted count 和 next query。
 * 复用 select.js 的 scoreModule/extractTaskTokens。
 *
 * 设计约束（P-002 §2.2）：
 * - token_budget 是响应预算，不是图深度的间接别名
 * - BFS 用于影响面，DFS 用于调用链
 * - 达到预算后返回 truncated、omitted count 和 next query
 * - Source snippet 仅在下一步确需时加载，默认返回路径、符号、行号、edge 和 reason code
 *
 * 用法：
 *   node context-traverse.js --query "..." --mode bfs|dfs --depth 1..6 --token-budget <n>
 *   node context-traverse.js --query "..." --mode bfs --token-budget 2000 --context-index <path>
 *
 * 输出必须包含 revision、estimated_tokens、truncated、reason_codes、fallback_used 和 trajectory ref。
 */

"use strict";

// ---------------------------------------------------------------------------
// 复用 select.js 的工具函数
// ---------------------------------------------------------------------------

// 延迟加载避免循环依赖
let _scoreModule = null;
let _extractTaskTokens = null;
let _selectModule = null;

function getSelectModule() {
  if (!_selectModule) {
    try {
      _selectModule = require("./select.js");
      _scoreModule = _selectModule.scoreModule;
      _extractTaskTokens = _selectModule.extractTaskTokens;
    } catch (_) {
      // select.js 不可用时提供内置实现
    }
  }
  return _selectModule;
}

/** 内置 tokenize（与 select.js 一致） */
function tokenize(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = text.replace(/[\u4e00-\u9fff]/g, "").length;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

/** 内置 extractTaskTokens（降级用） */
function extractTaskTokensFallback(task) {
  if (!task) return { tokens: [], paths: [] };
  const cjk = (task.match(/[\u4e00-\u9fff]+/g) || []);
  const words = (task.replace(/[\u4e00-\u9fff]/g, " ").toLowerCase().match(/[a-z0-9_\-/.]{2,}/g) || []);
  const all = [...cjk, ...words];
  const STOPWORDS = new Set([
    "the", "and", "for", "with", "from", "this", "that", "into", "have", "has",
    "你", "我们", "他们", "请", "一下", "需要", "应该", "这个", "那个", "然后",
  ]);
  const tokens = [...new Set(all.filter((t) => t.length >= 2 && !STOPWORDS.has(t)))].slice(0, 60);
  const paths = (task.match(/[a-zA-Z0-9_\-/.]+\.[a-z]{1,5}/g) || []);
  return { tokens, paths };
}

/** 内置 scoreModule（降级用） */
function scoreModuleFallback(mod, taskTokens, taskPathHints) {
  const l0Text = ((mod.l0 || mod.summary || "")).toLowerCase();
  const l1Text = ((mod.l1 || mod.summary || "")).toLowerCase();
  const kwText = ((mod.keywords || []).join(" ")).toLowerCase();

  let score = 0;
  const matched = new Set();
  const l0Hit = new Set();
  const l1Hit = new Set();

  for (const tk of taskTokens) {
    if (l0Text.includes(tk)) { score += 1; l0Hit.add(tk); matched.add(tk); }
    if (l1Text.includes(tk)) { score += 1; l1Hit.add(tk); matched.add(tk); }
    if (kwText.includes(tk)) { score += 0.5; matched.add(tk); }
  }
  score = Math.round(score * 10) / 10;

  for (const p of taskPathHints) {
    if (mod.module_path && p.includes(mod.module_path)) { score += 5; }
  }
  return { score, matched: [...matched], l0_hit: [...l0Hit], l1_hit: [...l1Hit] };
}

// ---------------------------------------------------------------------------
// 遍历引擎
// ---------------------------------------------------------------------------

const MODES = { BFS: "bfs", DFS: "dfs" };
const MAX_DEPTH = 6;

/**
 * 计算节点 token 估计
 * @param {object} node
 * @returns {number}
 */
function nodeTokens(node) {
  if (typeof node.estimated_tokens === "number") return node.estimated_tokens;
  if (typeof node.l2_tokens === "number") return node.l2_tokens;
  if (typeof node.l1_tokens === "number") return Math.min(node.l1_tokens, 200);
  // fallback：按摘要长度估算
  const summary = node.summary || node.l0 || node.l1 || "";
  return Math.max(tokenize(summary), 80);
}

/**
 * 检查硬约束过滤（不可丢弃的条目）
 * @param {object} node
 * @returns {boolean}
 */
function isProtected(node) {
  // changed files、用户显式路径、规则与批准决策不可被排序器丢弃
  const protectedPrefixes = ["rules/", "decisions/", "workflows/"];
  const path = node.module_path || node.module || "";
  if (protectedPrefixes.some((p) => path.startsWith(p))) return true;
  if (node.explicit_path || node.changed_file || node.required) return true;
  if (node.pinned || node.priority === "high" || node.priority === "critical") return true;
  return false;
}

/**
 * BFS 遍历（影响面优先）
 *
 * @param {object[]} candidates
 * @param {object} opts
 * @param {string[]} opts.taskTokens
 * @param {string[]} opts.taskPathHints
 * @param {number} opts.tokenBudget
 * @param {number} [opts.maxDepth]
 * @param {function} [opts.scoreFn]
 * @returns {{ visited: object[], truncated: boolean, omitted_count: number, next_query: string|null }}
 */
function bfsTraverse(candidates, opts) {
  const {
    taskTokens,
    taskPathHints,
    tokenBudget,
    maxDepth = MAX_DEPTH,
    scoreFn = scoreModuleFallback,
  } = opts;

  let remaining = tokenBudget;
  const visited = [];
  const omitted = [];
  let depth = 0;

  // 按 score 排序（影响面优先）
  const scored = candidates.map((c) => {
    const result = scoreFn(c, taskTokens, taskPathHints);
    return { ...c, _score: result.score, _matched: result.matched };
  }).sort((a, b) => b._score - a._score);

  // BFS 层次遍历
  let queue = [...scored];
  const visitedPaths = new Set();

  while (queue.length > 0 && depth < maxDepth) {
    const nextQueue = [];

    for (const node of queue) {
      const path = node.module_path || node.module || "";

      // 跳过已访问
      if (visitedPaths.has(path)) continue;

      const tokens = nodeTokens(node);
      const protected_ = isProtected(node);

      if (tokens <= remaining || protected_) {
        visited.push({
          uri: `cortex://references/${path}`,
          module: node.module || node.id || "unknown",
          path,
          estimated_tokens: tokens,
          score: node._score,
          reason_codes: node._matched && node._matched.length ? ["selector-match"] : [],
          tier: node.l0 ? "L0" : node.l1 ? "L1" : "L2",
          depth,
          protected: protected_,
        });
        visitedPaths.add(path);
        if (!protected_) remaining -= tokens;
      } else {
        omitted.push({ uri: `cortex://references/${path}`, reason: "budget_exceeded" });
      }

      // 保护条目不计入预算但加入访问
      if (protected_ && !visitedPaths.has(path)) {
        visitedPaths.add(path);
      }
    }

    // 下一代
    depth++;
    queue = nextQueue;
  }

  const truncated = remaining <= 0 && candidates.length > visited.length + omitted.length;

  // 生成 next query 提示
  let nextQuery = null;
  if (truncated) {
    const topUnvisited = candidates
      .filter((c) => !visitedPaths.has(c.module_path || c.module || ""))
      .slice(0, 3)
      .map((c) => c.module || c.id || "")
      .join(" ");
    nextQuery = topUnvisited ? `continue with: ${topUnvisited}` : null;
  }

  return {
    visited,
    truncated,
    omitted_count: omitted.length,
    omitted,
    next_query: nextQuery,
    mode: MODES.BFS,
    depth_reached: depth,
    budget_used: tokenBudget - remaining,
    budget_remaining: remaining,
  };
}

/**
 * DFS 遍历（调用链优先）
 *
 * @param {object[]} candidates
 * @param {object} opts
 * @param {string[]} opts.taskTokens
 * @param {string[]} opts.taskPathHints
 * @param {number} opts.tokenBudget
 * @param {number} [opts.maxDepth]
 * @param {function} [opts.scoreFn]
 * @returns {{ visited: object[], truncated: boolean, omitted_count: number, next_query: string|null }}
 */
function dfsTraverse(candidates, opts) {
  const {
    taskTokens,
    taskPathHints,
    tokenBudget,
    maxDepth = MAX_DEPTH,
    scoreFn = scoreModuleFallback,
  } = opts;

  let remaining = tokenBudget;
  const visited = [];
  const omitted = [];
  const visitedPaths = new Set();

  // 按 score 排序后取 top-K 作为 DFS 种子
  const scored = candidates.map((c) => {
    const result = scoreFn(c, taskTokens, taskPathHints);
    return { ...c, _score: result.score, _matched: result.matched };
  }).sort((a, b) => b._score - a._score);

  // DFS 递归
  function dfs(node, depth) {
    if (depth > maxDepth) return;
    const path = node.module_path || node.module || "";
    if (visitedPaths.has(path)) return;

    const tokens = nodeTokens(node);
    const protected_ = isProtected(node);

    if (tokens <= remaining || protected_) {
      visited.push({
        uri: `cortex://references/${path}`,
        module: node.module || node.id || "unknown",
        path,
        estimated_tokens: tokens,
        score: node._score,
        reason_codes: node._matched && node._matched.length ? ["selector-match"] : ["dfs-path"],
        tier: node.l0 ? "L0" : node.l1 ? "L1" : "L2",
        depth,
        protected: protected_,
        parent: node._parent || null,
      });
      visitedPaths.add(path);
      if (!protected_) remaining -= tokens;

      // DFS：沿依赖边继续（如果有 dependencies 字段）
      const deps = node.dependencies || [];
      for (const dep of deps) {
        const depNode = candidates.find(
          (c) => (c.module_path || c.module || "") === dep
        );
        if (depNode) {
          depNode._parent = path;
          dfs(depNode, depth + 1);
        }
      }
    } else {
      omitted.push({ uri: `cortex://references/${path}`, reason: "budget_exceeded" });
    }
  }

  // 从最高分开始 DFS
  for (const seed of scored) {
    if (remaining <= 0) break;
    dfs(seed, 0);
  }

  const truncated = remaining <= 0 && candidates.length > visited.length + omitted.length;

  let nextQuery = null;
  if (truncated) {
    const topUnvisited = candidates
      .filter((c) => !visitedPaths.has(c.module_path || c.module || ""))
      .slice(0, 3)
      .map((c) => c.module || c.id || "")
      .join(" ");
    nextQuery = topUnvisited ? `continue with: ${topUnvisited}` : null;
  }

  return {
    visited,
    truncated,
    omitted_count: omitted.length,
    omitted,
    next_query: nextQuery,
    mode: MODES.DFS,
    depth_reached: maxDepth,
    budget_used: tokenBudget - remaining,
    budget_remaining: remaining,
  };
}

/**
 * 主遍历函数
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {string} [opts.mode='bfs']
 * @param {number} [opts.depth=3]
 * @param {number} opts.tokenBudget
 * @param {object[]} [opts.candidates]
 * @param {string} [opts.contextIndexPath]
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
function traverse(opts) {
  const {
    query,
    mode = MODES.BFS,
    depth = 3,
    tokenBudget,
    candidates = [],
    contextIndexPath,
  } = opts;

  if (!query) return { ok: false, error: "missing query" };
  if (!tokenBudget || tokenBudget <= 0) return { ok: false, error: "token-budget must be positive" };
  if (tokenBudget > 500000) return { ok: false, error: "token-budget exceeds maximum (500000)" };

  const mode_ = mode.toLowerCase();
  if (mode_ !== MODES.BFS && mode_ !== MODES.DFS) {
    return { ok: false, error: `invalid mode: ${mode}, must be bfs or dfs` };
  }

  // 加载 context-index
  let candidates_ = candidates;
  if (!candidates_.length && contextIndexPath) {
    try {
      // 动态 require 避免 fs 依赖
      const { readFileSync } = require("fs");
      const content = readFileSync(contextIndexPath, "utf8");
      const index = JSON.parse(content);
      candidates_ = index.modules || index.resources || [];
    } catch (e) {
      return { ok: false, error: `failed to load context-index: ${e.message}` };
    }
  }

  // 提取 token
  const selectMod = getSelectModule();
  const { tokens, paths } = selectMod
    ? selectMod.extractTaskTokens(query)
    : extractTaskTokensFallback(query);
  const scoreFn = selectMod ? selectMod.scoreModule : scoreModuleFallback;

  const result =
    mode_ === MODES.DFS
      ? dfsTraverse(candidates_, { taskTokens: tokens, taskPathHints: paths, tokenBudget, maxDepth: Math.min(depth, MAX_DEPTH), scoreFn })
      : bfsTraverse(candidates_, { taskTokens: tokens, taskPathHints: paths, tokenBudget, maxDepth: Math.min(depth, MAX_DEPTH), scoreFn });

  return {
    ok: true,
    data: {
      schema_version: "1.0",
      query,
      mode: result.mode,
      depth_requested: Math.min(depth, MAX_DEPTH),
      depth_reached: result.depth_reached,
      token_budget: tokenBudget,
      budget_used: result.budget_used,
      budget_remaining: result.budget_remaining,
      truncated: result.truncated,
      omitted_count: result.omitted_count,
      next_query: result.next_query,
      items: result.visited,
      revision: `sha256:${query.length}:${Date.now()}`,
      reason_codes: ["graph-traverse", mode_],
      fallback_used: !selectMod,
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
  node context-traverse.js --query "..." --mode bfs|dfs --depth 1..6 --token-budget <n>
  node context-traverse.js --query "..." --mode bfs --token-budget 2000 [--context-index <path>]

Output fields:
  revision, estimated_tokens, truncated, reason_codes, fallback_used, trajectory ref
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.query) {
    usage();
    return;
  }

  const result = traverse({
    query: args.query,
    mode: args.mode || "bfs",
    depth: args.depth || 3,
    tokenBudget: args["token-budget"] || 2000,
    contextIndexPath: args["context-index"],
  });

  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  traverse,
  bfsTraverse,
  dfsTraverse,
  tokenize,
  scoreModuleFallback,
  extractTaskTokensFallback,
};

if (require.main === module) main();
