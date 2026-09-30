"use strict";

const PLATFORM_HEALTH_SCHEMA_VERSION = "1";

const HEALTH_STATUSES = Object.freeze([
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
]);

const HEALTH_COMPONENT_KINDS = Object.freeze([
  "package",
  "protocol",
  "project",
  "daemon",
  "permission",
  "runtime",
  "regression",
  "extension",
]);

const TOP_KEYS = new Set([
  "schema_version",
  "generated_at",
  "overall",
  "components",
]);

const COMPONENT_KEYS = new Set([
  "id",
  "kind",
  "status",
  "observed_at",
  "producer",
  "checks",
  "evidence_refs",
  "redacted",
]);

const CHECK_KEYS = new Set([
  "id",
  "status",
  "message",
  "observed_at",
  "details",
]);

const PRODUCER_KEYS = new Set([
  "id",
  "kind",
  "version",
]);

class PlatformHealthError extends Error {
  constructor(code, details = {}) {
    super(`[platform-health:${code}] ${JSON.stringify(details)}`);
    this.name = "PlatformHealthError";
    this.code = code;
    this.details = details;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(value, allowed, where) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) {
      throw new PlatformHealthError("ERR_PLATFORM_HEALTH_FIELD_UNKNOWN", {
        where,
        key,
      });
    }
  }
}

function requiredString(value, where) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_FIELD_INVALID", { where });
  }
  return value.trim();
}

function optionalString(value, where) {
  if (value == null) return null;
  return requiredString(value, where);
}

function timestamp(value, where) {
  const raw = requiredString(value, where);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_TIMESTAMP", {
      where,
      value,
    });
  }
  return parsed.toISOString();
}

function status(value, where) {
  if (!HEALTH_STATUSES.includes(value)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_STATUS", {
      where,
      value,
      allowed: HEALTH_STATUSES,
    });
  }
  return value;
}

function kind(value, where) {
  if (!HEALTH_COMPONENT_KINDS.includes(value)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_COMPONENT_KIND", {
      where,
      value,
      allowed: HEALTH_COMPONENT_KINDS,
    });
  }
  return value;
}

function normalizeDetails(value, where) {
  if (value == null) return Object.freeze({});
  if (!plain(value)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_DETAILS", { where });
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null
      || typeof entry === "string"
      || typeof entry === "number"
      || typeof entry === "boolean") {
      out[key] = entry;
    } else {
      throw new PlatformHealthError("ERR_PLATFORM_HEALTH_DETAIL_VALUE", {
        where,
        key,
      });
    }
  }
  return Object.freeze(out);
}

function normalizeProducer(input, where) {
  if (!plain(input)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_PRODUCER", { where });
  }
  rejectUnknown(input, PRODUCER_KEYS, where);
  return Object.freeze({
    id: requiredString(input.id, `${where}.id`),
    kind: requiredString(input.kind, `${where}.kind`),
    version: optionalString(input.version, `${where}.version`),
  });
}

function normalizeCheck(input, componentObservedAt, index) {
  const where = `components[].checks[${index}]`;
  if (!plain(input)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_CHECK", { where });
  }
  rejectUnknown(input, CHECK_KEYS, where);
  return Object.freeze({
    id: requiredString(input.id, `${where}.id`),
    status: status(input.status, `${where}.status`),
    message: optionalString(input.message, `${where}.message`),
    observed_at: input.observed_at == null
      ? componentObservedAt
      : timestamp(input.observed_at, `${where}.observed_at`),
    details: normalizeDetails(input.details, `${where}.details`),
  });
}

function normalizeComponent(input, index) {
  const where = `components[${index}]`;
  if (!plain(input)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_COMPONENT", { where });
  }
  rejectUnknown(input, COMPONENT_KEYS, where);
  if (typeof input.redacted !== "boolean") {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_REDACTION", { where });
  }
  const observedAt = timestamp(input.observed_at, `${where}.observed_at`);
  if (!Array.isArray(input.checks || [])) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_CHECKS", { where });
  }
  if (!Array.isArray(input.evidence_refs || [])) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_EVIDENCE", { where });
  }
  return Object.freeze({
    id: requiredString(input.id, `${where}.id`),
    kind: kind(input.kind, `${where}.kind`),
    status: status(input.status, `${where}.status`),
    observed_at: observedAt,
    producer: normalizeProducer(input.producer, `${where}.producer`),
    checks: Object.freeze(
      (input.checks || []).map((check, checkIndex) =>
        normalizeCheck(check, observedAt, checkIndex)),
    ),
    evidence_refs: Object.freeze(
      (input.evidence_refs || []).map((ref, refIndex) =>
        requiredString(ref, `${where}.evidence_refs[${refIndex}]`)),
    ),
    redacted: input.redacted,
  });
}

function aggregateHealthStatus(components) {
  if (!Array.isArray(components) || components.length === 0) return "unknown";
  const statuses = new Set(components.map((component) => component.status));
  if (statuses.has("unhealthy")) return "unhealthy";
  if (statuses.has("degraded")) return "degraded";
  if (statuses.has("unknown")) return "unknown";
  return "healthy";
}

function normalizePlatformHealth(input) {
  if (!plain(input)) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_INVALID", {});
  }
  rejectUnknown(input, TOP_KEYS, "health");

  const schemaVersion = input.schema_version == null
    ? PLATFORM_HEALTH_SCHEMA_VERSION
    : String(input.schema_version);
  if (schemaVersion !== PLATFORM_HEALTH_SCHEMA_VERSION) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_SCHEMA_VERSION", {
      expected: PLATFORM_HEALTH_SCHEMA_VERSION,
      received: schemaVersion,
    });
  }

  if (!Array.isArray(input.components || [])) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_COMPONENTS", {});
  }

  const components = Object.freeze(
    (input.components || []).map(normalizeComponent),
  );

  const computed = aggregateHealthStatus(components);
  const requested = input.overall == null
    ? computed
    : status(input.overall, "overall");

  if (input.overall != null && requested !== computed) {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_AGGREGATION_MISMATCH", {
      provided: requested,
      computed,
    });
  }

  return Object.freeze({
    schema_version: PLATFORM_HEALTH_SCHEMA_VERSION,
    generated_at: timestamp(input.generated_at, "generated_at"),
    overall: computed,
    components,
  });
}

function createHealthProducer(options = {}) {
  const producer = normalizeProducer({
    id: options.id,
    kind: options.kind,
    version: options.version || null,
  }, "producer");

  if (typeof options.produce !== "function") {
    throw new PlatformHealthError("ERR_PLATFORM_HEALTH_PRODUCE_REQUIRED", {
      producer_id: producer.id,
    });
  }

  return Object.freeze({
    producer,
    async produce(context = {}) {
      const result = await options.produce(context);
      if (!Array.isArray(result)) {
        throw new PlatformHealthError("ERR_PLATFORM_HEALTH_PRODUCER_RESULT", {
          producer_id: producer.id,
        });
      }
      return Object.freeze(
        result.map((component, index) =>
          normalizeComponent({
            ...component,
            producer,
          }, index)),
      );
    },
  });
}

module.exports = {
  PLATFORM_HEALTH_SCHEMA_VERSION,
  HEALTH_STATUSES,
  HEALTH_COMPONENT_KINDS,
  PlatformHealthError,
  aggregateHealthStatus,
  normalizePlatformHealth,
  createHealthProducer,
};
