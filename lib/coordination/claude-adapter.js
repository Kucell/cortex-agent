"use strict";

const {
  REPORTING_MODES,
  assertRepoRelative,
  assertSafeId,
  assertSafeText,
  createAdapterDescriptor,
  hasCapability,
  normalizeStringList,
  sanitizeEvidenceRefs,
} = require("./adapter-core");

const CLAUDE_HOOK_EVENT_MAP = Object.freeze({
  SessionStart: "task.accepted",
  FirstToolUse: "task.progress",
  TestStart: "task.testing",
  PermissionRequest: "task.input_required",
  ArtifactReady: "artifact.ready",
  ReadyForReview: "task.ready_for_review",
});

const REPORTABLE_EVENT_TYPES = new Set([
  ...Object.values(CLAUDE_HOOK_EVENT_MAP),
  "task.heartbeat",
  "task.blocked",
  "task.failed",
]);

function createLaunchContext(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("launch context must be an object");
  }
  const repository = input.repository || {};
  return Object.freeze({
    taskId: assertSafeId(input.taskId, "taskId"),
    correlationId: assertSafeId(input.correlationId, "correlationId"),
    projectId: assertSafeId(input.projectId, "projectId"),
    repository: Object.freeze({
      repositoryId: assertSafeId(repository.repositoryId, "repositoryId"),
      worktreeId: repository.worktreeId
        ? assertSafeId(repository.worktreeId, "worktreeId")
        : null,
      branch: assertSafeText(repository.branch, "branch"),
      baselineCommit: repository.baselineCommit
        ? assertSafeId(repository.baselineCommit, "baselineCommit")
        : null,
    }),
    ownershipScopes: normalizeStringList(
      input.ownershipScopes,
      "ownershipScopes",
      assertRepoRelative,
    ),
    acceptanceCriteria: normalizeStringList(
      input.acceptanceCriteria,
      "acceptanceCriteria",
    ),
    forbiddenActions: normalizeStringList(
      input.forbiddenActions || [],
      "forbiddenActions",
    ),
    allowedTools: normalizeStringList(input.allowedTools || [], "allowedTools"),
    heartbeatIntervalMs: normalizePositiveInteger(
      input.heartbeatIntervalMs,
      "heartbeatIntervalMs",
    ),
    terminalTimeoutMs: normalizePositiveInteger(
      input.terminalTimeoutMs,
      "terminalTimeoutMs",
    ),
    notificationPolicy: assertSafeId(
      input.notificationPolicy,
      "notificationPolicy",
    ),
  });
}

function normalizePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function detectClaudeCapabilities(host = {}) {
  return createAdapterDescriptor({
    adapterId: host.adapterId || "claude-code",
    vendor: host.vendor || "anthropic",
    capabilities: {
      hooks: host.hooks === true,
      explicitCli: host.explicitCli !== false,
      processBoundaryEvidence: host.processBoundaryEvidence === true,
    },
  });
}

function reportingMode(descriptor) {
  if (hasCapability(descriptor, "hooks")) return REPORTING_MODES.HOOK;
  if (hasCapability(descriptor, "explicitCli")) return REPORTING_MODES.EXPLICIT_CLI;
  throw new Error("Claude adapter has no safe reporting capability");
}

function hookEventType(hookName) {
  return CLAUDE_HOOK_EVENT_MAP[hookName] || null;
}

function buildExplicitReport(eventType, input) {
  if (!REPORTABLE_EVENT_TYPES.has(eventType)) {
    throw new TypeError(`unsupported report event: ${eventType}`);
  }
  if (!input || !input.event || input.event.eventType !== eventType) {
    throw new TypeError("explicit CLI fallback requires a matching full event envelope");
  }
  const args = [
    "task",
    explicitSubcommand(eventType),
    "--event-json",
    JSON.stringify(input.event),
    "--format",
    "json",
  ];
  if (input.authContext) {
    const auth = normalizeAuthContext(input.authContext, input.event.producer);
    args.push("--auth-context-json", JSON.stringify(auth));
  }
  return Object.freeze({
    executable: "cortex-agent",
    args: Object.freeze(args),
    eventType,
  });
}

function normalizeAuthContext(input, producer) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("authContext must be an object");
  }
  const allowed = new Set(["actorId", "kind", "sessionId", "workflowGate"]);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new TypeError("authContext contains unsupported fields");
  }
  const auth = {
    actorId: assertSafeId(input.actorId, "authContext.actorId"),
    kind: assertSafeId(input.kind, "authContext.kind"),
    sessionId: assertSafeId(input.sessionId, "authContext.sessionId"),
  };
  if (!producer || producer.actorId !== auth.actorId || producer.kind !== auth.kind
      || (producer.sessionId && producer.sessionId !== auth.sessionId)) {
    throw new TypeError("authContext must match event producer");
  }
  if (input.workflowGate !== undefined) {
    auth.workflowGate = assertSafeId(
      input.workflowGate,
      "authContext.workflowGate",
    );
  }
  return Object.freeze(auth);
}

function explicitSubcommand(eventType) {
  const subcommands = {
    "task.accepted": "accept",
    "task.progress": "progress",
    "task.heartbeat": "heartbeat",
    "task.testing": "test",
    "task.input_required": "request-input",
    "task.blocked": "block",
    "task.failed": "fail",
    "artifact.ready": "ready",
    "task.ready_for_review": "ready",
  };
  return subcommands[eventType];
}

function recordExitBoundary(descriptor, input) {
  if (!hasCapability(descriptor, "processBoundaryEvidence")) {
    return null;
  }
  if (!Number.isSafeInteger(input.exitCode)) {
    throw new TypeError("exitCode must be an integer");
  }
  return Object.freeze({
    taskId: assertSafeId(input.taskId, "taskId"),
    sessionId: assertSafeId(input.sessionId, "sessionId"),
    exitCode: input.exitCode,
    cleanExit: input.exitCode === 0,
    terminalStateReported: input.terminalStateReported === true,
    evidenceRefs: sanitizeEvidenceRefs(input.evidenceRefs),
  });
}

function createClaudeAdapter(host = {}) {
  const descriptor = detectClaudeCapabilities(host);
  return Object.freeze({
    descriptor,
    reportingMode: reportingMode(descriptor),
    createLaunchContext,
    hookEventType,
    buildReport(eventType, input) {
      const hookName = findHookName(eventType);
      return Object.freeze({
        mode: hookName && hasCapability(descriptor, "hooks")
          ? REPORTING_MODES.HOOK
          : REPORTING_MODES.EXPLICIT_CLI,
        hookName,
        fallback: buildExplicitReport(eventType, input),
      });
    },
    recordExitBoundary(input) {
      return recordExitBoundary(descriptor, input);
    },
  });
}

function findHookName(eventType) {
  return Object.keys(CLAUDE_HOOK_EVENT_MAP)
    .find((name) => CLAUDE_HOOK_EVENT_MAP[name] === eventType) || null;
}

module.exports = {
  CLAUDE_HOOK_EVENT_MAP,
  REPORTABLE_EVENT_TYPES,
  buildExplicitReport,
  createClaudeAdapter,
  createLaunchContext,
  detectClaudeCapabilities,
  hookEventType,
  recordExitBoundary,
  reportingMode,
};
