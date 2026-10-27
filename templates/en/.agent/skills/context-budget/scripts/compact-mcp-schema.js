"use strict";

/**
 * compact-mcp-schema.js — MCP Schema 压缩工具
 *
 * 功能：
 * - 将完整 JSON Schema 压缩为最小摘要
 * - 只保留: name, desc(简短描述), params(参数名:类型)
 * - 目标: 每个工具定义从 ~500 token 压缩到 ~50 token
 *
 * 使用：
 *   node compact-mcp-schema.js <input-schema.json> [output.json]
 *   或通过 stdin:
 *   cat schema.json | node compact-mcp-schema.js
 *
 * 约束：
 * - 零依赖: node:fs, node:path, node:crypto
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * 压缩 JSON Schema 为最小摘要
 * @param {object} schema - 完整 JSON Schema
 * @returns {object} 压缩后的 schema
 */
function compactSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  // 处理工具列表格式 (MCP tools 格式)
  if (Array.isArray(schema)) {
    return schema.map(compactTool);
  }

  // 处理 { tools: [...] } 格式
  if (schema.tools && Array.isArray(schema.tools)) {
    return {
      ...schema,
      tools: schema.tools.map(compactTool),
    };
  }

  // 处理 { definitions: {...} } 格式
  if (schema.definitions && typeof schema.definitions === "object") {
    return {
      ...schema,
      definitions: compactDefinitions(schema.definitions),
    };
  }

  // 单个工具
  return compactTool(schema);
}

/**
 * 压缩单个工具定义
 * @param {object} tool - 工具定义
 * @returns {object} 压缩后的工具定义
 */
function compactTool(tool) {
  if (!tool || typeof tool !== "object") {
    return tool;
  }

  const result = {
    name: tool.name || tool.id || tool.title || "unnamed",
  };

  // 简短描述 (desc): 取前 100 字符，去除多余空白
  if (tool.description || tool.desc || tool.summary) {
    const rawDesc = tool.description || tool.desc || tool.summary;
    result.desc = truncateDesc(rawDesc, 100);
  }

  // 参数 (params): 参数名:类型 格式
  if (tool.inputSchema || tool.parameters || tool.params) {
    const params = tool.inputSchema || tool.parameters || tool.params;
    result.params = compactParams(params);
  } else if (tool.properties) {
    result.params = compactParams({ properties: tool.properties, required: tool.required });
  }

  // 保留必要的元数据
  if (tool.annotations) {
    result.annotations = tool.annotations;
  }

  return result;
}

/**
 * 压缩参数定义为 "paramName: type" 格式
 * @param {object} params - 参数定义
 * @returns {object} 参数名到类型的映射
 */
function compactParams(params) {
  if (!params || typeof params !== "object") {
    return {};
  }

  const result = {};
  const properties = params.properties || {};
  const required = new Set(params.required || []);

  for (const [name, def] of Object.entries(properties)) {
    const type = extractType(def);
    result[name] = required.has(name) ? `${type}*` : type;
  }

  return result;
}

/**
 * 从参数定义中提取类型
 * @param {object} def - 参数定义
 * @returns {string} 类型字符串
 */
function extractType(def) {
  if (!def) return "any";

  // 处理 type 字段
  if (def.type) {
    // 处理数组类型
    if (def.type === "array" && def.items) {
      const itemType = extractType(def.items);
      return `${itemType}[]`;
    }
    return def.type;
  }

  // 处理 $ref
  if (def.$ref) {
    const refName = def.$ref.split("/").pop();
    return `ref:${refName}`;
  }

  // 处理 oneOf/anyOf
  if (def.oneOf || def.anyOf) {
    const types = (def.oneOf || def.anyOf).map(extractType);
    return types.length <= 3 ? types.join("|") : `${types[0]}...`;
  }

  // 处理 enum
  if (def.enum) {
    return `enum(${def.enum.length})`;
  }

  return "any";
}

/**
 * 截断描述文本
 * @param {string} desc - 原始描述
 * @param {number} maxLen - 最大长度
 * @returns {string} 截断后的描述
 */
function truncateDesc(desc, maxLen) {
  if (!desc || typeof desc !== "string") {
    return "";
  }

  // 去除多余空白
  const cleaned = desc.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLen) {
    return cleaned;
  }

  // 在单词边界截断
  const truncated = cleaned.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLen * 0.7) {
    return truncated.substring(0, lastSpace) + "...";
  }

  return truncated + "...";
}

/**
 * 压缩 definitions (schema 引用)
 * @param {object} defs - definitions 对象
 * @returns {object} 压缩后的 definitions
 */
function compactDefinitions(defs) {
  const result = {};

  for (const [name, def] of Object.entries(defs)) {
    if (def && typeof def === "object") {
      result[name] = {
        type: def.type || "object",
        desc: def.description ? truncateDesc(def.description, 80) : undefined,
        properties: def.properties ? Object.keys(def.properties) : undefined,
      };
    }
  }

  return result;
}

/**
 * 计算 token 估算 (简化版)
 * @param {string} text - 文本
 * @returns {number} 估算 token 数
 */
function estimateTokens(text) {
  if (!text) return 0;
  // 简化的 token 估算
  // CJK: ~1.5 chars/token, Latin: ~4 chars/token
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = text.length - cjk;
  return Math.ceil(cjk / 1.5 + latin / 4);
}

/**
 * 主函数
 */
function main() {
  let input;

  // 从 stdin 或文件读取
  if (process.argv.length < 3 || process.argv[2] === "-") {
    // 从 stdin 读取
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        outputResult(data);
      } catch (e) {
        console.error("Error parsing stdin:", e.message);
        process.exit(1);
      }
    });
  } else {
    // 从文件读取
    const inputPath = process.argv[2];
    try {
      const content = fs.readFileSync(inputPath, "utf8");
      input = JSON.parse(content);
    } catch (e) {
      console.error(`Error reading file ${inputPath}:`, e.message);
      process.exit(1);
    }

    outputResult(input);
  }

  function outputResult(data) {
    const compacted = compactSchema(data);

    // 计算压缩统计
    const originalStr = JSON.stringify(data);
    const compactedStr = JSON.stringify(compacted);
    const originalTokens = estimateTokens(originalStr);
    const compactedTokens = estimateTokens(compactedStr);
    const compressionRatio = ((1 - compactedStr.length / originalStr.length) * 100).toFixed(1);

    const result = {
      compacted,
      stats: {
        original_size: originalStr.length,
        compacted_size: compactedStr.length,
        original_tokens_est: originalTokens,
        compacted_tokens_est: compactedTokens,
        compression_ratio: `${compressionRatio}%`,
      },
    };

    // 输出或保存
    if (process.argv[3]) {
      const outputPath = process.argv[3];
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), "utf8");
      console.error(`Saved to ${outputPath}`);
      console.error(`Compression: ${compressionRatio}% (${originalTokens} -> ${compactedTokens} tokens estimated)`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
}

// 导出模块
module.exports = {
  compactSchema,
  compactTool,
  compactParams,
  estimateTokens,
};

// CLI 入口
if (require.main === module) {
  main();
}
