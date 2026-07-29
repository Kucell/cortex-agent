"use strict";

const fs = require("fs");
const path = require("path");

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

function ensureRuntimeRoot(projectRoot) {
  const root = path.join(path.resolve(projectRoot), ".agent-runtime");
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "*\n!.gitignore\n", { encoding: "utf8", mode: 0o600 });
  }
  const coordination = path.join(root, "coordination");
  fs.mkdirSync(path.join(coordination, "journal"), { recursive: true });
  fs.mkdirSync(path.join(coordination, "consumers"), { recursive: true });
  fs.mkdirSync(path.join(coordination, "notification"), { recursive: true });
  return coordination;
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
    if (!threadId) return createCodexAdapter();
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
        return {
          ...statusStore.read(),
          instanceActive: Boolean(instance.held && instance.alive),
          cursor: {
            revision: state.revision,
            highWater: state.highWater,
            pending: Object.keys(state.pending).length,
            acknowledged: Object.keys(state.acknowledged).length,
          },
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
