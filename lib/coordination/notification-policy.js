"use strict";

const crypto = require("crypto");
const { isCriticalEventType, NOTIFICATION_POLICIES } = require("./contract");

const POLICY_PRIORITY = Object.freeze({
  journal_only: 0,
  coordinator_notify: 1,
  user_attention: 2,
  urgent: 3,
});

const DEFAULT_RETRY = Object.freeze({
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  maxAttempts: 5,
});

class NotificationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "NotificationError";
    this.code = code;
    this.details = details;
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new NotificationError("ERR_NOTIFICATION_CONFIG", { field: name, value });
  }
}

function normalizeRetry(options = {}) {
  const retry = {
    initialDelayMs: options.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    maxAttempts: options.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
  };
  assertNonNegativeInteger(retry.initialDelayMs, "initialDelayMs");
  assertNonNegativeInteger(retry.maxDelayMs, "maxDelayMs");
  assertNonNegativeInteger(retry.maxAttempts, "maxAttempts");
  if (retry.maxDelayMs < retry.initialDelayMs || retry.maxAttempts === 0) {
    throw new NotificationError("ERR_NOTIFICATION_CONFIG", { retry });
  }
  return retry;
}

function computeBackoff(attempt, options = {}) {
  const retry = normalizeRetry(options);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new NotificationError("ERR_NOTIFICATION_CONFIG", { field: "attempt", value: attempt });
  }
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(retry.maxDelayMs, retry.initialDelayMs * (2 ** exponent));
}

function targetIdentity(target) {
  if (!target || typeof target !== "object") {
    throw new NotificationError("ERR_NOTIFICATION_TARGET", { target });
  }
  const actorId = typeof target.actorId === "string" ? target.actorId.trim() : "";
  const kind = typeof target.kind === "string" ? target.kind.trim() : "";
  if (!actorId || !kind || actorId.length > 256 || kind.length > 64) {
    throw new NotificationError("ERR_NOTIFICATION_TARGET", { target });
  }
  return `${kind}:${actorId}`;
}

function deliveryKey(eventId, consumerId, target) {
  if (typeof eventId !== "string" || !eventId || typeof consumerId !== "string" || !consumerId) {
    throw new NotificationError("ERR_NOTIFICATION_IDENTITY", { eventId, consumerId });
  }
  const material = `${eventId}\0${consumerId}\0${targetIdentity(target)}`;
  return crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

function evaluateNotification(event) {
  if (!event || typeof event !== "object") {
    throw new NotificationError("ERR_NOTIFICATION_EVENT");
  }
  const notification = event.notification || {};
  const policy = notification.policy || "journal_only";
  if (!NOTIFICATION_POLICIES.includes(policy)) {
    throw new NotificationError("ERR_NOTIFICATION_POLICY", { policy });
  }
  const critical = isCriticalEventType(event.eventType);
  return Object.freeze({
    policy,
    priority: POLICY_PRIORITY[policy],
    deliver: policy !== "journal_only",
    ackRequired: policy !== "journal_only" && (critical || notification.ackRequired === true),
    dedupeKey: notification.dedupeKey || event.eventType,
    critical,
  });
}

module.exports = {
  DEFAULT_RETRY,
  NotificationError,
  POLICY_PRIORITY,
  computeBackoff,
  deliveryKey,
  evaluateNotification,
  normalizeRetry,
  targetIdentity,
};
