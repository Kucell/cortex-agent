"use strict";

const fs = require("fs");
const path = require("path");

// MS-003: resolved via lib/runtime-layout (VC-011)
const { resolveRuntimePaths } = require("../runtime-layout");
const { ConsumerCursorStore } = require("./consumer-cursor");
const { deliverCodexWakeup } = require("./codex-app-server-client");
const { createCodexAdapter } = require("./codex-adapter");
const { Journal } = require("./journal");
const { NotificationPump } = require("./notification-pump");
const { NotificationRuntime } = require("./notification-runtime");
const {
  InstanceLock,
  NotificationSupervisor,
  StatusStore,
} = require("./notification-supervisor");

// MS-003: Get coordination directory using shared runtime-layout API (VC-011)
// Uses new-first/legacy-fallback per VC-012 compatibility window
function ensureRuntimeRoot(projectRoot) {
  const paths = resolveRuntimePaths(projectRoot);
  // During compat window: prefer legacy if exists, else new
  // After activation: always use new
  let coordinationDir;
  if (paths.legacyExists && !paths.activated) {
    coordinationDir = paths.coordination.legacy;
  } else {
    coordinationDir = paths.coordination.new;
  }
  const journal = path.join(coordinationDir, "journal");
  const consumers = path.join(coordinationDir, "consumers");
  const notification = path.join(coordinationDir, "notification");
  fs.mkdirSync(journal, { recursive: true });
  fs.mkdirSync(consumers, { recursive: true });
  fs.mkdirSync(notification, { recursive: true });
  return coordinationDir;
}

function createJournalReader(journalDir) {
  return {
    readAll() {
      const journal = Journal.open(journalDir, { lock: false });
      try {
        return journal.readAll();
      } finally {
        journal.close();
      }
    },
  };
}

function deferredAdapter(adapterId) {
  return Object.freeze({
    descriptor: Object.freeze({ adapterId, hostAvailable: false }),
    async deliver({ event }) {
      return Object.freeze({
        status: "deferred",
        acknowledged: false,
        eventId: event && event.eventId ? event.eventId : null,
        reason: "adapter_not_available",
        errorCode: "ERR_NOTIFICATION_ADAPTER_UNAVAILABLE",
      });
    },
  });
}

function resolveAdapter(adapterId, options = {}) {
  if (adapterId === "codex") {
    const threadId = options.threadId
      || (options.useEnvironment === false
        ? null
        : (process.env.CORTEX_CODEX_THREAD_ID || process.env.CODEX_THREAD_ID));
    if (!threadId) {
      const error = new Error("Codex thread ID is not configured.");
      error.code = "ERR_CODEX_THREAD_ID_REQUIRED";
      throw error;
    }
    return createCodexAdapter({
      threadWakeup: true,
      structuredContext: true,
      recoveryConsumer: true,
      deliver: (request) => deliverCodexWakeup(request, {
        threadId,
        command: options.codexCommand,
        spawn: options.spawn,
        timeoutMs: options.timeoutMs,
      }),
    });
  }
  if (adapterId === "noop") return deferredAdapter("noop");
  if (adapterId === "claude-code") return deferredAdapter("claude-code");
  if (adapterId === "webhook") return deferredAdapter("webhook");
  const error = new Error("adapter is not registered");
  error.code = "ERR_NOTIFICATION_ADAPTER";
  throw error;
}

function createNotificationHarness(projectRoot, dependencies = {}) {
  return {
    async resolvePump({ action, options }) {
      const coordinationRoot = ensureRuntimeRoot(projectRoot);
      const journalDir = path.join(coordinationRoot, "journal");
      const consumerDir = path.join(coordinationRoot, "consumers");
      const runtimeDir = path.join(coordinationRoot, "notification");
      const cursor = new ConsumerCursorStore(consumerDir, options.consumer);
      const statusStore = new StatusStore(runtimeDir, options.consumer);
      const lock = new InstanceLock(runtimeDir, options.consumer);
      const cursorStatus = () => {
        const state = cursor.read();
        const instance = lock.inspect();
        const pending = Object.values(state.pending);
        const degradedReasons = [...new Set(pending
          .map((entry) => entry.lastError || (entry.exhausted ? "DELIVERY_EXHAUSTED" : null))
          .filter(Boolean))];
        return {
          ...statusStore.read(),
          instanceActive: Boolean(instance.held && instance.alive),
          cursor: {
            revision: state.revision,
            highWater: state.highWater,
            pending: Object.keys(state.pending).length,
            acknowledged: Object.keys(state.acknowledged).length,
            exhausted: pending.filter((entry) => entry.exhausted).length,
          },
          health: pending.length > 0 ? "degraded" : "healthy",
          degradedReasons,
          adapter: options.adapter,
          target: {
            kind: options.target.kind,
            actorId: options.target.actorId,
          },
        };
      };

      if (action === "status") {
        return { pump: {}, getStatus: cursorStatus };
      }
      if (action === "stop") {
        return {
          pump: {},
          async stop() {
            const instance = lock.inspect();
            if (!instance.held || !instance.alive) return;
            process.kill(instance.lock.pid, "SIGTERM");
          },
        };
      }

      const pump = new NotificationPump({
        journal: createJournalReader(journalDir),
        cursor,
        adapter: resolveAdapter(options.adapter, dependencies),
        target: options.target,
        retry: options.maxAttempts ? { maxAttempts: options.maxAttempts } : undefined,
      });
      if (action === "once") return { pump };

      const runtime = new NotificationRuntime({
        pump,
        consumerId: options.consumer,
        journalDir,
        minIntervalMs: options.intervalMs || 1000,
        maxIntervalMs: Math.max(options.intervalMs || 1000, 15000),
        statusStore,
      });
      const supervisor = new NotificationSupervisor({
        runtime,
        consumerId: options.consumer,
        runtimeDir,
        statusStore,
        lock,
      });
      return {
        pump: {
          runOnce: () => runtime.runOnce(),
          watch: () => supervisor.start(),
        },
        stop: () => supervisor.stop(),
        getStatus: () => supervisor.status(),
      };
    },
  };
}

module.exports = {
  createJournalReader,
  createNotificationHarness,
  deferredAdapter,
  ensureRuntimeRoot,
  resolveAdapter,
};
