"use strict";

// prefix-builder.js — 前缀缓存区块构造器
//
// 将「稳定前缀」（语言设定 + 强制规则 + 高稳定引用）与「不稳定任务 token 串」
// 显式分隔，输出一个可供 host 端 prompt-caching 复用的 prefix 区块。
//
// 设计目标（见 context-optimization-v2 提案 P1）：
//   - 让 host 端 prompt caching 在多次请求间复用稳定前缀的 KV 缓存；
//   - 前缀仅由高度稳定的条目组成，避免任务相关 token 污染缓存前缀；
//   - 零依赖、纯函数式，便于在 select.js 内联调用或单测。

const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  enabled: true,
  pinned_prefix: [
    "cortex://rules/language",
    "cortex://rules/core-principles",
    "cortex://rules/ai-behavior",
    "cortex://rules/code-standards",
    "cortex://resources/agent-config",
  ],
  stable_prefix: [
    "cortex://references/context-index",
  ],
  cache_version: 1,
  ttl_seconds: 7200,
  min_prefix_entries: 2,
};

function isValidUri(uri) {
  return typeof uri === "string" && /^cortex:\/\/(?:references|rules|workflows|skills|resources)\/.+/.test(uri);
}

function normalizeConfig(overrides) {
  const merged = { ...DEFAULT_CONFIG, ...(overrides || {}) };
  const pinned = Array.isArray(merged.pinned_prefix) ? merged.pinned_prefix.filter(isValidUri) : [];
  const stable = Array.isArray(merged.stable_prefix) ? merged.stable_prefix.filter(isValidUri) : [];
  return {
    enabled: Boolean(merged.enabled),
    pinned_prefix: pinned,
    stable_prefix: stable,
    cache_version: Number.isInteger(merged.cache_version) ? merged.cache_version : DEFAULT_CONFIG.cache_version,
    ttl_seconds: Number.isInteger(merged.ttl_seconds) ? merged.ttl_seconds : DEFAULT_CONFIG.ttl_seconds,
    min_prefix_entries: Number.isInteger(merged.min_prefix_entries) ? merged.min_prefix_entries : DEFAULT_CONFIG.min_prefix_entries,
  };
}

// 把 URI 列表映射成 context 条目数组。
// entries 可选：[{ uri, tokens, tier, reason_codes }]，用于回填 token 估计。
function toEntries(uris, entriesById) {
  const map = entriesById || {};
  return uris.map((uri) => {
    const hit = map[uri];
    const entry = { uri, tier: "L0" };
    if (hit) {
      if (Number.isSafeInteger(hit.tokens)) entry.estimated_tokens = hit.tokens;
      if (Array.isArray(hit.reason_codes) && hit.reason_codes.length) entry.reason_codes = hit.reason_codes;
    }
    return entry;
  });
}

// 根据选中条目集合，计算真正命中的前缀条目（去重、保序）。
function resolvePrefixEntries(config, selectedUris) {
  const selected = new Set(selectedUris);
  const resolved = [];
  const seen = new Set();
  const push = (uri) => {
    if (selected.has(uri) && !seen.has(uri)) {
      seen.add(uri);
      resolved.push(uri);
    }
  };
  // 顺序：pinned 在前（最稳定），stable 在后。
  config.pinned_prefix.forEach(push);
  config.stable_prefix.forEach(push);
  return resolved;
}

// 主构造器。
// 参数：
//   selectedUris: 本次 select 命中的全部 URI（来自 contextItem 输出）
//   options: { config?, entriesById? }
// 返回：
//   {
//     enabled,
//     cache_break: boolean,          // 是否因命中数不足而未生成前缀区块
//     prefix_region: { uris, entries, estimated_tokens } | null,
//     suffix_token_string: string,   // 任务相关、不稳定的 token 串（缓存键之外）
//     cache_version, ttl_seconds,
//   }
function buildPrefix(selectedUris, options) {
  const opts = options || {};
  const config = normalizeConfig(opts.config);
  const uris = Array.isArray(selectedUris) ? selectedUris : [];
  const resolved = resolvePrefixEntries(config, uris);

  if (!config.enabled || resolved.length < config.min_prefix_entries) {
    return {
      enabled: config.enabled,
      cache_break: true,
      prefix_region: null,
      suffix_token_string: uris.join("\n"),
      cache_version: config.cache_version,
      ttl_seconds: config.ttl_seconds,
    };
  }

  const entries = toEntries(resolved, opts.entriesById);
  const estimated_tokens = entries.reduce((sum, e) => sum + (Number(e.estimated_tokens) || 0), 0);

  return {
    enabled: true,
    cache_break: false,
    prefix_region: {
      uris: resolved,
      entries,
      estimated_tokens,
    },
    suffix_token_string: uris.filter((u) => !resolved.includes(u)).join("\n"),
    cache_version: config.cache_version,
    ttl_seconds: config.ttl_seconds,
  };
}

function loadConfig(configPath) {
  if (!configPath) return DEFAULT_CONFIG;
  const abs = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) return DEFAULT_CONFIG;
  const text = fs.readFileSync(abs, "utf8");
  // 轻量 YAML 解析：仅支持本配置文件使用的扁平/列表结构。
  const out = {};
  let listKey = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const listMatch = line.match(/^-\s+(.+)$/);
    if (listMatch && listKey) {
      out[listKey].push(listMatch[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      if (value === "") {
        listKey = key;
        out[key] = [];
      } else if (value === "true") {
        out[key] = true;
        listKey = null;
      } else if (value === "false") {
        out[key] = false;
        listKey = null;
      } else if (/^\d+$/.test(value)) {
        out[key] = Number(value);
        listKey = null;
      } else {
        out[key] = value;
        listKey = null;
      }
    }
  }
  return normalizeConfig(out);
}

module.exports = {
  DEFAULT_CONFIG,
  normalizeConfig,
  isValidUri,
  resolvePrefixEntries,
  buildPrefix,
  loadConfig,
};
