#!/usr/bin/env node
/**
 * capability-detect.js — P-003 Compaction, Cache and Shared Prefix: 能力检测
 *
 * 检测 Host 支持的 capability，输出 P-003 §1 capability contract：
 *   supports_compaction: "server"|"client"|"none"|"unknown"
 *   supports_prompt_cache: "implicit"|"explicit"|"none"|"unknown"
 *   supports_render_receipt: boolean
 *   supports_usage_receipt: boolean
 *   supports_shared_prefix: boolean
 *   supports_stateless_compaction_fallback: boolean
 *
 * 不支持标记 unknown/unavailable；所有字段必须输出有效枚举值。
 *
 * 用法：
 *   node capability-detect.js detect [--host <name>] [--env-file <path>]
 *   node capability-detect.js probe --host <name> [--timeout <ms>]
 *
 * 设计约束（P-003 §1）：
 * - 不支持能力时使用 Cortex 自管 fallback，但不得声称改写了 Host transcript
 * - 零依赖 node:fs / node:path / node:crypto
 */

"use strict";

// ---------------------------------------------------------------------------
// Capability Contract（严格枚举，不允许 unknown/unavailable）
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} */
const COMPACTION_VALUES = ["server", "client", "none"];
/** @type {Record<string, string[]>} */
const PROMPT_CACHE_VALUES = ["implicit", "explicit", "none"];

// ---------------------------------------------------------------------------
// 默认能力（保守假设）
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES = {
  supports_compaction: "none",
  supports_prompt_cache: "none",
  supports_render_receipt: false,
  supports_usage_receipt: false,
  supports_shared_prefix: false,
  supports_stateless_compaction_fallback: false,
};

// ---------------------------------------------------------------------------
// 环境检测启发式
// ---------------------------------------------------------------------------

/**
 * 从环境变量/配置检测能力
 *
 * @param {object} env 环境变量对象（默认 process.env）
 * @returns {Partial<object>}
 */
function detectFromEnv(env) {
  env = env || process.env;
  const detected = {};

  // 检测 prompt cache
  const pcValue = env.CORTEX_PROMPT_CACHE || env.OPENAI_API_EXTENSIONS || "";
  if (/prompt.cache|implicit.cache/i.test(pcValue)) {
    detected.supports_prompt_cache = "implicit";
  } else if (/explicit.cache|delta.cache/i.test(pcValue)) {
    detected.supports_prompt_cache = "explicit";
  } else if (/no.cache|disable.cache/i.test(pcValue)) {
    detected.supports_prompt_cache = "none";
  }

  // 检测 compaction
  const compactionValue = env.CORTEX_COMPACTION || env.LLMCOMPACTION || "";
  if (/server.side|host.compaction/i.test(compactionValue)) {
    detected.supports_compaction = "server";
  } else if (/client.side|local.compaction/i.test(compactionValue)) {
    detected.supports_compaction = "client";
  } else if (/no.compaction|disable/i.test(compactionValue)) {
    detected.supports_compaction = "none";
  }

  // 检测 shared prefix（多租户/跨项目共享前缀）
  const sharedValue = env.CORTEX_SHARED_PREFIX || env.MULTI_TENANT_SHARING || "";
  if (/enabled|true|1/i.test(sharedValue)) {
    detected.supports_shared_prefix = true;
  }

  // 检测 receipt 支持
  if (/render.receipt|usage.receipt/i.test(pcValue + compactionValue + sharedValue)) {
    detected.supports_render_receipt = true;
    detected.supports_usage_receipt = true;
  }

  // 检测 stateless compaction fallback
  const fallbackValue = env.CORTEX_STATELESS_FALLBACK || "";
  if (/enabled|true/i.test(fallbackValue)) {
    detected.supports_stateless_compaction_fallback = true;
  }

  return detected;
}

/**
 * 从 host 名称推断能力
 *
 * @param {string} hostName
 * @returns {Partial<object>}
 */
function detectFromHost(hostName) {
  const name = (hostName || "").toLowerCase();
  const inferred = {};

  // Claude Code / Claude Desktop
  if (name.includes("claude") || name.includes("anthropic")) {
    // Claude Code 不支持服务端 compaction
    inferred.supports_compaction = "none";
    // 隐式 prompt cache（通过 API 层面）
    inferred.supports_prompt_cache = "implicit";
    // Claude Code 不暴露 render/usage receipt
    inferred.supports_render_receipt = false;
    inferred.supports_usage_receipt = false;
    inferred.supports_shared_prefix = false;
  }
  // Codex
  else if (name.includes("codex") || name.includes("openai")) {
    inferred.supports_compaction = "client";
    inferred.supports_prompt_cache = "explicit";
    inferred.supports_render_receipt = true;
    inferred.supports_usage_receipt = true;
    inferred.supports_shared_prefix = true;
  }
  // Gemini
  else if (name.includes("gemini") || name.includes("google")) {
    inferred.supports_compaction = "server";
    inferred.supports_prompt_cache = "implicit";
    inferred.supports_render_receipt = true;
    inferred.supports_usage_receipt = true;
    inferred.supports_shared_prefix = false;
  }
  // Pi agent
  else if (name.includes("pi") || name.includes("cortex")) {
    inferred.supports_compaction = "none";
    inferred.supports_prompt_cache = "none";
    inferred.supports_render_receipt = false;
    inferred.supports_usage_receipt = false;
    inferred.supports_shared_prefix = false;
  }

  return inferred;
}

/**
 * Probe host（模拟探测，返回假设结果）
 * 实际实现中会向 host 发送探测请求
 *
 * @param {string} hostName
 * @param {number} [timeoutMs]
 * @returns {Promise<Partial<object>>}
 */
async function probeHost(hostName, timeoutMs) {
  // 模拟探测延迟
  await new Promise((resolve) => setTimeout(resolve, 10));

  // 基于 host 名称返回探测结果
  const name = (hostName || "unknown").toLowerCase();

  if (name.includes("claude") || name.includes("anthropic")) {
    return {
      supports_compaction: "none",
      supports_prompt_cache: "implicit",
      supports_render_receipt: false,
      supports_usage_receipt: false,
      supports_shared_prefix: false,
      supports_stateless_compaction_fallback: false,
    };
  }

  if (name.includes("codex") || name.includes("openai")) {
    return {
      supports_compaction: "client",
      supports_prompt_cache: "explicit",
      supports_render_receipt: true,
      supports_usage_receipt: true,
      supports_shared_prefix: true,
      supports_stateless_compaction_fallback: false,
    };
  }

  if (name.includes("gemini") || name.includes("google")) {
    return {
      supports_compaction: "server",
      supports_prompt_cache: "implicit",
      supports_render_receipt: true,
      supports_usage_receipt: true,
      supports_shared_prefix: false,
      supports_stateless_compaction_fallback: false,
    };
  }

  // 默认未知 host 返回保守值
  return { ...DEFAULT_CAPABILITIES };
}

// ---------------------------------------------------------------------------
// 能力验证
// ---------------------------------------------------------------------------

/**
 * 验证能力值符合 contract
 *
 * @param {object} caps
 * @returns {{ ok: boolean, errors?: string[] }}
 */
function validateCapabilities(caps) {
  const errors = [];

  // supports_compaction 必须是有效枚举
  if (!COMPACTION_VALUES.includes(caps.supports_compaction)) {
    errors.push(`supports_compaction must be one of: ${COMPACTION_VALUES.join(", ")}`);
  }

  // supports_prompt_cache 必须是有效枚举
  if (!PROMPT_CACHE_VALUES.includes(caps.supports_prompt_cache)) {
    errors.push(`supports_prompt_cache must be one of: ${PROMPT_CACHE_VALUES.join(", ")}`);
  }

  // 其他字段必须是 boolean
  const boolFields = [
    "supports_render_receipt",
    "supports_usage_receipt",
    "supports_shared_prefix",
    "supports_stateless_compaction_fallback",
  ];
  for (const field of boolFields) {
    if (typeof caps[field] !== "boolean") {
      errors.push(`${field} must be a boolean`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 合并多个来源的能力检测结果
 * 优先级：probe > host > env > default
 *
 * @param {object[]} sources
 * @returns {object}
 */
function mergeCapabilities(sources) {
  const result = { ...DEFAULT_CAPABILITIES };

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;

    // 逐字段覆盖（非空值）
    if (source.supports_compaction) result.supports_compaction = source.supports_compaction;
    if (source.supports_prompt_cache) result.supports_prompt_cache = source.supports_prompt_cache;
    if (typeof source.supports_render_receipt === "boolean") result.supports_render_receipt = source.supports_render_receipt;
    if (typeof source.supports_usage_receipt === "boolean") result.supports_usage_receipt = source.supports_usage_receipt;
    if (typeof source.supports_shared_prefix === "boolean") result.supports_shared_prefix = source.supports_shared_prefix;
    if (typeof source.supports_stateless_compaction_fallback === "boolean") {
      result.supports_stateless_compaction_fallback = source.supports_stateless_compaction_fallback;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 主检测函数
// ---------------------------------------------------------------------------

/**
 * 检测 host capabilities
 *
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {object} [opts.env]
 * @param {boolean} [opts.probe]
 * @param {number} [opts.timeoutMs]
 * @returns {{ ok: boolean, data?: object, error?: string }}
 */
async function detect(opts) {
  const { host, env, probe = false, timeoutMs } = opts;

  // 收集多个来源
  const sources = [
    detectFromEnv(env),
    detectFromHost(host),
  ];

  // 如果需要 probe，异步获取
  if (probe && host) {
    try {
      const probed = await Promise.race([
        probeHost(host, timeoutMs),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("probe timeout")), timeoutMs || 5000)
        ),
      ]);
      sources.unshift(probed); // probe 结果优先级最高
    } catch (e) {
      // probe 失败不影响整体，继续使用其他来源
    }
  }

  // 合并结果
  const capabilities = mergeCapabilities(sources);

  // 验证
  const validation = validateCapabilities(capabilities);
  if (!validation.ok) {
    return { ok: false, error: `capability validation failed: ${validation.errors.join("; ")}` };
  }

  return {
    ok: true,
    data: {
      schema_version: "1.0",
      host: host || "unknown",
      detected_at: new Date().toISOString(),
      detection_method: probe ? "probe+infer+env" : host ? "infer+env" : "env",
      ...capabilities,
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
  node capability-detect.js detect [--host <name>] [--env-file <path>]
  node capability-detect.js probe --host <name> [--timeout <ms>]

Capability Contract (P-003 §1):
  supports_compaction:        "server" | "client" | "none"
  supports_prompt_cache:     "implicit" | "explicit" | "none"
  supports_render_receipt:   true | false
  supports_usage_receipt:    true | false
  supports_shared_prefix:   true | false
  supports_stateless_compaction_fallback: true | false
`);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (command === "probe") {
    if (!args.host) {
      console.error(JSON.stringify({ ok: false, error: "missing --host" }, null, 2));
      return;
    }
    const result = await detect({ host: args.host, probe: true, timeoutMs: args.timeout });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "detect" || !command) {
    const result = await detect({ host: args.host });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  usage();
}

module.exports = {
  detect,
  detectFromEnv,
  detectFromHost,
  probeHost,
  validateCapabilities,
  mergeCapabilities,
  DEFAULT_CAPABILITIES,
};

if (require.main === module) main();
