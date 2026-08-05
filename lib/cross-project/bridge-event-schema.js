"use strict";

// ─── Cross-Project Event Bridge Schema (P-003 Phase 1) ───────────────────────
//
// Schema set for the cross-project event bridge consumer side. Defines the
// canonical bridge event shape (P-003 §3.2) and the project-scoped
// subscriptions.json shape (P-003 §3.3). All schemas are `additionalProperties:
// false` and validated by a lightweight, ajv-free validator that supports
// `type`, `enum`, `minLength`, `minItems`, `pattern`, and
// `format: "date-time"`.
//
// Schemas exported:
//   • bridgeEventSchema         — the wire shape of a single bridge event
//                                  (P-003 §3.2 / "bridge_event_id",
//                                   "source_project_id", "event_type",
//                                   "summary", "propagated_at").
//   • subscriptionSchema        — one entry of subscriptions.json
//                                  (P-003 §3.3).
//   • subscriptionsFileSchema   — on-disk shape of subscriptions.json.
//
// Validators exported:
//   • validateBridgeEvent(obj)        → { ok, errors[] }
//   • validateSubscription(obj)       → { ok, errors[] }
//   • validateSubscriptionsFile(obj)  → { ok, errors[] }
//   • isValidBridgeEventId(value)     → boolean (used by inbox writer to
//                                       reject malformed event ids without
//                                       pulling a full schema validator).
//
// Phase 1 scope: this module validates the CONSUMER side. The producer side
// (task state changes → emit bridge event) is intentionally out of scope for
// Phase 1 and is left to a follow-up phase; see P-003 §8.
//
// Source: .agent/plans/proposals/projects/cross-project-coordination/
//         proposals/P-003-cross-project-event-bridge-proposal.md
//         §3.2 事件摘要格式
//         §3.3 订阅配置

const BRIDGE_EVENT_TYPES = Object.freeze([
  "task.state_changed",
  "decision.resolved",
  "waitpoint.released",
  "checkpoint.closed",
]);

const BRIDGE_EVENT_ID_PATTERN = /^BR-EVT-[A-Za-z0-9_-]+$/;
// RFC 3339 §5.6 strict full-date + full-time:
//   full-date      = date-fullyear "-" date-month "-" date-mday
//   date-month     = "0" / "1" + digit  (i.e. 01..12)
//   date-mday      = "0" / "1" / "2" + digit  (i.e. 01..31)
//   full-time      = partial-time time-offset
//   time-hour      = "0" / "1" / "2" + digit  (i.e. 00..23)
//   time-minute    = digit + "0".."5" + digit (i.e. 00..59)
//   time-second    = digit + "0".."5" + digit (i.e. 00..58) + "." 1*3digit
//   time-offset    = "Z" / time-numoffset
//   time-numoffset = ("+" / "-") time-hour ":" time-minute
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function closed(schema) {
  return { ...schema, additionalProperties: false };
}

const bridgeEventSchema = closed({
  $id: "cortex-agent/cross-project/bridge-event",
  type: "object",
  required: ["bridge_event_id", "source_project_id", "event_type", "summary", "propagated_at"],
  properties: {
    bridge_event_id: {
      type: "string",
      minLength: 1,
      pattern: BRIDGE_EVENT_ID_PATTERN.source,
    },
    source_project_id: { type: "string", minLength: 1 },
    source_task_id: { type: "string", minLength: 1 },
    correlation_group: { type: "string", minLength: 1 },
    event_type: { type: "string", enum: BRIDGE_EVENT_TYPES.slice() },
    summary: { type: "object" },
    propagated_at: { type: "string", format: "date-time" },
  },
});

const subscriptionSchema = closed({
  $id: "cortex-agent/cross-project/subscription",
  type: "object",
  required: ["source_project_id", "event_types"],
  properties: {
    source_project_id: { type: "string", minLength: 1 },
    correlation_group: { type: "string", minLength: 1 },
    event_types: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    filter: { type: "object" },
  },
});

const subscriptionsFileSchema = closed({
  $id: "cortex-agent/cross-project/subscriptions-file",
  type: "object",
  required: ["subscriptions"],
  properties: {
    subscriptions: {
      type: "array",
      items: subscriptionSchema,
    },
  },
});

// ─── Validator (additionalProperties / required / type / enum / pattern /
//                format=date-time / minLength / minItems) ────────────────────
//
// Intentionally narrow: schema annotations we don't support are *ignored*
// rather than rejected, so a future schema annotation does not break older
// binaries silently. See the schema-shape tests for what is enforced.

function validateAgainst(schema, obj, sink) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    sink.push("root: must be object");
    return;
  }
  if (Array.isArray(schema.required)) {
    for (const req of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(obj, req)) {
        sink.push(`missing required: ${req}`);
      }
    }
  }
  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(obj)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        sink.push(`additional property not allowed: ${key}`);
      }
    }
  }
  if (schema.properties) {
    for (const [key, def] of Object.entries(schema.properties)) {
      if (obj[key] === undefined || obj[key] === null) continue;
      validateValue(def, obj[key], key, sink);
    }
  }
}

function validateValue(def, v, where, sink) {
  if (def.type === "string") {
    if (typeof v !== "string") { sink.push(`${where}: must be string`); return; }
    if (typeof def.minLength === "number" && v.length < def.minLength) {
      sink.push(`${where}: must be at least ${def.minLength} characters`);
      return;
    }
    if (typeof def.pattern === "string") {
      const re = new RegExp(def.pattern);
      if (!re.test(v)) { sink.push(`${where}: must match pattern ${def.pattern}`); return; }
    }
    if (def.format === "date-time") {
      if (!ISO_DATE_TIME_PATTERN.test(v)) { sink.push(`${where}: must be ISO 8601 date-time`); return; }
    }
  } else if (def.type === "boolean") {
    if (typeof v !== "boolean") { sink.push(`${where}: must be boolean`); return; }
  } else if (def.type === "array") {
    if (!Array.isArray(v)) { sink.push(`${where}: must be array`); return; }
    if (typeof def.minItems === "number" && v.length < def.minItems) {
      sink.push(`${where}: must have at least ${def.minItems} items`);
      return;
    }
    if (def.items) {
      v.forEach((item, idx) => validateValue(def.items, item, `${where}[${idx}]`, sink));
    }
  } else if (def.type === "object") {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      sink.push(`${where}: must be object`);
      return;
    }
    if (def.properties) {
      validateAgainst({ ...def, required: def.required || [] }, v, sink);
    }
  }
  if (Array.isArray(def.enum) && !def.enum.includes(v)) {
    sink.push(`${where}: must be one of ${def.enum.join(",")}`);
  }
}

function validateBridgeEvent(obj) {
  const sink = [];
  validateAgainst(bridgeEventSchema, obj, sink);
  return sink.length === 0 ? { ok: true } : { ok: false, errors: sink };
}

function validateSubscription(obj) {
  const sink = [];
  validateAgainst(subscriptionSchema, obj, sink);
  return sink.length === 0 ? { ok: true } : { ok: false, errors: sink };
}

function validateSubscriptionsFile(obj) {
  const sink = [];
  validateAgainst(subscriptionsFileSchema, obj, sink);
  return sink.length === 0 ? { ok: true } : { ok: false, errors: sink };
}

function isValidBridgeEventId(value) {
  return typeof value === "string" && BRIDGE_EVENT_ID_PATTERN.test(value);
}

module.exports = {
  // Schemas
  bridgeEventSchema,
  subscriptionSchema,
  subscriptionsFileSchema,
  // Constants
  BRIDGE_EVENT_TYPES,
  BRIDGE_EVENT_ID_PATTERN,
  ISO_DATE_TIME_PATTERN,
  // Validators
  validateBridgeEvent,
  validateSubscription,
  validateSubscriptionsFile,
  isValidBridgeEventId,
  // Exposed for tests / reuse
  validateAgainst,
};
