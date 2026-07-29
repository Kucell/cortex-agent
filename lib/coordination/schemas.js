"use strict";

// ─── Host Wakeup Adapter & Coordination Binding Schemas ────────────────────
// Schema set for the vendor-neutral Host Adapter Protocol v1 (CP-8) and the
// project-scoped Local Consumer / Binding registry (CP-9). All schemas are
// `additionalProperties: false` and validated by the lightweight, ajv-free
// `validateAgainst` helper below.
//
// Schemas exported:
//   • adapterSchema, wakeupSchema, structuredContextSchema, resultSchema
//     — legacy CP-8 protocol shapes (unchanged, additive).
//   • capabilityDescriptorV1Schema — CP-8 stable capability vocabulary
//     descriptor (consumer-facing, NOT the adapter-core v1 descriptor).
//   • deliveryReceiptSchema — CP-8 four-way `delivered|presented|deferred|failed`
//     delivery receipt, scoped to redacted fields only.
//   • consumerRegistrationSchema — CP-9 project-scoped consumer entry.
//   • subscriptionListSchema — CP-9 subscription list per consumer.
//   • fallbackChainSchema — CP-9 ordered fallback adapter chain.
//   • localHostBindingSchema — CP-9 local binding envelope (subscriptions +
//     fallback + adapter id + consumer id; redacted).
//   • bindingPersistenceEnvelopeSchema — CP-9 on-disk envelope that bundles
//     the binding + project id + version + schemaVersion.

const { CAPABILITY_NAMES, DELIVERY_RESULT_VALUES } = require("./host-capabilities");

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

// ─── CP-8 additions ─────────────────────────────────────────────────────────

const capabilityDescriptorV1Schema = closed({
  $id: "cortex-agent/coordination/capability-descriptor-v1",
  type: "object",
  required: ["schemaVersion", "adapterId", "capabilities"],
  properties: {
    schemaVersion: { type: "string", minLength: 1 },
    adapterId: { type: "string", minLength: 1 },
    capabilities: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    detectedAt: { type: "string" },
  },
});

const deliveryReceiptSchema = closed({
  $id: "cortex-agent/coordination/delivery-receipt",
  type: "object",
  required: ["deliveryKey", "consumerId", "eventId", "target", "status"],
  properties: {
    deliveryKey: { type: "string", minLength: 1 },
    consumerId: { type: "string", minLength: 1 },
    eventId: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    status: { enum: DELIVERY_RESULT_VALUES },
    adapterId: { type: ["string", "null"] },
    attempts: { type: "integer", minimum: 1 },
    nextAttemptAt: { type: ["string", "null"] },
    acked: { type: "boolean" },
    reason: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
});

// ─── CP-9 additions ─────────────────────────────────────────────────────────

const subscriptionListSchema = closed({
  $id: "cortex-agent/coordination/subscription-list",
  type: "object",
  required: ["subscriptions"],
  properties: {
    subscriptions: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
});

const fallbackChainSchema = closed({
  $id: "cortex-agent/coordination/fallback-chain",
  type: "object",
  required: ["fallback"],
  properties: {
    fallback: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
  },
});

const consumerRegistrationSchema = closed({
  $id: "cortex-agent/coordination/consumer-registration",
  type: "object",
  required: ["consumerId", "target"],
  properties: {
    consumerId: { type: "string", minLength: 1, maxLength: 128 },
    target: {
      type: "object",
      required: ["kind", "actorId"],
      properties: {
        kind: { type: "string", minLength: 1, maxLength: 64 },
        actorId: { type: "string", minLength: 1, maxLength: 256 },
      },
      additionalProperties: false,
    },
    adapterId: { type: "string", minLength: 1, maxLength: 128 },
    fallback: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    subscriptions: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    schemaVersion: { type: "string" },
  },
});

const localHostBindingSchema = closed({
  $id: "cortex-agent/coordination/local-host-binding",
  type: "object",
  required: ["consumerId", "target", "adapter"],
  properties: {
    consumerId: { type: "string", minLength: 1, maxLength: 128 },
    target: {
      type: "object",
      required: ["kind", "actorId"],
      properties: {
        kind: { type: "string", minLength: 1, maxLength: 64 },
        actorId: { type: "string", minLength: 1, maxLength: 256 },
      },
      additionalProperties: false,
    },
    adapter: { type: "string", minLength: 1, maxLength: 128 },
    fallback: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 128 },
    },
    subscriptions: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    schemaVersion: { type: "string" },
  },
});

const bindingPersistenceEnvelopeSchema = closed({
  $id: "cortex-agent/coordination/binding-persistence-envelope",
  type: "object",
  required: ["schemaVersion", "projectId", "binding"],
  properties: {
    schemaVersion: { type: "string", minLength: 1 },
    projectId: { type: "string", minLength: 1, maxLength: 256 },
    binding: localHostBindingSchema,
    updatedAt: { type: "string" },
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
      else if (def.type === "integer" && !(Number.isInteger(v))) errors.push(`${key}: must be integer`);
      else if (def.enum && !def.enum.includes(v)) errors.push(`${key}: must be one of ${def.enum.join(",")}`);
      // nested object schema with its own properties
      if (def.type === "object" && def.properties && typeof v === "object" && v !== null) {
        const sub = validateAgainst({ ...def, required: def.required || [] }, v);
        if (!sub.ok) errors.push(`${key}: ${sub.errors.join(", ")}`);
      }
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

function validateCapabilityDescriptorV1(obj) {
  const result = validateAgainst(capabilityDescriptorV1Schema, obj);
  if (!result.ok) return result;
  // Closed-vocabulary check against the frozen capability names.
  const seen = new Set();
  for (const cap of obj.capabilities) {
    if (!CAPABILITY_NAMES.includes(cap)) {
      return { ok: false, errors: [`capabilities[${cap}]: not in CP-8 vocabulary`] };
    }
    if (seen.has(cap)) {
      return { ok: false, errors: [`capabilities: duplicate ${cap}`] };
    }
    seen.add(cap);
  }
  return { ok: true };
}

function validateDeliveryReceipt(obj) {
  return validateAgainst(deliveryReceiptSchema, obj);
}

function validateConsumerRegistration(obj) {
  return validateAgainst(consumerRegistrationSchema, obj);
}

function validateSubscriptionList(obj) {
  return validateAgainst(subscriptionListSchema, obj);
}

function validateFallbackChain(obj) {
  return validateAgainst(fallbackChainSchema, obj);
}

function validateLocalHostBinding(obj) {
  return validateAgainst(localHostBindingSchema, obj);
}

function validateBindingPersistenceEnvelope(obj) {
  return validateAgainst(bindingPersistenceEnvelopeSchema, obj);
}

module.exports = {
  // CP-8 legacy
  adapterSchema,
  wakeupSchema,
  structuredContextSchema,
  resultSchema,
  // CP-8 additions
  capabilityDescriptorV1Schema,
  deliveryReceiptSchema,
  // CP-9 additions
  consumerRegistrationSchema,
  subscriptionListSchema,
  fallbackChainSchema,
  localHostBindingSchema,
  bindingPersistenceEnvelopeSchema,
  // Validators
  validateStructuredContext,
  validateWakeup,
  validateAdapter,
  validateResult,
  validateCapabilityDescriptorV1,
  validateDeliveryReceipt,
  validateConsumerRegistration,
  validateSubscriptionList,
  validateFallbackChain,
  validateLocalHostBinding,
  validateBindingPersistenceEnvelope,
  // Exposed for tests / re-use
  validateAgainst,
};