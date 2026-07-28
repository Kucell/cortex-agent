"use strict";

const { CoordinationError } = require("./errors");

const FIELDS = Object.freeze({
  producer: new Set(["actorId", "kind", "vendor", "sessionId"]),
  target: new Set(["actorId", "kind"]),
  repository: new Set(["repositoryId", "worktreeId", "branch", "baselineCommit"]),
  ownership: new Set(["leaseId", "scope", "owner", "fencingToken", "expiresAt"]),
  progress: new Set(["phase", "percent", "summary"]),
  evidence: new Set(["kind", "ref"]),
  requestedAction: new Set(["kind", "ref", "decisionRef", "waitpointRef", "message"]),
  notification: new Set(["policy", "dedupeKey", "ackRequired"]),
});

function invalid(reason, field) {
  throw new CoordinationError("ERR_INVALID_EVENT", {
    details: { reason, ...(field ? { field } : {}) },
  });
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${field} must be an object`, field);
  }
}

function only(value, allowed, field) {
  if (Object.keys(value).some((name) => !allowed.has(name))) {
    invalid(`${field} has unknown fields`, field);
  }
}

function optionalString(value, field) {
  if (value !== null && value !== undefined
      && (typeof value !== "string" || value.length === 0)) {
    invalid(`${field} must be a non-empty string or null`, field);
  }
}

function dateTime(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined)) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalid(`${field} must be an ISO date-time string`, field);
  }
}

function actor(value, field, kinds, producer) {
  object(value, field);
  only(value, producer ? FIELDS.producer : FIELDS.target, field);
  optionalString(value.actorId, `${field}.actorId`);
  if (!value.actorId) invalid(`${field}.actorId is required`, `${field}.actorId`);
  if ((producer || value.kind !== undefined) && !kinds.includes(value.kind)) {
    invalid(`${field}.kind is invalid`, `${field}.kind`);
  }
  optionalString(value.vendor, `${field}.vendor`);
  optionalString(value.sessionId, `${field}.sessionId`);
}

function ownership(value, field) {
  object(value, field);
  only(value, FIELDS.ownership, field);
  for (const name of ["leaseId", "scope", "owner"]) {
    if (typeof value[name] !== "string" || value[name].length === 0) {
      invalid(`${field}.${name} is required`);
    }
  }
  if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
    invalid(`${field}.fencingToken must be a positive integer`);
  }
  dateTime(value.expiresAt, `${field}.expiresAt`);
}

function progress(value) {
  if (value === null || value === undefined) return;
  object(value, "progress");
  only(value, FIELDS.progress, "progress");
  optionalString(value.phase, "progress.phase");
  if (value.summary !== undefined
      && (typeof value.summary !== "string" || value.summary.length > 4000)) {
    invalid("progress.summary must be a bounded string", "progress.summary");
  }
  if (value.percent !== undefined
      && (!Number.isFinite(value.percent) || value.percent < 0
        || value.percent > 100)) {
    invalid("progress.percent must be between 0 and 100", "progress.percent");
  }
}

function requestedAction(value, kinds) {
  if (value === null || value === undefined) return;
  object(value, "requestedAction");
  only(value, FIELDS.requestedAction, "requestedAction");
  if (!kinds.includes(value.kind)) {
    invalid("requestedAction.kind is invalid", "requestedAction.kind");
  }
  for (const name of ["ref", "decisionRef", "waitpointRef", "message"]) {
    optionalString(value[name], `requestedAction.${name}`);
  }
}

function validateEventNestedFields(event, vocabulary) {
  actor(event.producer, "producer", vocabulary.actorKinds, true);
  if (!Array.isArray(event.targets)) invalid("targets must be an array", "targets");
  event.targets.forEach((target, index) =>
    actor(target, `targets[${index}]`, vocabulary.actorKinds, false));

  object(event.repository, "repository");
  only(event.repository, FIELDS.repository, "repository");
  if (typeof event.repository.repositoryId !== "string"
      || event.repository.repositoryId.length === 0) {
    invalid("repository.repositoryId is required", "repository.repositoryId");
  }
  for (const name of ["worktreeId", "branch", "baselineCommit"]) {
    optionalString(event.repository[name], `repository.${name}`);
  }

  if (!Array.isArray(event.fileOwnership || [])) {
    invalid("fileOwnership must be an array", "fileOwnership");
  }
  (event.fileOwnership || []).forEach((item, index) =>
    ownership(item, `fileOwnership[${index}]`));
  progress(event.progress);

  if (!Array.isArray(event.evidence || [])) invalid("evidence must be an array");
  for (const [index, evidence] of (event.evidence || []).entries()) {
    object(evidence, `evidence[${index}]`);
    only(evidence, FIELDS.evidence, `evidence[${index}]`);
    if (!vocabulary.evidenceKinds.includes(evidence.kind)) {
      invalid(`evidence[${index}].kind is invalid`, `evidence[${index}].kind`);
    }
    vocabulary.validateEvidenceRef(evidence.ref);
  }

  requestedAction(event.requestedAction, vocabulary.requestedActionKinds);
  object(event.notification, "notification");
  only(event.notification, FIELDS.notification, "notification");
  if (!vocabulary.notificationPolicies.includes(event.notification.policy)) {
    invalid("notification.policy is invalid", "notification.policy");
  }
  optionalString(event.notification.dedupeKey, "notification.dedupeKey");
  if (event.notification.ackRequired !== undefined
      && typeof event.notification.ackRequired !== "boolean") {
    invalid("notification.ackRequired must be boolean", "notification.ackRequired");
  }
  dateTime(event.expiresAt, "expiresAt", true);
}

function validateTaskNestedFields(task, vocabulary) {
  for (const name of ["revision", "lastSequence"]) {
    const minimum = name === "lastSequence" ? 0 : 1;
    if (!Number.isSafeInteger(task[name]) || task[name] < minimum) {
      invalid(`${name} must be an integer >= ${minimum}`, name);
    }
  }
  for (const name of ["createdAt", "updatedAt"]) dateTime(task[name], name);
  for (const name of ["heartbeatDueAt", "lastHeartbeatAt", "lastEventAt"]) {
    dateTime(task[name], name, true);
  }
  for (const name of [
    "parentTaskId", "correlationId", "lastEventId", "assignee", "operationId",
  ]) {
    optionalString(task[name], name);
  }
  if (!Array.isArray(task.ownership)) invalid("ownership must be an array");
  task.ownership.forEach((item, index) => ownership(item, `ownership[${index}]`));
  if (!Array.isArray(task.evidenceRefs)) invalid("evidenceRefs must be an array");
  vocabulary.validateEvidenceRefs(task.evidenceRefs);
  if (new Set(task.evidenceRefs).size !== task.evidenceRefs.length) {
    invalid("evidenceRefs must contain unique values");
  }
  if (!Array.isArray(task.pendingCriticalEvents)
      || task.pendingCriticalEvents.some((value) => typeof value !== "string" || !value)
      || new Set(task.pendingCriticalEvents).size !== task.pendingCriticalEvents.length) {
    invalid("pendingCriticalEvents must contain unique non-empty strings");
  }
  if (task.operationAttempt !== null && task.operationAttempt !== undefined
      && (!Number.isSafeInteger(task.operationAttempt) || task.operationAttempt < 1)) {
    invalid("operationAttempt must be a positive integer");
  }
  progress(task.progress);
  requestedAction(task.requestedAction, vocabulary.requestedActionKinds);
}

module.exports = {
  validateEventNestedFields,
  validateTaskNestedFields,
};
