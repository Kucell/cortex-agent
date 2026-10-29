"use strict";

// rule-tier.js — 规则/资源稳定性分级器
//
// 提案 P1 的配套能力：为 context 条目计算「稳定性等级」，用于区分
//   - 强制 L0 前缀区块（高度稳定、不随任务变化 → 缓存友好）
//   - 可选 L1 区块（随任务/评分裁剪）
//
// 稳定性信号（按权重求和）：
//   1. 条目 URI 是否落在 pinned/stable 前缀清单（来自 cache-config.yml）
//   2. module_type 是否为「rule / workflow / external resource / core config」
//   3. 是否含中文/双语内容（双语摘要稳定但体积大，归为半稳定）
//   4. estimated_tokens 是否落在「小体积」区间（越小越适合常驻前缀）
//
// 输出 tier: "L0" | "L1"，以及 stability_score（0-100）。

const STABLE_MODULE_TYPES = new Set([
  "rule",
  "workflow",
  "external resource",
  "core config",
  "core-principles",
]);

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// 计算单条目的稳定性分数与分级。
// entry: { uri, module_type?, tokens?, estimated_tokens?, keywords?, l0?, l1?, summary? }
function tierEntry(entry, options) {
  const opts = options || {};
  const pinned = new Set(opts.pinned_prefix || []);
  const stable = new Set(opts.stable_prefix || []);
  const uri = entry.uri || "";

  let score = 0;
  if (pinned.has(uri)) score += 55;          // 强制前缀清单 → 极高稳定
  else if (stable.has(uri)) score += 40;     // 半稳定前缀清单

  const mtype = String(entry.module_type || "").toLowerCase();
  if (STABLE_MODULE_TYPES.has(mtype)) score += 25;

  const text = [entry.l0, entry.l1, entry.summary, (entry.keywords || []).join(" ")].join(" ");
  if (/[一-龥]/.test(text)) score += 8;       // 双语/中文内容：稳定但体积偏大

  const tokens = Number(entry.tokens || entry.estimated_tokens || 0);
  if (tokens > 0 && tokens <= 600) score += 12; // 小体积：适合常驻前缀
  else if (tokens > 600) score -= 6;            // 大体积：放前缀收益下降

  score = clamp(Math.round(score), 0, 100);
  return {
    uri,
    stability_score: score,
    tier: score >= 50 ? "L0" : "L1",
  };
}

// 批量分级并保持输入顺序。
function tierAll(entries, options) {
  return (entries || []).map((e) => tierEntry(e, options));
}

module.exports = {
  STABLE_MODULE_TYPES,
  tierEntry,
  tierAll,
};
