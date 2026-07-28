"use strict";

// ─── Host Wakeup Adapter Schemas ─────────────────────────────────────────────
// 全部 schema 强制 additionalProperties=false；validate 函数返回 {ok, errors?}。
// 不引入 ajv/zod 等第三方依赖；手写最小校验足够契约场景。

function closed(schema) {
  return { ...schema, additionalProperties: false };
}

const adapterSchema = closed({
  $id: "cortex-agent/coordination/host-adapter",
  type: "object",
  required: ["adapterId", "capabilities"],
  properties: {
    adapterId: { type: "string", minLength: 1 },
    capabilities: { type: "array", items: { type: "string", minLength: 1 } },
    schemaVersion: { type: "string" },
  },
});

const wakeupSchema = closed({
  $id: "cortex-agent/coordination/host-wakeup",
  type: "object",
  required: ["taskId", "threadId", "context", "state", "autoApprove", "sideEffects"],
  properties: {
    taskId: { type: "string", minLength: 1 },
    threadId: { type: "string", minLength: 1 },
    context: { type: "object" },
    state: { enum: ["pending", "deferred", "running", "ack_pending", "completed", "failed"] },
    autoApprove: { type: "boolean" },
    sideEffects: { type: "boolean" },
    deferredReason: { type: ["string", "null"] },
  },
});

const structuredContextSchema = closed({
  $id: "cortex-agent/coordination/structured-context",
  type: "object",
  required: ["threadId", "summary"],
  properties: {
    threadId: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    references: { type: "array", items: { type: "object" } },
    constraints: { type: "array", items: { type: "string" } },
    priority: { enum: ["low", "normal", "high", "urgent"] },
  },
});

const resultSchema = closed({
  $id: "cortex-agent/coordination/result-delivery",
  type: "object",
  required: ["taskId", "status"],
  properties: {
    taskId: { type: "string", minLength: 1 },
    status: { enum: ["completed", "failed"] },
    payload: { type: ["object", "null"] },
  },
});

// ─── 轻量校验器（仅校验 additionalProperties / required / type / enum） ────

function validateAgainst(schema, obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, errors: ["root: must be object"] };
  }
  const errors = [];
  for (const req of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(obj, req)) {
      errors.push(`missing required: ${req}`);
    }
  }
  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(obj)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        errors.push(`additional property not allowed: ${key}`);
      }
    }
  }
  if (schema.properties) {
    for (const [key, def] of Object.entries(schema.properties)) {
      if (obj[key] === undefined || obj[key] === null) continue;
      const v = obj[key];
      if (def.type === "string" && typeof v !== "string") errors.push(`${key}: must be string`);
      else if (def.type === "boolean" && typeof v !== "boolean") errors.push(`${key}: must be boolean`);
      else if (def.type === "array" && !Array.isArray(v)) errors.push(`${key}: must be array`);
      else if (def.type === "object" && (typeof v !== "object" || Array.isArray(v))) errors.push(`${key}: must be object`);
      else if (def.enum && !def.enum.includes(v)) errors.push(`${key}: must be one of ${def.enum.join(",")}`);
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateStructuredContext(obj) {
  return validateAgainst(structuredContextSchema, obj);
}

function validateWakeup(obj) {
  return validateAgainst(wakeupSchema, obj);
}

function validateAdapter(obj) {
  return validateAgainst(adapterSchema, obj);
}

function validateResult(obj) {
  return validateAgainst(resultSchema, obj);
}

module.exports = {
  adapterSchema,
  wakeupSchema,
  structuredContextSchema,
  resultSchema,
  validateStructuredContext,
  validateWakeup,
  validateAdapter,
  validateResult,
};
